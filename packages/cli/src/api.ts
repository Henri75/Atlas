/** REST client for the kdbs CLI. Base URL via KDBSCOPE_API_URL. */

export function apiBase(): string {
  return (process.env.KDBSCOPE_API_URL ?? 'http://127.0.0.1:8710').replace(/\/$/, '');
}

export async function get(path: string): Promise<any> {
  const res = await fetch(`${apiBase()}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
