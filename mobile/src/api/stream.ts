import type { AskEvent } from '@atlas/shared';
import { flagUnauthorized } from './client';
import { loadingBus } from './loadingBus';

/**
 * Consume the Ask SSE stream (POST /api/ask/stream) on React Native.
 *
 * Uses `expo/fetch` — the SDK's WinterCG fetch, whose response body is a real
 * WHATWG ReadableStream on both platforms, which the JS runtime's plain fetch
 * does not guarantee. After that it is byte-for-byte the web's reader: split
 * on SSE record boundaries, parse each `data:` frame.
 *
 * Hermes ships no TextDecoder, so an incremental UTF-8 decoder runs beside the
 * stream — multi-byte characters split across chunk boundaries must survive.
 */

// expo/fetch is the SDK's streaming-capable fetch; required lazily so the
// module graph keeps it out of any non-RN consumer of this module's siblings.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fetch: expoFetch } = require('expo/fetch') as typeof import('expo/fetch');

/** Incremental UTF-8: carries partial trailing sequences into the next chunk. */
class Utf8Flow {
  private carry: number[] = [];

  push(bytes: Uint8Array): string {
    const out: number[] = [];
    let i = 0;
    const input = [...this.carry, ...Array.from(bytes)];
    this.carry = [];
    while (i < input.length) {
      const b0 = input[i]!;
      let need = 0;
      if (b0 < 0x80) need = 0;
      else if (b0 >= 0xc2 && b0 <= 0xdf) need = 1;
      else if (b0 >= 0xe0 && b0 <= 0xef) need = 2;
      else if (b0 >= 0xf0 && b0 <= 0xf4) need = 3;
      else {
        i += 1; // stray continuation byte — skip rather than poison the stream
        continue;
      }
      if (i + need >= input.length) {
        // Incomplete sequence: hold the tail for the next chunk.
        this.carry = input.slice(i);
        break;
      }
      if (need === 0) {
        out.push(b0);
      } else {
        let cp = b0 & (0x3f >> need);
        let ok = true;
        for (let k = 1; k <= need; k++) {
          const b = input[i + k]!;
          if ((b & 0xc0) !== 0x80) {
            ok = false;
            break;
          }
          cp = (cp << 6) | (b & 0x3f);
        }
        if (ok) {
          // Code points above the BMP decode to surrogate pairs; charCodeAt
          // preserves them for String.fromCharCode below.
          const units = String.fromCodePoint(cp);
          for (let k = 0; k < units.length; k++) out.push(units.charCodeAt(k));
          i += need + 1;
          continue;
        }
      }
      i += need + 1;
    }
    // Chunked conversion: a single spread of 64k+ args can exceed engine
    // argument limits on a large SSE burst.
    let out2 = '';
    for (let c = 0; c < out.length; c += 0x2000) {
      out2 += String.fromCharCode(...out.slice(c, c + 0x2000));
    }
    return out2;
  }
}

export async function* askStream(
  base: string,
  token: string | null,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<AskEvent, void, unknown> {
  const url = `${base.replace(/\/$/, '')}/api/ask/stream`;
  loadingBus.begin();
  try {
    const res = await expoFetch(url, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-atlas-client': 'mobile',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) flagUnauthorized();
    if (!res.ok || !res.body) {
      throw new Error(`${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const flow = new Utf8Flow();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += flow.push(value);
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const record = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (!record.startsWith('data:')) continue;
          try {
            yield JSON.parse(record.slice(5).trim()) as AskEvent;
          } catch {
            // Ignore a malformed frame rather than aborting the answer.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    loadingBus.end();
  }
}
