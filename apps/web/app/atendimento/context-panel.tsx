'use client';

import Link from 'next/link';
import { formatDateTime } from '../lib/date-time';
import type { ConversationDetail, ConvocationRef } from '../lib/inbox-api';
import { conversationStatusLabel, priorityLabel } from '../lib/inbox-labels';
import { stageLabel, statusLabel } from '../lib/labels';
import type { UiPermissions } from './inbox-logic.mjs';
import styles from './atendimento.module.css';

export function ContextPanel({
  detail,
  permissions,
  onLink,
  onUnlink,
  onOptOut,
  onAutomation,
}: {
  detail: ConversationDetail;
  permissions: UiPermissions;
  onLink: (convocation: ConvocationRef) => void;
  onUnlink: (convocation: ConvocationRef) => void;
  onOptOut: (optedOut: boolean) => void;
  onAutomation: () => void;
}) {
  return (
    <div className={styles.context}>
      <section className={styles.section} aria-labelledby="ctx-contact">
        <h3 id="ctx-contact">Contato</h3>
        <dl className={styles.facts}>
          <dt>WhatsApp</dt>
          <dd>{detail.contact.waIdMasked}</dd>
          <dt>Perfil</dt>
          <dd>
            {detail.contact.profileName ?? '—'}
            <br />
            <small className="muted">Nome do perfil não comprova identidade.</small>
          </dd>
          <dt>Mensagens</dt>
          <dd>
            {detail.contact.optedOut ? (
              <span className={styles.chip} data-tone="danger">
                Não quer receber
              </span>
            ) : (
              <span className={styles.chip} data-tone="success">
                Aceita mensagens
              </span>
            )}
          </dd>
        </dl>
        {permissions.optOut ? (
          <button
            type="button"
            className={`button small ${detail.contact.optedOut ? 'secondary' : 'danger ghost'}`}
            onClick={() => onOptOut(!detail.contact.optedOut)}
          >
            {detail.contact.optedOut ? 'Remover opt-out' : 'Registrar opt-out'}
          </button>
        ) : null}
      </section>

      <section className={styles.section} aria-labelledby="ctx-conv">
        <h3 id="ctx-conv">Atendimento</h3>
        <dl className={styles.facts}>
          <dt>Protocolo</dt>
          <dd>{detail.protocol}</dd>
          <dt>Estado</dt>
          <dd>
            {conversationStatusLabel(detail.status)}
            {detail.status === 'SNOOZED' && detail.snoozedUntil
              ? ` até ${formatDateTime(detail.snoozedUntil)}`
              : ''}
          </dd>
          <dt>Prioridade</dt>
          <dd>{priorityLabel(detail.priority)}</dd>
          <dt>Equipe</dt>
          <dd>{detail.team?.name ?? '—'}</dd>
          <dt>Responsável</dt>
          <dd>{detail.assignee?.name ?? 'Sem responsável'}</dd>
          <dt>Janela</dt>
          <dd>
            {detail.replyPolicy.windowExpiresAt
              ? `até ${formatDateTime(detail.replyPolicy.windowExpiresAt)}`
              : 'nunca aberta'}
          </dd>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="ctx-links">
        <h3 id="ctx-links">Convocações vinculadas</h3>
        {detail.contexts.length === 0 ? (
          <p className="muted">Nenhuma convocação vinculada.</p>
        ) : (
          detail.contexts.map((context) => (
            <article className={styles.card} key={context.convocationId}>
              <ConvocationFacts convocation={context} />
              <span className="muted">
                {context.source === 'TEMPLATE_REPLY'
                  ? 'Vinculada pela resposta ao template'
                  : 'Vinculada manualmente'}
              </span>
              <span className={styles.actions}>
                <Link className="subtle-link" href={`/convocacoes/${context.convocationId}`}>
                  Abrir convocação
                </Link>
                {permissions.linkContext ? (
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => onUnlink(context)}
                  >
                    Desvincular
                  </button>
                ) : null}
              </span>
            </article>
          ))
        )}
      </section>

      {detail.candidates.length > 0 ? (
        <section className={styles.section} aria-labelledby="ctx-candidates">
          <h3 id="ctx-candidates">Possíveis convocações</h3>
          {detail.ambiguous ? (
            <p className={styles.warn} role="note">
              Há mais de uma convocação ativa para este telefone. Confirme a identidade antes de
              vincular.
            </p>
          ) : null}
          {detail.candidates.map((candidate) => (
            <article className={`${styles.card} ${styles.unlinked}`} key={candidate.convocationId}>
              <span className={styles.chip} data-tone="warning">
                Não vinculado — confirme a identidade
              </span>
              <ConvocationFacts convocation={candidate} />
              {permissions.linkContext ? (
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => onLink(candidate)}
                >
                  Vincular…
                </button>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby="ctx-automation">
        <h3 id="ctx-automation">Automação de convocações</h3>
        <p className="muted">
          {detail.automationPaused
            ? 'Pausada por atendimento humano. Resolver a conversa não retoma os envios.'
            : 'Sem pausa ativa.'}
        </p>
        {detail.automationPaused && permissions.resumeAutomation ? (
          <button type="button" className="button secondary small" onClick={onAutomation}>
            Prévia e retomada…
          </button>
        ) : null}
      </section>
    </div>
  );
}

function ConvocationFacts({ convocation }: { convocation: ConvocationRef }) {
  return (
    <dl className={styles.facts}>
      <dt>Paciente</dt>
      <dd>{convocation.patient.displayName}</dd>
      <dt>Campanha</dt>
      <dd>{convocation.campaign.name}</dd>
      <dt>Etapa</dt>
      <dd>{stageLabel(convocation.stage)}</dd>
      <dt>Situação</dt>
      <dd>{statusLabel(convocation.status)}</dd>
      {convocation.nextActionAt ? (
        <>
          <dt>Próximo envio</dt>
          <dd>{formatDateTime(convocation.nextActionAt)}</dd>
        </>
      ) : null}
      {convocation.humanHoldAt ? (
        <>
          <dt>Automação</dt>
          <dd>Pausada desde {formatDateTime(convocation.humanHoldAt)}</dd>
        </>
      ) : null}
    </dl>
  );
}
