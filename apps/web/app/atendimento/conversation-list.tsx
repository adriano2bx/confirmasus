'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Icon } from '../components/ui';
import { formatDateTime } from '../lib/date-time';
import type { ConversationSummary, InboxMe } from '../lib/inbox-api';
import {
  INBOX_VIEWS,
  PRIORITY_OPTIONS,
  conversationStatusLabel,
  priorityLabel,
} from '../lib/inbox-labels';
import { isSearchInvalid, type InboxView } from './inbox-logic.mjs';
import type { StreamStatus } from './use-inbox-stream';
import styles from './atendimento.module.css';

export interface ListFilters {
  view: InboxView;
  q: string;
  teamId: string;
  priority: string;
}

const STATUS_TONE: Record<string, string> = {
  OPEN: 'info',
  WAITING_CONTACT: 'warning',
  SNOOZED: 'neutral',
  RESOLVED: 'success',
};

export function ConversationList({
  me,
  filters,
  onFilters,
  items,
  loading,
  hasMore,
  onLoadMore,
  selectedId,
  onSelect,
  streamStatus,
}: {
  me: InboxMe | null;
  filters: ListFilters;
  onFilters: (filters: ListFilters) => void;
  items: ConversationSummary[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  streamStatus: StreamStatus;
}) {
  const [search, setSearch] = useState(filters.q);
  const [searchError, setSearchError] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const index = items.findIndex((item) => item.id === selectedId);
    if (index >= 0) setActive(index);
    else if (active >= items.length) setActive(Math.max(items.length - 1, 0));
  }, [items, selectedId]);

  useEffect(() => {
    const id = items[active]?.id;
    if (!id) return;
    document.getElementById(`conv-opt-${id}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, items]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    // A API recusa (400) busca que não seja protocolo ATD-… ou ao menos 4 dígitos.
    if (isSearchInvalid(search)) {
      setSearchError('Busque pelo protocolo (ATD-…) ou por ao menos 4 dígitos do WhatsApp.');
      return;
    }
    setSearchError('');
    onFilters({ ...filters, q: search });
  }

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (items.length === 0) return;
    const move = (index: number) => {
      event.preventDefault();
      setActive(Math.min(Math.max(index, 0), items.length - 1));
    };
    if (event.key === 'ArrowDown') move(active + 1);
    else if (event.key === 'ArrowUp') move(active - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const item = items[active];
      if (item) onSelect(item.id);
    }
  }

  const statusText =
    streamStatus === 'live'
      ? 'Tempo real ativo'
      : streamStatus === 'polling'
        ? 'Atualização a cada 30 s'
        : 'Conectando…';

  return (
    <>
      <header className={styles.paneHeader}>
        <h2 className={styles.grow} id="inbox-list-title">
          Conversas
        </h2>
        <span className={styles.liveDot} data-status={streamStatus} title={statusText}>
          <i aria-hidden="true" />
          {statusText}
        </span>
      </header>
      <div className={styles.views} role="group" aria-label="Filas">
        {INBOX_VIEWS.map((view) => (
          <button
            key={view.value}
            type="button"
            aria-pressed={filters.view === view.value}
            onClick={() => onFilters({ ...filters, view: view.value })}
          >
            {view.label}
          </button>
        ))}
      </div>
      <form className={styles.search} role="search" onSubmit={submitSearch}>
        <label className="sr-only" htmlFor="inbox-search">
          Buscar por protocolo ou WhatsApp
        </label>
        <input
          id="inbox-search"
          type="search"
          value={search}
          placeholder="Protocolo ou WhatsApp"
          onChange={(event) => setSearch(event.target.value)}
          autoComplete="off"
          maxLength={40}
          aria-invalid={Boolean(searchError)}
          aria-describedby={searchError ? 'inbox-search-error' : undefined}
        />
        <button className="icon-button" type="submit" aria-label="Buscar" title="Buscar">
          <Icon name="search" />
        </button>
      </form>
      {searchError ? (
        <p id="inbox-search-error" className={styles.searchError} role="alert">
          {searchError}
        </p>
      ) : null}
      {(me?.teams.length ?? 0) > 1 || me?.globalRole === 'ADMIN' ? (
        <div className={styles.search}>
          <label className="sr-only" htmlFor="inbox-team">
            Equipe
          </label>
          <select
            id="inbox-team"
            value={filters.teamId}
            onChange={(event) => onFilters({ ...filters, teamId: event.target.value })}
          >
            <option value="">Todas as minhas equipes</option>
            {me?.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="inbox-priority">
            Prioridade
          </label>
          <select
            id="inbox-priority"
            value={filters.priority}
            onChange={(event) => onFilters({ ...filters, priority: event.target.value })}
          >
            <option value="">Qualquer prioridade</option>
            {PRIORITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <ul
        ref={listRef}
        className={styles.list}
        role="listbox"
        tabIndex={0}
        aria-labelledby="inbox-list-title"
        aria-busy={loading}
        aria-activedescendant={items[active] ? `conv-opt-${items[active].id}` : undefined}
        onKeyDown={onKeyDown}
      >
        {items.map((item, index) => (
          <li
            key={item.id}
            id={`conv-opt-${item.id}`}
            role="option"
            aria-selected={item.id === selectedId}
            data-active={index === active}
            className={styles.item}
            onClick={() => {
              setActive(index);
              onSelect(item.id);
            }}
          >
            <span className={styles.itemTop}>
              <strong>{item.protocol}</strong>
              <span className={styles.chip} data-tone={STATUS_TONE[item.status] ?? 'info'}>
                {conversationStatusLabel(item.status)}
              </span>
            </span>
            <span className={styles.itemBottom}>
              <span>
                {item.contact.waIdMasked}
                {item.priority > 0 ? ` · ${priorityLabel(item.priority)}` : ''}
                {item.assignee ? ` · ${item.assignee.name}` : ' · Sem responsável'}
              </span>
              {item.unreadCount > 0 ? (
                <span className={styles.unread} aria-label={`${item.unreadCount} não lidas`}>
                  {item.unreadCount}
                </span>
              ) : null}
            </span>
            <span className={styles.itemBottom}>
              <span>{formatDateTime(item.lastActivityAt)}</span>
              {item.replyPolicy.allowed ? (
                <span className={styles.chip} data-tone="success">
                  Janela aberta
                </span>
              ) : null}
            </span>
          </li>
        ))}
        {!loading && items.length === 0 ? (
          <li className={styles.empty} role="presentation">
            Nenhuma conversa nesta fila.
          </li>
        ) : null}
      </ul>
      {hasMore || loading ? (
        <div className={styles.listFooter}>
          <button
            type="button"
            className="button secondary small"
            onClick={onLoadMore}
            disabled={loading}
          >
            {loading ? 'Carregando…' : 'Carregar mais'}
          </button>
        </div>
      ) : null}
    </>
  );
}
