import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { machinesFilePath, readToken, writeCredentials } from '@atlas/core';

/**
 * `~/.atlas` — shared host-side config (credentials + machines.yaml path
 * resolution), unified here per Task 26's dispatch after Task 25 flagged
 * `atlas-connect` and the CLI each carrying a private copy.
 */

function tempCredentialsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-home-'));
  return join(dir, 'credentials');
}

describe('readToken', () => {
  it('returns undefined when the file does not exist', () => {
    const path = join(tmpdir(), 'atlas-home-does-not-exist', 'credentials');
    expect(readToken(path)).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    const path = tempCredentialsPath();
    writeFileSync(path, 'not json{{{');
    expect(readToken(path)).toBeUndefined();
  });

  it('returns undefined when the token field is missing', () => {
    const path = tempCredentialsPath();
    writeFileSync(path, JSON.stringify({ notToken: 'x' }));
    expect(readToken(path)).toBeUndefined();
  });

  it('returns undefined when the token field is an empty string', () => {
    const path = tempCredentialsPath();
    writeFileSync(path, JSON.stringify({ token: '' }));
    expect(readToken(path)).toBeUndefined();
  });

  it('returns undefined when the token field is not a string', () => {
    const path = tempCredentialsPath();
    writeFileSync(path, JSON.stringify({ token: 12345 }));
    expect(readToken(path)).toBeUndefined();
  });

  it('returns the token when present and valid', () => {
    const path = tempCredentialsPath();
    writeFileSync(path, JSON.stringify({ token: 'sekret-token' }));
    expect(readToken(path)).toBe('sekret-token');
  });
});

describe('writeCredentials', () => {
  it('mkdir -p’s the parent, writes parseable JSON, and sets mode 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-home-write-'));
    const path = join(dir, 'nested', 'credentials');

    writeCredentials('my-token', path);

    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ token: 'my-token' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('round-trips through readToken', () => {
    const path = tempCredentialsPath();
    writeCredentials('round-trip-token', path);
    expect(readToken(path)).toBe('round-trip-token');
  });

  it('re-tightens permissions on an existing, looser file', () => {
    const path = tempCredentialsPath();
    writeFileSync(path, JSON.stringify({ token: 'old' }));
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    writeCredentials('new-token', path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readToken(path)).toBe('new-token');
  });
});

describe('machinesFilePath', () => {
  const saved = process.env.ATLAS_MACHINES_FILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.ATLAS_MACHINES_FILE;
    else process.env.ATLAS_MACHINES_FILE = saved;
  });

  it('ATLAS_MACHINES_FILE overrides the default', () => {
    process.env.ATLAS_MACHINES_FILE = '/custom/machines.yaml';
    expect(machinesFilePath()).toBe('/custom/machines.yaml');
  });

  it('defaults to config/machines.yaml under the repo root', () => {
    delete process.env.ATLAS_MACHINES_FILE;
    const p = machinesFilePath();
    expect(p.endsWith(join('config', 'machines.yaml'))).toBe(true);
  });
});
