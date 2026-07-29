import { describe, expect, it } from 'vitest';
import { describeQuery, summarizeQuery } from '../../packages/ui/src/describeQuery.js';

/**
 * The `query` column holds two different kinds of string, because GET and POST
 * routes record differently: a raw URL query string for search, prose for an ask.
 * Getting the discrimination wrong is not cosmetic — decoding prose would rewrite
 * every '+' in a real question into a space.
 */
describe('describeQuery', () => {
  it('decodes a search query string into its text and filters', () => {
    const d = describeQuery(
      'q=safari+youtube+content+process+crash+problem+repeatedly+occurred+bisect+video-inject&project=deepcast&limit=10',
    );
    expect(d).toEqual({
      text: 'safari youtube content process crash problem repeatedly occurred bisect video-inject',
      filters: [
        { key: 'project', value: 'deepcast' },
        { key: 'limit', value: '10' },
      ],
      decoded: true,
    });
  });

  it('decodes percent-escapes, including an encoded plus', () => {
    const d = describeQuery('q=c%2B%2B%20and%20100%25%20coverage');
    expect(d?.text).toBe('c++ and 100% coverage');
  });

  /** Filters before mechanics, so two identical calls always read identically. */
  it('demotes paging parameters below real filters', () => {
    const d = describeQuery('q=x&limit=10&source=doc&k=12&project=atlas');
    expect(d?.filters.map((f: { key: string }) => f.key)).toEqual(['source', 'project', 'limit', 'k']);
  });

  /**
   * A question can contain '=' ("what does k=12 do?"), so '=' anywhere cannot be
   * the test. Only a leading `identifier=` counts.
   */
  it('leaves an ask question alone, even one containing an equals sign', () => {
    const d = describeQuery('what does k=12 actually do, and why 1+1?');
    expect(d).toEqual({
      text: 'what does k=12 actually do, and why 1+1?',
      filters: [],
      decoded: false,
    });
  });

  it('treats a question starting with a word and a space as prose', () => {
    const d = describeQuery('query = what happened?');
    expect(d?.decoded).toBe(false);
    expect(d?.text).toBe('query = what happened?');
  });

  it('returns null for nothing, so a caller can render a dash', () => {
    expect(describeQuery(undefined)).toBeNull();
    expect(describeQuery('')).toBeNull();
    expect(describeQuery('   ')).toBeNull();
  });

  it('drops empty parameters rather than showing bare keys', () => {
    const d = describeQuery('q=hello&project=&source=');
    expect(d?.text).toBe('hello');
    expect(d?.filters).toEqual([]);
  });

  it('handles a query string with filters but no text', () => {
    const d = describeQuery('project=deepcast&source=doc');
    expect(d?.text).toBe('');
    expect(d?.filters).toHaveLength(2);
  });

  it('reads `question` as the text key too', () => {
    expect(describeQuery('question=why+was+this+built')?.text).toBe('why was this built');
  });
});

describe('summarizeQuery', () => {
  it('joins text and filters for a dense cell', () => {
    expect(summarizeQuery('q=pgbouncer&project=deepcast')).toBe('pgbouncer — project: deepcast');
  });

  it('shows text alone when there are no filters', () => {
    expect(summarizeQuery('q=pgbouncer')).toBe('pgbouncer');
  });

  it('shows filters alone when there is no text', () => {
    expect(summarizeQuery('project=deepcast&source=doc')).toBe('project: deepcast · source: doc');
  });

  it('is empty for nothing', () => {
    expect(summarizeQuery(undefined)).toBe('');
  });
});
