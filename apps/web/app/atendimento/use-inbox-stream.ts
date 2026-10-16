'use client';

import { useEffect, useRef, useState } from 'react';
import { API } from '../lib/inbox-api';
import { parseInboxEvent, streamUrl, type InboxStreamEvent } from './inbox-logic.mjs';

const EVENT_TYPES = [
  'conversation.created',
  'conversation.updated',
  'message.created',
  'message.updated',
  'note.created',
  'activity.created',
];
const POLL_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

export type StreamStatus = 'connecting' | 'live' | 'polling';

/**
 * Tempo real do inbox via SSE (só tipo/IDs). Reconexão automática do EventSource envia
 * Last-Event-ID; se a conexão fechar de vez, reconecta manualmente com ?cursor=<último id>
 * e, enquanto isso, faz polling lento (30 s). Após cada reconexão pede um refetch HTTP.
 */
export function useInboxStream({
  onEvent,
  onResync,
}: {
  onEvent: (event: InboxStreamEvent) => void;
  onResync: () => void;
}): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const handlers = useRef({ onEvent, onResync });
  handlers.current = { onEvent, onResync };

  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      setStatus('polling');
      const poll = window.setInterval(() => handlers.current.onResync(), POLL_MS);
      return () => window.clearInterval(poll);
    }
    let source: EventSource | null = null;
    let lastEventId: string | null = null;
    let disposed = false;
    let everOpened = false;
    let reconnectTimer: number | undefined;
    let pollTimer: number | undefined;
    let backoff = 2_000;

    const startPolling = () => {
      setStatus('polling');
      if (pollTimer === undefined) {
        pollTimer = window.setInterval(() => handlers.current.onResync(), POLL_MS);
      }
    };
    const stopPolling = () => {
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      pollTimer = undefined;
    };

    const handle = (message: MessageEvent<string>) => {
      const event = parseInboxEvent(message.data, message.lastEventId);
      if (!event) return;
      if (event.id) lastEventId = event.id;
      handlers.current.onEvent(event);
    };

    const connect = () => {
      if (disposed) return;
      source = new EventSource(streamUrl(API, lastEventId), { withCredentials: true });
      source.onopen = () => {
        backoff = 2_000;
        stopPolling();
        setStatus('live');
        // Eventos perdidos durante a queda são recuperados pelo cursor; o refetch cobre o resto.
        if (everOpened) handlers.current.onResync();
        everOpened = true;
      };
      source.onmessage = handle;
      for (const type of EVENT_TYPES) source.addEventListener(type, handle as EventListener);
      source.onerror = () => {
        // Sem stream confiável: polling lento até a próxima abertura.
        startPolling();
        // CONNECTING = o navegador reconecta sozinho (com Last-Event-ID).
        if (!source || source.readyState !== EventSource.CLOSED) return;
        source.close();
        source = null;
        reconnectTimer = window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      };
    };

    connect();
    return () => {
      disposed = true;
      source?.close();
      stopPolling();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    };
  }, []);

  return status;
}
