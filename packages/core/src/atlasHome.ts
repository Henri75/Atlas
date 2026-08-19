import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `~/.atlas` — the CLI/shim's own host-side config dir (spec §8): the
 * `credentials` file read/written here, plus (see `resolve.ts`'s
 * `DEFAULT_CACHE_PATH`) the resolver's `active.json` cache. Distinct from
 * `config/machines.yaml`, which is the committed, repo-side fleet SSoT.
 *
 * Shared by `packages/cli` and `packages/atlas-connect` — both need the same
 * credentials file and the same `machines.yaml` path resolution. Task 25's
 * `atlas-connect` implementation carried a private copy of both (flagged in
 * its report as duplication for Task 26 to judge); this module unifies them
 * so there is exactly one implementation of each, imported by both packages.
 */

export function atlasHomeDir(): string {
  return join(homedir(), '.atlas');
}

export function defaultCredentialsPath(): string {
  return join(atlasHomeDir(), 'credentials');
}

/**
 * Absent file, unreadable JSON, or a missing/empty/non-string `token` field
 * all mean the same thing: no token configured (legacy/dev mode) — never
 * invented, never fatal. `path` is injectable for tests; defaults to
 * `~/.atlas/credentials`.
 */
export function readToken(path: string = defaultCredentialsPath()): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown };
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes `~/.atlas/credentials` (`{ token }`, mode 0600) for `atlas connect
 * --token` (Task 26). `mkdir -p`s the parent. `chmodSync` runs even though
 * `writeFileSync`'s own `mode` option already requests 0600, because that
 * option is only honoured when the file is CREATED — re-running `connect`
 * against an existing file with looser permissions would otherwise leave
 * them untouched. `path` is injectable for tests; defaults to
 * `~/.atlas/credentials`.
 */
export function writeCredentials(token: string, path: string = defaultCredentialsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ token }), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * `config/machines.yaml`, resolved relative to the CALLING package's own
 * compiled location — every host-side package that needs this (`cli`,
 * `atlas-connect`) is npm-linked from this checkout at the same depth
 * (`packages/<name>/dist/*.js`, and identically `packages/<name>/src/*.ts`
 * under vitest's source alias), so climbing three directories from THIS
 * module's own `import.meta.url` lands at the repo root regardless of which
 * package imported it: `packages/core/dist/atlasHome.js` -> `dist` -> `core`
 * -> `packages` -> repo root, same three hops as `packages/cli/dist/main.js`
 * or `packages/atlas-connect/dist/main.js` would take from their own
 * location. `ATLAS_MACHINES_FILE` overrides this when set — but note the
 * in-container default (`config/atlas.defaults.env`) is a *container* path
 * (`/config/machines.yaml`); on the host, leave it unset.
 */
export function machinesFilePath(): string {
  if (process.env.ATLAS_MACHINES_FILE) return process.env.ATLAS_MACHINES_FILE;
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  return join(repoRoot, 'config', 'machines.yaml');
}
