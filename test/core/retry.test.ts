import { describe, expect, it, vi } from 'vitest';
import { HttpError, isTransient, withRetry } from '@atlas/core';

const noSleep = async () => {};

describe('isTransient', () => {
  it('treats network/timeout errors as transient', () => {
    expect(isTransient(new Error('fetch failed'))).toBe(true);
    expect(isTransient(new Error('read ECONNRESET'))).toBe(true);
    expect(isTransient(new Error('The operation was aborted'))).toBe(true);
  });

  it('treats 429 and 5xx as transient', () => {
    expect(isTransient({ status: 429, message: 'slow down' })).toBe(true);
    expect(isTransient({ status: 503, message: 'unavailable' })).toBe(true);
  });

  it('treats other 4xx as permanent even if the text looks scary', () => {
    expect(isTransient({ status: 400, message: 'timeout in payload name' })).toBe(false);
    expect(isTransient({ status: 404, message: 'not found' })).toBe(false);
  });

  it('treats unknown errors as permanent', () => {
    expect(isTransient(new Error('invalid vector dimension'))).toBe(false);
  });

  /**
   * Regression: Ollama's runner drops the connection under load, returning a
   * 500 whose body says "EOF". The provider used to stringify the status into
   * the message, so classification saw no `status` and gave up immediately,
   * killing an in-progress re-embed of 70k entries.
   */
  it('classifies HttpError by status, surviving message wrapping', () => {
    expect(isTransient(new HttpError('ollama embed failed: EOF', 500))).toBe(true);
    expect(isTransient(new HttpError('rate limited', 429))).toBe(true);
    expect(isTransient(new HttpError('bad vector', 400))).toBe(false);
  });

  it('treats an Ollama runner EOF as transient even without a status', () => {
    expect(isTransient(new Error('do embedding request: Post "...": EOF'))).toBe(true);
  });

  it('retries a 500 from an embedding provider', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (++n < 3) throw new HttpError('ollama embed failed: EOF', 500);
      return [[1, 2, 3]];
    });
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toEqual([[1, 2, 3]]);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn(async () => 'ok');
    expect(await withRetry(fn, { sleep: noSleep })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures then succeeds', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (++n < 3) throw new Error('fetch failed');
      return 'recovered';
    });
    expect(await withRetry(fn, { sleep: noSleep })).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry permanent failures', async () => {
    const fn = vi.fn(async () => {
      throw { status: 400, message: 'bad request' };
    });
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget and rethrows the last error', async () => {
    const fn = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    await expect(withRetry(fn, { attempts: 3, sleep: noSleep })).rejects.toThrow('fetch failed');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('reports each retry to the caller', async () => {
    const onRetry = vi.fn();
    let n = 0;
    await withRetry(
      async () => {
        if (++n < 2) throw new Error('ETIMEDOUT');
        return 1;
      },
      { sleep: noSleep, onRetry },
    );
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });
});

/**
 * Caller-declared retryability.
 *
 * Not every transient failure is a *transport* failure: a heavy model behind the
 * LLM gateway answers 200 with a truncated body, which is a parse error and which
 * `isTransient` rightly refuses to retry. The alternative to this hook was
 * wording the parse error so it matched one of the transient message patterns —
 * retry policy hidden in a string, invisible to anyone reading either file.
 */
describe('withRetry isRetryable override', () => {
  class FormatError extends Error {}

  it('retries an error the default classifier would reject', async () => {
    let n = 0;
    const out = await withRetry(
      async () => {
        if (++n < 3) throw new FormatError('not valid JSON');
        return 'ok';
      },
      { sleep: noSleep, isRetryable: (e) => e instanceof FormatError },
    );
    expect(out).toBe('ok');
    expect(n).toBe(3);
    // Sanity: the default classifier really would have given up immediately.
    expect(isTransient(new FormatError('not valid JSON'))).toBe(false);
  });

  it('narrows as well as widens — an override that says no stops the retry', async () => {
    const fn = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    await expect(withRetry(fn, { sleep: noSleep, isRetryable: () => false })).rejects.toThrow(
      'fetch failed',
    );
    expect(fn).toHaveBeenCalledOnce();
  });

  it('still honours the attempt budget', async () => {
    const fn = vi.fn(async () => {
      throw new FormatError('nope');
    });
    await expect(
      withRetry(fn, { attempts: 3, sleep: noSleep, isRetryable: () => true }),
    ).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
