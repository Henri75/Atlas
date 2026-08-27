import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A service image must install AND build every workspace package it depends on.
 *
 * Regression: packages/ui gained a dependency on the new @atlas/shared, whose
 * package.json points at ./dist. docker/ui.Dockerfile still copied only
 * packages/ui, so `npm ci` never linked @atlas/shared and `vite build` died on
 * the first import — the web image could not be built at all, while the running
 * container kept serving a stale pre-refactor bundle so nothing looked wrong.
 *
 * This is a rule about the class, not that one file: whenever a package that an
 * image builds gains a workspace dependency, the image has to grow with it.
 */

const ROOT = new URL('../../', import.meta.url).pathname;

/** name -> { dir, deps: workspace dep names, hasBuild } for every workspace. */
function workspaces() {
  const out = new Map<string, { dir: string; deps: string[]; hasBuild: boolean }>();
  for (const dir of readdirSync(`${ROOT}packages`)) {
    let pkg: Record<string, never>;
    try {
      pkg = JSON.parse(readFileSync(`${ROOT}packages/${dir}/package.json`, 'utf8'));
    } catch {
      continue;
    }
    const p = pkg as unknown as {
      name: string;
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    out.set(p.name, {
      dir: `packages/${dir}`,
      deps: Object.keys(p.dependencies ?? {}).filter((d) => d.startsWith('@atlas/')),
      hasBuild: Boolean(p.scripts?.build),
    });
  }
  return out;
}

const PKGS = workspaces();
const DIR_TO_NAME = new Map([...PKGS].map(([name, v]) => [v.dir, name]));

/** Every workspace package reachable from `name`, itself included. */
function closure(name: string, seen = new Set<string>()): Set<string> {
  if (seen.has(name)) return seen;
  seen.add(name);
  for (const d of PKGS.get(name)?.deps ?? []) closure(d, seen);
  return seen;
}

const DOCKERFILES = ['docker/ui.Dockerfile', 'docker/node.Dockerfile'];

describe.each(DOCKERFILES)('%s', (file) => {
  const text = readFileSync(`${ROOT}${file}`, 'utf8');

  // What this image builds, read from its own `npm run build -w <dir>` calls.
  const built = [...text.matchAll(/-w\s+(packages\/[\w-]+)/g)]
    .map((m) => DIR_TO_NAME.get(m[1]!))
    .filter((n): n is string => Boolean(n));

  it('builds at least one workspace package', () => {
    expect(built.length).toBeGreaterThan(0);
  });

  const required = new Set<string>();
  for (const b of built) for (const n of closure(b)) required.add(n);

  it.each([...required])('copies and builds its dependency %s', (name) => {
    const { dir, hasBuild } = PKGS.get(name)!;

    // Both COPYs matter: the manifest so `npm ci` can link the workspace, and
    // the sources so there is something to compile.
    expect(text, `${file} must COPY ${dir}/package.json`).toContain(`COPY ${dir}/package.json`);
    expect(text, `${file} must COPY ${dir}`).toMatch(
      new RegExp(`^COPY ${dir} ${dir}$`, 'm'),
    );
    expect(text, `${file} must install ${dir}`).toContain(`--workspace ${dir}`);
    if (hasBuild) {
      expect(text, `${file} must build ${dir}`).toMatch(
        new RegExp(`npm run build[^\\n]*-w ${dir}`),
      );
    }
  });

  it('builds each dependency before the package that needs it', () => {
    // Position of the `-w <dir>` token itself. Matching from `npm run build`
    // would let `[^\n]*` run across a chained `&& npm run build`, reporting the
    // same index for both packages on one line.
    const buildsFrom = text.indexOf('npm run build');
    const at = (dir: string) => text.indexOf(`-w ${dir}`, buildsFrom);
    for (const name of required) {
      for (const dep of PKGS.get(name)!.deps) {
        if (!PKGS.get(dep)?.hasBuild) continue;
        const depAt = at(PKGS.get(dep)!.dir);
        const ownAt = at(PKGS.get(name)!.dir);
        if (depAt === -1 || ownAt === -1) continue;
        expect(depAt, `${dep} must be built before ${name}`).toBeLessThan(ownAt);
      }
    }
  });
});
