import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `config/atlas.defaults.env` is the committed source of truth, so it has to
 * stay in step with what the application actually reads.
 *
 * Both directions matter, and they fail differently. A variable the code reads
 * but the file omits falls back to a zod default silently — the file then
 * understates what is configurable, and someone edits it expecting an effect it
 * cannot have. A key in the file the code never reads is worse: it looks like a
 * setting, it can be changed, and nothing happens.
 */

const root = resolve(__dirname, '../..');
const configSource = readFileSync(resolve(root, 'packages/core/src/config.ts'), 'utf8');
const defaultsFile = readFileSync(resolve(root, 'config/atlas.defaults.env'), 'utf8');

/** Every `env.SOMETHING` the config module reads. */
function varsReadByCode(): Set<string> {
  return new Set([...configSource.matchAll(/\benv\.([A-Z0-9_]+)/g)].map((m) => m[1]!));
}

/** Every assignable key in the defaults file, commented-out lines included. */
function keysInFile(): Set<string> {
  const keys = new Set<string>();
  for (const line of defaultsFile.split('\n')) {
    const m = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (m) keys.add(m[1]!);
  }
  return keys;
}

/**
 * Keys the file carries that `config.ts` does not read directly.
 *
 * Not slack — each is consumed somewhere else and would be wrong to delete.
 * Compose interpolates the ports and the host paths to build port bindings and
 * volume mounts before any Node runs, which is the whole reason a config file
 * the app reads could never have replaced this one.
 */
const CONSUMED_BY_COMPOSE = new Set([
  'API_PORT',
  'MCP_PORT',
  'UI_PORT',
  'QDRANT_PORT',
  'QDRANT_GRPC_PORT',
  'REDIS_PORT',
  'POSTGRES_PORT',
  'CODE_ROOT_HOST',
  'CODE_ROOT_HOST_2',
  'CODE_ROOT_HOST_3',
  'CODE_ROOT_HOST_4',
  'CODE_ROOT_HOST_5',
  'CLAUDE_PROJECTS_HOST',
  'CODE_ROOT',
  'CLAUDE_PROJECTS_DIR',
  // Interpolated straight into the indexer's `/keys` bind-mount source
  // (docker-compose.yml) — nothing in packages/core reads it directly.
  'ATLAS_KEYS_DIR',
]);

/**
 * Read by `config.ts` but deliberately not listed with a value.
 *
 * `CODE_ROOT_2..5` are optional extra mounts; listing them empty would activate
 * nothing but suggests they are configured. `ATLAS_SELF` is per-machine `.env`
 * material (not fleet-wide). The rest are documented in the file as
 * commented-out or intentionally-blank lines and are picked up by
 * `keysInFile`, so nothing lands here that a reader would miss.
 */
const INTENTIONALLY_ABSENT = new Set([
  'CODE_ROOT_2',
  'CODE_ROOT_3',
  'CODE_ROOT_4',
  'CODE_ROOT_5',
  'ATLAS_SELF',
]);

describe('config/atlas.defaults.env', () => {
  it('carries every variable the config module reads', () => {
    const missing = [...varsReadByCode()].filter(
      (v) => !keysInFile().has(v) && !INTENTIONALLY_ABSENT.has(v),
    );
    expect(missing).toEqual([]);
  });

  it('carries no key nothing reads', () => {
    const read = varsReadByCode();
    const stale = [...keysInFile()].filter((k) => !read.has(k) && !CONSUMED_BY_COMPOSE.has(k));
    expect(stale).toEqual([]);
  });

  it('leaves every secret empty, because secrets come from Doppler', () => {
    // A key committed here would be a key in git history. The slots exist so the
    // shape is documented; the values come from the shell at container creation.
    for (const secret of ['EMBEDDINGS_API_KEY', 'LLM_API_KEY']) {
      const m = new RegExp(`^${secret}=(.*)$`, 'm').exec(defaultsFile);
      expect(m, `${secret} should be present as an empty slot`).not.toBeNull();
      expect(m![1]!.trim()).toBe('');
    }
  });

  it('is a plain env file compose can read, with no shell expansion', () => {
    // Compose does not run a shell over these, so `$(...)` or a backtick in a
    // *value* is taken literally and yields a nonsense setting rather than an
    // error. Comments are exempt: they are prose, and this file's prose leans on
    // backticks heavily.
    const values = defaultsFile
      .split('\n')
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l.trim()))
      .join('\n');
    expect(values).not.toMatch(/\$\(/);
    expect(values).not.toMatch(/`/);
  });
});
