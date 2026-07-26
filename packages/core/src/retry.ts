/**
 * Retry for transient failures only (§3.8).
 *
 * Retryable: network/timeouts (fetch failed, ECONNRESET, aborts), 429, 5xx.
 * NOT retryable: 4xx other than 429 (a malformed point never becomes valid),
 * and anything the caller marks non-transient. Non-idempotent work must not
 * use this — our Qdrant upserts are idempotent by deterministic point id.
 */

const TRANSIENT_PATTERNS = [
  /fetch failed/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /socket hang up/i,
  /aborted/i,
  /timeout/i,
  /network/i,
  // Ollama's model runner drops the connection under sustained load.
  /EOF/,
  /unexpected end/i,
];

/** Attach an HTTP status so retry classification survives error wrapping. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function isTransient(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; message?: string };
  const status = e?.status ?? e?.statusCode;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500) return true;
    if (status >= 400) return false; // client error: retrying cannot help
  }
  const msg = e?.message ?? String(err);
  return TRANSIENT_PATTERNS.some((p) => p.test(msg));
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Injected in tests so we never actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, err: unknown) => void;
  /**
   * Override which errors count as retryable. Defaults to `isTransient`.
   *
   * Some failures are transient without being *transport* failures: a heavy
   * model behind the gateway can return 200 with a truncated or non-JSON body,
   * which is a parse error, not a network error, and `isTransient` correctly
   * says no. The alternative — making the parse error's message match one of
   * the transient patterns — would encode retry policy in a string, invisibly.
   * Callers that know their own transient shapes declare them here instead.
   */
  isRetryable?: (err: unknown) => boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  const retryable = opts.isRetryable ?? isTransient;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!retryable(err) || attempt === attempts) throw err;
      opts.onRetry?.(attempt, err);
      // Exponential backoff with jitter to avoid retry storms across workers.
      const delay = base * 2 ** (attempt - 1);
      await sleep(delay + Math.floor(delay * 0.25 * Math.random()));
    }
  }
  throw lastErr;
}
