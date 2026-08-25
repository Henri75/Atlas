import { loadingBus } from './loadingBus';

/**
 * The mobile transport: typed fetch against a configured base URL, with the
 * bearer token attached when one is stored, every call labelled for the usage
 * monitor, and 401s surfaced so the shell can raise the token gate.
 *
 * Mirrors packages/ui/src/api.ts — same routes, same semantics — but reads
 * its endpoint and token from the server store (a phone cannot assume
 * same-origin localhost) and reports itself as client "mobile".
 */

export type UnauthorizedListener = () => void;

let getBaseUrl: () => string = () => '';
let getToken: () => string | null = () => null;
const unauthorizedListeners = new Set<UnauthorizedListener>();

export function configureTransport(opts: {
  getBaseUrl: () => string;
  getToken: () => string | null;
}) {
  getBaseUrl = opts.getBaseUrl;
  getToken = opts.getToken;
}

/** Fired on any 401: this instance is LAN-exposed and the token is bad. */
export function onUnauthorized(l: UnauthorizedListener): () => void {
  unauthorizedListeners.add(l);
  return () => unauthorizedListeners.delete(l);
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function flagIfUnauthorized(status: number): void {
  if (status === 401) flagUnauthorized();
}

/** Raise the token gate everywhere at once (used by the plain and SSE paths). */
export function flagUnauthorized(): void {
  for (const l of unauthorizedListeners) l();
}

/** A fetch/HTTP failure becomes something a person can act on. */
export function describeTransportError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/^50[0-9]/.test(msg) || /bad gateway|network request failed/i.test(msg)) {
    return 'The API is not reachable. Check that the Atlas stack is running and the server address in Settings is correct.';
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return 'Could not reach the server. Check the address in Settings.';
  }
  return msg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export class TransportError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getBaseUrl().replace(/\/$/, '');
  if (!base) throw new TransportError('No server configured yet — set it in Settings.');
  loadingBus.begin();
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), ...authHeaders() },
    });
    flagIfUnauthorized(res.status);
    if (!res.ok) throw new TransportError(`${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  } finally {
    loadingBus.end();
  }
}

async function get<T>(path: string): Promise<T> {
  return request<T>(path, {
    headers: { 'x-atlas-client': 'mobile' },
  });
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-client': 'mobile' },
    body: JSON.stringify(body),
  });
}

export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const transport = { get, post };
