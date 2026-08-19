import { timingSafeEqual } from 'node:crypto';

/**
 * The bearer-token pass/401 decision (spec §7), factored out as a pure
 * function so it is testable without a real HTTP framework or socket.
 *
 * Both the api (Hono, `packages/api/src/auth.ts`) and mcp (plain
 * `node:http`, `packages/mcp/src/main.ts`) servers wrap this with a few
 * lines that pull `path`/`peer`/`header` out of their own request object —
 * the decision itself lives here once, shared.
 */

export interface AuthorizeInput {
  /** Request path (no query string). */
  path: string;
  /**
   * Socket peer address ONLY — never derived from a header. nginx sets no
   * `X-Forwarded-For` in front of this stack, so a header-trusting loopback
   * check would be a spoofable bypass: anyone on the LAN could claim to be
   * `127.0.0.1` in a request header. Undefined when the caller couldn't
   * determine one (e.g. no real socket, as under Hono's `app.request()`
   * test client) — treated as non-loopback.
   */
  peer: string | undefined;
  /** Raw `Authorization` header value, if any (`"Bearer <token>"`). */
  header?: string;
}

export interface AuthorizeOpts {
  /** Required bearer token. Falsy = legacy mode: every request passes. */
  token?: string;
  /** Exact-match paths that pass with no token and no loopback check. */
  exempt: string[];
}

const BEARER_PREFIX = 'Bearer ';

/** Matches a bare dotted-quad, used only after stripping any `::ffff:` prefix. */
const IPV4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * True for `127.0.0.0/8` and `::1`, including the IPv4-mapped IPv6 form
 * (`::ffff:127.x.x.x`) a dual-stack Node socket can report.
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const stripped = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  if (stripped === '::1') return true;
  const m = IPV4.exec(stripped);
  return m ? Number(m[1]) === 127 : false;
}

/**
 * Constant-time token compare. `timingSafeEqual` throws on a length
 * mismatch rather than returning false, so the length check has to come
 * first — the guard the interface asks for.
 */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Rules, in order (spec §7):
 *  1. no token configured → pass (legacy localhost-only mode, no-op).
 *  2. path is exempt (liveness checks, `/api/instance`) → pass.
 *  3. socket peer is loopback → pass.
 *  4. else: a valid `Authorization: Bearer <token>` header → pass, else 401.
 */
export function authorize(input: AuthorizeInput, opts: AuthorizeOpts): 'pass' | 401 {
  if (!opts.token) return 'pass';
  if (opts.exempt.includes(input.path)) return 'pass';
  if (isLoopbackAddress(input.peer)) return 'pass';
  if (!input.header || !input.header.startsWith(BEARER_PREFIX)) return 401;
  const provided = input.header.slice(BEARER_PREFIX.length);
  return tokensMatch(provided, opts.token) ? 'pass' : 401;
}
