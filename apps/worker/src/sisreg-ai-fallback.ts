import type { ParsedSisregRow, SisregParseResult } from './sisreg-parser.js';

type AiRow = Partial<Omit<ParsedSisregRow, 'rowNumber' | 'rawText' | 'issues'>> & {
  rowNumber: number;
};

interface AiResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export interface SisregAiFallbackConfig {
  enabled?: boolean;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  fetcher?: typeof fetch;
}

const REQUIRED_ISSUES = new Set([
  'Nome não identificado com segurança.',
  'Telefone ausente.',
  'Data/hora ausente.',
  'Procedimento ausente.',
]);

export async function applySisregAiFallback(
  parsed: SisregParseResult,
  config: SisregAiFallbackConfig = {},
): Promise<SisregParseResult> {
  const enabled = config.enabled ?? process.env.SISREG_AI_FALLBACK_ENABLED === 'true';
  const endpoint = config.endpoint ?? process.env.SISREG_AI_ENDPOINT;
  const apiKey = config.apiKey ?? process.env.SISREG_AI_API_KEY;
  if (!enabled || !endpoint || !apiKey) return parsed;

  const candidates = parsed.rows.filter((row) =>
    row.issues.some((issue) => REQUIRED_ISSUES.has(issue)),
  );
  if (candidates.length === 0) return parsed;

  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: config.model ?? process.env.SISREG_AI_MODEL ?? 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Extraia registros SISREG. Responda somente JSON no formato {"rows":[...]}. Não invente valores. Use null quando ausente. rowNumber deve ser preservado.',
        },
        {
          role: 'user',
          content: JSON.stringify(
            candidates.map(({ rowNumber, rawText }) => ({
              rowNumber,
              rawText: rawText.slice(0, 6000),
            })),
          ),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Fallback de IA indisponível (HTTP ${response.status})`);

  const envelope = (await response.json()) as AiResponse;
  const content = envelope.choices?.[0]?.message?.content;
  if (!content) throw new Error('Fallback de IA retornou resposta vazia');
  const decoded = JSON.parse(content) as { rows?: unknown };
  if (!Array.isArray(decoded.rows)) throw new Error('Fallback de IA retornou formato inválido');

  const byNumber = new Map<number, AiRow>();
  for (const value of decoded.rows) {
    const row = validateAiRow(value);
    if (row) byNumber.set(row.rowNumber, row);
  }

  const rows = parsed.rows.map((row) => {
    const recovered = byNumber.get(row.rowNumber);
    if (!recovered) return row;
    const merged = {
      ...row,
      ...Object.fromEntries(
        Object.entries(recovered).filter(([key, value]) => key !== 'rowNumber' && value != null),
      ),
    } as ParsedSisregRow;
    merged.issues = merged.issues.filter((issue) => !isFixedByAi(issue, merged));
    merged.issues = [...new Set([...merged.issues, 'AI_FALLBACK_REVIEW'])];
    return merged;
  });
  return {
    ...parsed,
    rows,
    warnings: [...parsed.warnings, 'Fallback de IA aplicado aos registros com baixa confiança.'],
  };
}

function validateAiRow(value: unknown): AiRow | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const rowNumber = candidate.rowNumber;
  if (typeof rowNumber !== 'number' || !Number.isInteger(rowNumber) || rowNumber < 1) return null;
  const result: AiRow = { rowNumber };
  for (const key of ['nome', 'dataNascimento', 'cpf', 'cns', 'dataHora'] as const) {
    if (typeof candidate[key] === 'string' && candidate[key].trim())
      result[key] = candidate[key].trim();
  }
  if (Array.isArray(candidate.telefones))
    result.telefones = candidate.telefones.filter(
      (item): item is string => typeof item === 'string',
    );
  if (Array.isArray(candidate.procedimentos))
    result.procedimentos = candidate.procedimentos.filter(
      (item): item is string => typeof item === 'string',
    );
  return result;
}

function isFixedByAi(issue: string, row: ParsedSisregRow): boolean {
  return (
    (issue === 'Nome não identificado com segurança.' && Boolean(row.nome)) ||
    (issue === 'Data de nascimento ausente.' && Boolean(row.dataNascimento)) ||
    (issue === 'Telefone ausente.' && row.telefones.length > 0) ||
    (issue === 'Data/hora ausente.' && Boolean(row.dataHora)) ||
    (issue === 'Procedimento ausente.' && row.procedimentos.length > 0)
  );
}
