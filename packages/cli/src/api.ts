/** REST client for the atlas CLI. Base URL via KDBSCOPE_API_URL. */

export function apiBase(): string {
  return (process.env.KDBSCOPE_API_URL ?? 'http://127.0.0.1:8710').replace(/\/$/, '');
}

/** Label CLI traffic for the API's agent-usage telemetry. */
const CLIENT_HEADERS = { 'x-atlas-client': 'cli' };

export async function get(path: string): Promise<any> {
  const res = await fetch(`${apiBase()}${path}`, { headers: CLIENT_HEADERS });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CLIENT_HEADERS },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export type AskEvent =
  | { type: 'sources'; sources: any[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; model: string; degraded: boolean }
  | { type: 'error'; message: string };

/** Consume the Ask SSE stream from the API, yielding events as they arrive. */
export async function* postStream(
  path: string,
  body: unknown,
): AsyncGenerator<AskEvent, void, unknown> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CLIENT_HEADERS },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const record = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!record.startsWith('data:')) continue;
        try {
          yield JSON.parse(record.slice(5).trim()) as AskEvent;
        } catch {
          // Skip a malformed frame rather than aborting the answer.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
