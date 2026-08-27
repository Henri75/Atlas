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

/**
 * Cloudflare Access service-token credentials.
 *
 * Access is a browser-shaped login: it answers an unauthenticated request with
 * a redirect to an identity provider, which an app with no browser cannot
 * complete. A service token is Cloudflare's answer for exactly this — two
 * headers, checked at the edge, no session to keep alive.
 */
export interface AccessCredentials {
  clientId: string;
  clientSecret: string;
}

let getBaseUrl: () => string = () => '';
let getToken: () => string | null = () => null;
let getAccess: () => AccessCredentials | null = () => null;
const unauthorizedListeners = new Set<UnauthorizedListener>();

export function configureTransport(opts: {
  getBaseUrl: () => string;
  getToken: () => string | null;
  getAccess: () => AccessCredentials | null;
}) {
  getBaseUrl = opts.getBaseUrl;
  getToken = opts.getToken;
  getAccess = opts.getAccess;
}

/**
 * Every header Atlas sends, in one place, so the plain and SSE paths cannot
 * drift — the two layers are independent and a request needs both: Cloudflare
 * decides whether it reaches the origin at all, Atlas decides what it may do.
 */
export function atlasHeaders(
  token: string | null,
  access: AccessCredentials | null,
): Record<string, string> {
  return {
    'x-atlas-client': 'mobile',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(access
      ? {
          'CF-Access-Client-Id': access.clientId,
          'CF-Access-Client-Secret': access.clientSecret,
        }
      : {}),
  };
}

/** Message for a rejection that came from the edge, not from Atlas. */
export const ACCESS_REJECTED =
  'Cloudflare Access refused this request. Check the service token under ' +
  'Settings › Cloudflare Access, or that this device is allowed in.';

/**
 * Did Cloudflare reject this, or did Atlas?
 *
 * It matters: Atlas's own 401 means "your bearer token is wrong" and should
 * raise the token gate, while Access's means "you never reached Atlas" and
 * raising the gate would send someone to re-enter a token that was fine.
 * Access answers from the edge with HTML; Atlas answers JSON from Hono.
 */
export function isAccessRejection(status: number, headers: Headers, body: string): boolean {
  if (status !== 401 && status !== 403) return false;
  if (headers.get('cf-mitigated')) return true;
  return /cloudflare\s+access|cf-access|<title>[^<]*Access/i.test(body);
}

/** Fired on any 401: this instance is LAN-exposed and the token is bad. */
export function onUnauthorized(l: UnauthorizedListener): () => void {
  unauthorizedListeners.add(l);
  return () => unauthorizedListeners.delete(l);
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
      headers: {
        ...(init?.headers as Record<string, string>),
        ...atlasHeaders(getToken(), getAccess()),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      // Order matters: an edge rejection is not an Atlas 401, and treating it
      // as one would raise the bearer-token gate over a service-token problem.
      if (isAccessRejection(res.status, res.headers, body)) {
        throw new TransportError(ACCESS_REJECTED);
      }
      if (res.status === 401) flagUnauthorized();
      throw new TransportError(`${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  } finally {
    loadingBus.end();
  }
}

async function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
