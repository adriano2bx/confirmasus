import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';

const base = (process.env.TEST_API_BASE_URL ?? 'http://127.0.0.1:3001/api').replace(/\/$/, '');
const target = new URL(base);
if (!['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) {
  throw new Error('O teste e2e só pode atingir uma API local.');
}
if (process.env.TEST_E2E_CONFIRM !== 'LOCAL_DISPOSABLE_DB_AND_DRY_RUN') {
  throw new Error(
    'Use um banco local descartável e um worker em DRY_RUN; então defina TEST_E2E_CONFIRM=LOCAL_DISPOSABLE_DB_AND_DRY_RUN.',
  );
}
const email = required('TEST_ADMIN_EMAIL');
const password = required('TEST_ADMIN_PASSWORD');
const appSecret = required('TEST_META_APP_SECRET');
let accessToken;
let csrf;
let campaignId;

async function request(path, { method = 'GET', body, multipart = false, headers = {} } = {}) {
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (
    csrf &&
    ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) &&
    !path.endsWith('/auth/login') &&
    path !== '/webhooks/meta'
  ) {
    headers.cookie = `confirma_csrf_token=${csrf}`;
    headers['x-csrf-token'] = csrf;
  }
  let payload = body;
  if (multipart) {
    const form = new FormData();
    form.append(
      'file',
      new Blob([await syntheticWorkbook()], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      'agenda-sintetica.xlsx',
    );
    payload = form;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => null);
  assert(response.ok, `${method} ${path}: HTTP ${response.status} ${JSON.stringify(data)}`);
  return data;
}

try {
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(15_000),
  });
  const loginBody = await login.json().catch(() => null);
  assert.equal(login.status, 201, JSON.stringify(loginBody));
  const cookies = login.headers.getSetCookie();
  accessToken = cookies
    .map((value) => value.match(/confirma_access_token=([^;]+)/)?.[1])
    .find(Boolean);
  csrf = cookies.map((value) => value.match(/confirma_csrf_token=([^;]+)/)?.[1]).find(Boolean);
  assert(accessToken && csrf, 'Login precisa fornecer os cookies de sessão e CSRF.');

  const imported = await request('/imports', { method: 'POST', multipart: true });
  const reviewDeadline = Date.now() + 30_000;
  let review;
  do {
    await wait(500);
    review = await request(`/imports/${imported.id}/review`);
  } while (['UPLOADED', 'PROCESSING'].includes(review.status) && Date.now() < reviewDeadline);
  assert.equal(review.status, 'READY_FOR_REVIEW', JSON.stringify(review));
  assert.equal(review.counts.identifiedPatients, 3);
  assert.equal(review.counts.eligiblePatients, 3);
  const grouped = review.patientGroups.find((patient) => patient.selectedPhone === '5565999999999');
  assert(grouped, 'O telefone WhatsApp deve ser normalizado.');
  assert.equal(
    grouped.recordCount,
    3,
    'CPFs divergentes não devem separar solicitações pelo mesmo WhatsApp.',
  );
  assert.deepEqual(
    grouped.phones.map((phone) => phone.normalized),
    ['5565999999999'],
    'Números secundários da planilha devem ser descartados na revisão.',
  );
  assert.deepEqual(grouped.procedures.sort(), ['Cardiologia', 'Oftalmologia', 'Ultrassom'].sort());

  await request(`/imports/${imported.id}/approve`, { method: 'POST', body: {} });
  const campaign = await request(`/campaigns/from-import/${imported.id}`, {
    method: 'POST',
    body: {
      name: `E2E sintético ${new Date().toISOString()}`,
      firstActionAt: new Date(Date.now() + 2_500).toISOString(),
      secondIntervalDays: 1,
      secondStartTime: '09:00',
      thirdIntervalDays: 1,
      thirdStartTime: '09:00',
      finalResponseWindowDays: 1,
    },
  });
  campaignId = campaign.id;
  assert.equal(
    campaign.patientCount,
    3,
    'A campanha deve criar uma convocação por WhatsApp distinto, mesmo com CPF repetido.',
  );
  await request(`/campaigns/${campaignId}/schedule`, { method: 'POST' });

  const sendDeadline = Date.now() + 30_000;
  let detail;
  do {
    await wait(500);
    detail = await request(`/campaigns/${campaignId}`);
  } while (Number(detail.messageByStatus?.SUBMITTED ?? 0) < 3 && Date.now() < sendDeadline);
  assert.equal(Number(detail.messageByStatus?.SUBMITTED ?? 0), 3);

  const convocations = await request(`/convocations?campaignId=${campaignId}`);
  const targetConvocation = convocations.items.find(
    (item) => item.selectedPhone?.normalizedValue === '5565999999999',
  );
  assert.equal(
    targetConvocation?.patient.phones.length,
    1,
    'O cadastro do paciente deve persistir somente o WhatsApp escolhido.',
  );
  const sentMessageId = targetConvocation?.messages?.[0]?.providerMessageId;
  assert(sentMessageId, 'A mensagem simulada deve persistir o identificador do provedor.');
  const webhookBody = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              messages: [
                {
                  id: `wamid.e2e.${randomUUID()}`,
                  from: '5565999999999',
                  timestamp: String(Math.floor(Date.now() / 1_000)),
                  type: 'button',
                  context: { id: sentMessageId },
                  button: { text: 'Confirmar', payload: 'CONFIRM' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const rawBody = JSON.stringify(webhookBody);
  const signature = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  await request('/webhooks/meta', {
    method: 'POST',
    body: webhookBody,
    headers: { 'x-hub-signature-256': signature },
  });

  const confirmationDeadline = Date.now() + 15_000;
  let confirmed;
  do {
    await wait(250);
    confirmed = await request(`/convocations/${targetConvocation.id}`);
  } while (confirmed.status !== 'CONFIRMED' && Date.now() < confirmationDeadline);
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(confirmed.responses?.[0]?.action, 'CONFIRM');
  console.log(
    JSON.stringify({
      result: 'PASS',
      importId: imported.id,
      campaignId,
      groupedRequests: grouped.recordCount,
      distinctWhatsAppNumbers: review.counts.identifiedPatients,
      simulatedMessages: detail.messageByStatus.SUBMITTED,
      webhookConfirmation: confirmed.status,
    }),
  );
} finally {
  if (campaignId)
    await request(`/campaigns/${campaignId}/cancel`, { method: 'POST' }).catch(() => undefined);
  if (accessToken && csrf) {
    await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        cookie: `confirma_csrf_token=${csrf}`,
        'x-csrf-token': csrf,
      },
    }).catch(() => undefined);
  }
}

async function syntheticWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Agenda sintética');
  sheet.addRow([
    'ID',
    'Paciente',
    'Item',
    'Data agendamento',
    'CPF',
    'WhatsApp',
    'Telefone secundário',
  ]);
  const appointment = new Date(Date.now() + 86_400_000);
  sheet.addRow([
    'A-1',
    'Paciente Sintético',
    'Cardiologia',
    appointment,
    '',
    '(65) 99999-9999',
    '(65) 98888-7777',
  ]);
  sheet.addRow([
    'A-2',
    'Paciente Sintetico',
    'Ultrassom',
    appointment,
    '12345678901',
    '+55 (65) 99999-9999',
  ]);
  sheet.addRow(['A-3', 'Paciente Sintético', 'Oftalmologia', appointment, '', '5565999999999']);
  sheet.addRow(['B-1', 'Outra Pessoa', 'Dermatologia', appointment, '', '(65) 98888-8888']);
  sheet.addRow([
    'C-1',
    'Paciente Sintético',
    'Retorno',
    appointment,
    '12345678901',
    '(65) 97777-7777',
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} é obrigatório.`);
  return value;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
