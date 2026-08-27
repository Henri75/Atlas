import { readFileSync, readdirSync } from 'node:fs';
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
  // Public access. Compose interpolates the token into the cloudflared
  // service; the rest is read by scripts/cloudflare_tunnel.py, which talks to
  // Cloudflare's API rather than to Atlas. None of it reaches packages/core:
  // the application is unaware it is being tunnelled, which is the point.
  'CLOUDFLARE_TUNNEL_TOKEN',
  'ATLAS_PUBLIC_HOSTNAME',
  'ATLAS_ACCESS_EMAILS',
  'ATLAS_TUNNEL_NAME',
  'ATLAS_TUNNEL_ORIGIN',
  'ATLAS_ACCESS_SESSION',
  'ATLAS_ACCESS_TOKEN_NAME',
]);

/**
 * Read by `config.ts` but deliberately not listed with a value.
 *
 * `CODE_ROOT_2..5` are optional extra mounts; listing them empty would activate
 * nothing but suggests they are configured. `ATLAS_SELF` is per-machine `.env`
 * material (not fleet-wide). `ATLAS_FORCE_ACTIVE` is the single-active guard's
 * emergency escape hatch (spec §8, Task 23) — it overrides a safety check
 * meant to stop two stacks writing the same index at once, so it belongs in a
 * one-off override for the boot that needs it, never in the committed
 * fleet-wide defaults a reader would copy verbatim. The rest are documented
 * in the file as commented-out or intentionally-blank lines and are picked up
 * by `keysInFile`, so nothing lands here that a reader would miss.
 */
const INTENTIONALLY_ABSENT = new Set([
  'CODE_ROOT_2',
  'CODE_ROOT_3',
  'CODE_ROOT_4',
  'CODE_ROOT_5',
  'ATLAS_SELF',
  'ATLAS_FORCE_ACTIVE',
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
    for (const secret of [
      'EMBEDDINGS_API_KEY',
      'LLM_API_KEY',
      'ATLAS_TOKEN',
      'CLOUDFLARE_TUNNEL_TOKEN',
    ]) {
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

/**
 * This repository is PUBLIC, so committed config must not name the deployment.
 *
 * A machine path was the 2026-08-24 failure; a hostname or an operator's email
 * address is the same mistake with a different blast radius — it does not break
 * anyone's boot, it just publishes who runs Atlas and where, permanently, in
 * git history. Both belong in the gitignored .env beside the tunnel token.
 */
describe('committed config identifies no deployment', () => {
  const activeValues = defaultsFile
    .split('\n')
    .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l.trim()));

  it('carries no email address in any active value', () => {
    // Deliberately narrow: DATABASE_URL's `kdbscope@postgres` has no dotted
    // TLD and is a service name, not a person.
    const email = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
    expect(activeValues.filter((l) => email.test(l))).toEqual([]);
  });

  it('leaves the deployment-identifying slots empty', () => {
    for (const key of ['ATLAS_PUBLIC_HOSTNAME', 'ATLAS_ACCESS_EMAILS']) {
      const m = new RegExp(`^${key}=(.*)$`, 'm').exec(defaultsFile);
      expect(m, `${key} should be present as an empty slot`).not.toBeNull();
      expect(m![1]!.trim()).toBe('');
    }
  });
});

/**
 * Nothing committed may carry an absolute path from one machine. Host paths are
 * derived (`${ATLAS_REPO_PARENT}` from the Makefile, `${HOME}` from the shell)
 * so the same checkout works on any host, user or path; the 2026-08-24 host
 * migration found `/Users/nasta/...` baked into both files and the indexer
 * refusing to boot on the new machine.
 */
describe('committed config carries no machine path', () => {
  const composeFile = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
  const machinePath = /\/(Users|home|Volumes)\//;
  const activeValues = defaultsFile
    .split('\n')
    .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l.trim()));

  it('config/atlas.defaults.env has no absolute home path in any active value', () => {
    expect(activeValues.filter((l) => machinePath.test(l))).toEqual([]);
  });

  it('derives the two host roots instead of stating them', () => {
    const value = (k: string) => activeValues.find((l) => l.startsWith(`${k}=`))?.split('=').slice(1).join('=');
    expect(value('CODE_ROOT_HOST')).toMatch(/^\$\{ATLAS_REPO_PARENT\b/);
    expect(value('CLAUDE_PROJECTS_HOST')).toMatch(/^\$\{HOME\b.*\}\/\.claude\/projects$/);
  });

  it('docker-compose.yml has no machine path, not even as a fallback', () => {
    const offenders = composeFile.split('\n').filter((l) => !l.trim().startsWith('#') && machinePath.test(l));
    expect(offenders).toEqual([]);
  });

  it('no committed file under config/ carries a machine path (fleet inventory included)', () => {
    // config/machines.yaml itself is gitignored — per-deployment, like .env;
    // only the example ships, and it must stay a template.
    const offenders: string[] = [];
    for (const name of readdirSync(resolve(root, 'config'))) {
      if (name === 'machines.yaml') continue;
      const text = readFileSync(resolve(root, 'config', name), 'utf8');
      for (const l of text.split('\n')) if (!l.trim().startsWith('#') && machinePath.test(l)) offenders.push(`${name}: ${l.trim()}`);
    }
    expect(offenders).toEqual([]);
  });
});
