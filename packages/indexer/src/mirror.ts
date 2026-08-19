import { existsSync } from 'node:fs';
import {
  encodeClaudePath, mirrorClaudeDir, mirrorCodeRoot,
  type MachinesFile,
} from '@atlas/core';
import type { CodeRoot } from './scanners.js';

/**
 * Mirror-side discovery inputs, machine by machine. rsync's own delta logic
 * (spec §4) means a code root that has never synced simply has no mirror dir
 * yet, so `exists` (defaulting to a real `existsSync` check, injected for
 * tests) is the whole "only scan what has actually landed" guard — no
 * separate readiness flag to keep in sync.
 */
function otherEnabledMachines(mf: MachinesFile, selfName: string) {
  return mf.machines.filter((m) => m.enabled && m.name !== selfName);
}

/** One `CodeRoot` per synced mirror code root, across every other enabled machine. */
export function mirrorRootsFor(
  mf: MachinesFile,
  selfName: string,
  exists: (path: string) => boolean = existsSync,
): CodeRoot[] {
  const roots: CodeRoot[] = [];
  for (const m of otherEnabledMachines(mf, selfName)) {
    m.codeRoots.forEach((host, i) => {
      const container = mirrorCodeRoot(m.name, i + 1);
      if (!exists(container)) return; // never synced — nothing to scan yet
      roots.push({ container, host, machine: m.name, slugOverrides: m.slugOverrides });
    });
  }
  return roots;
}

/** One entry per synced mirror Claude-transcripts dir, across every other enabled machine. */
export function mirrorClaudeDirsFor(
  mf: MachinesFile,
  selfName: string,
  exists: (path: string) => boolean = existsSync,
): { machine: string; dir: string; encodedRoots: string[] }[] {
  const out: { machine: string; dir: string; encodedRoots: string[] }[] = [];
  for (const m of otherEnabledMachines(mf, selfName)) {
    const dir = mirrorClaudeDir(m.name);
    if (!exists(dir)) continue; // never synced — nothing to attribute yet
    out.push({ machine: m.name, dir, encodedRoots: m.codeRoots.map(encodeClaudePath) });
  }
  return out;
}

/**
 * Cheap divergence check (spec §5): the same slug on two machines is treated
 * as the same project, which is right for a genuinely shared checkout and
 * silently wrong for two unrelated projects that happen to share a dir
 * basename (`notes`, `api`, …). Comparing each location's `git remote get-url
 * origin` catches the mismatch after the fact — pure here; the git plumbing
 * that produces `originUrl` per location is Task 14's job.
 */
export function checkLocationDivergence(
  locations: { machine: string; originUrl: string | null }[],
): string | null {
  const known = locations.filter(
    (l): l is { machine: string; originUrl: string } => l.originUrl !== null,
  );
  const uniqueUrls = new Set(known.map((l) => l.originUrl));
  if (uniqueUrls.size <= 1) return null;

  const named = known.map((l) => `${l.machine}=${l.originUrl}`).join(', ');
  return `location origin URLs diverge across machines — same slug may be unrelated projects: ${named}`;
}
