import { describe, expect, it } from 'vitest';
import { parseConfig } from '@kdbscope/core';

describe('parseConfig', () => {
  it('applies defaults for an empty env', () => {
    const c = parseConfig({});
    expect(c.codeRoots).toEqual([{ container: '/data/code', host: undefined }]);
    expect(c.scanIntervalMin).toBe(5);
    expect(c.embeddings.provider).toBe('auto');
    expect(c.llm.provider).toBe('g2p');
    expect(c.apiPort).toBe(8710);
  });

  it('reads and coerces env values', () => {
    const c = parseConfig({
      SCAN_INTERVAL_MIN: '15',
      EMBEDDINGS_PROVIDER: 'ollama',
      LLM_PROVIDER: 'openai',
      LLM_BASE_URL: 'https://api.example.com/v1',
      LLM_API_KEY: 'sk-test',
      API_PORT: '9000',
    });
    expect(c.scanIntervalMin).toBe(15);
    expect(c.embeddings.provider).toBe('ollama');
    expect(c.llm).toMatchObject({ provider: 'openai', apiKey: 'sk-test' });
    expect(c.apiPort).toBe(9000);
  });

  it('treats empty strings as unset', () => {
    const c = parseConfig({ EMBEDDINGS_BASE_URL: '', LLM_API_KEY: '' });
    expect(c.embeddings.baseUrl).toBeUndefined();
    expect(c.llm.apiKey).toBeUndefined();
  });

  it('rejects invalid providers', () => {
    expect(() => parseConfig({ EMBEDDINGS_PROVIDER: 'bogus' })).toThrow();
  });
});

describe('multiple project roots', () => {
  it('pairs each container root with its host root', () => {
    const c = parseConfig({
      CODE_ROOT_HOST: '/Users/nasta/__CODING NEW',
      CODE_ROOT_HOST_2: '/Users/nasta/Work',
    });
    expect(c.codeRoots).toEqual([
      { container: '/data/code', host: '/Users/nasta/__CODING NEW' },
      { container: '/data/code2', host: '/Users/nasta/Work' },
    ]);
  });

  it('ignores an extra slot whose host path is unset (nothing is mounted there)', () => {
    const c = parseConfig({ CODE_ROOT_HOST: '/a', CODE_ROOT_3: '/data/code3' });
    expect(c.codeRoots).toHaveLength(1);
  });

  it('collects up to four extra roots, skipping gaps', () => {
    const c = parseConfig({
      CODE_ROOT_HOST: '/a',
      CODE_ROOT_HOST_2: '/b',
      CODE_ROOT_HOST_4: '/d',
    });
    expect(c.codeRoots.map((r) => r.host)).toEqual(['/a', '/b', '/d']);
    expect(c.codeRoots.map((r) => r.container)).toEqual([
      '/data/code',
      '/data/code2',
      '/data/code4',
    ]);
  });

  it('allows overriding a container mount point', () => {
    const c = parseConfig({ CODE_ROOT_HOST_2: '/b', CODE_ROOT_2: '/mnt/other' });
    expect(c.codeRoots[1]).toEqual({ container: '/mnt/other', host: '/b' });
  });
});
