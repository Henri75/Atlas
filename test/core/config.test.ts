import { describe, expect, it } from 'vitest';
import { parseConfig } from '@kdbscope/core';

describe('parseConfig', () => {
  it('applies defaults for an empty env', () => {
    const c = parseConfig({});
    expect(c.codeRoot).toBe('/data/code');
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
