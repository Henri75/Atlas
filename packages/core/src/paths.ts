import type { AppConfig } from './config.js';
import { mirrorClaudeDir, mirrorCodeRoot, type MachinesFile } from './machines.js';

/**
 * Indexed paths are container paths (`/data/code/...`). An editor deep link
 * needs the path as the host sees it. Only the services know both sides of
 * the bind mounts, so the translation lives here rather than in the UI.
 */

export interface PathMapping {
  containerRoot: string;
  hostRoot: string;
  /**
   * Set only on a mirror mapping (spec §9) — the fleet machine whose real
   * host path `hostRoot` names. Absent for a self mapping (`mappingsFromConfig`),
   * where `hostRoot` is already this machine's own filesystem.
   */
  machine?: string;
  sshUser?: string;
  sshAddress?: string;
}

/** Longest containerRoot first, so nested roots resolve correctly. */
function sortBySpecificity(m: PathMapping[]): PathMapping[] {
  return m.sort((a, b) => b.containerRoot.length - a.containerRoot.length);
}

/** Most specific mount first, so nested roots resolve correctly. */
export function mappingsFromConfig(cfg: AppConfig): PathMapping[] {
  const m: PathMapping[] = [];
  if (cfg.claudeProjectsHost) {
    m.push({ containerRoot: cfg.claudeProjectsDir, hostRoot: cfg.claudeProjectsHost });
  }
  for (const root of cfg.codeRoots) {
    if (root.host) m.push({ containerRoot: root.container, hostRoot: root.host });
  }
  return sortBySpecificity(m);
}

/**
 * Mirror container paths (`/data/remote/<machine>/code<N>`,
 * `/data/remote/<machine>/claude`) → the remote machine's real host paths,
 * for every other enabled fleet machine (spec §9). No existence check: these
 * mappings are read-time only, and a mapping for a mirror root that hasn't
 * synced yet is harmless — no indexed path will ever fall under it until it
 * has.
 */
export function mirrorMappings(mf: MachinesFile, selfName: string): PathMapping[] {
  const m: PathMapping[] = [];
  for (const machine of mf.machines) {
    if (!machine.enabled || machine.name === selfName) continue;
    const { name, user, address } = machine;
    machine.codeRoots.forEach((hostRoot, i) => {
      m.push({
        containerRoot: mirrorCodeRoot(name, i + 1),
        hostRoot,
        machine: name,
        sshUser: user,
        sshAddress: address,
      });
    });
    m.push({
      containerRoot: mirrorClaudeDir(name),
      hostRoot: machine.claudeProjects,
      machine: name,
      sshUser: user,
      sshAddress: address,
    });
  }
  return sortBySpecificity(m);
}

/**
 * Find the mapping whose containerRoot matches `containerPath` (mappings are
 * pre-sorted specificity-first, so the first match is the longest) and
 * compute the rewritten host path in the same pass. `toHostPath` and
 * `resolveLocation` are two views onto this one lookup, not two separate
 * implementations of prefix matching.
 */
function matchMapping(
  containerPath: string,
  mappings: PathMapping[],
): { mapping: PathMapping; hostPath: string } | undefined {
  for (const mapping of mappings) {
    const { containerRoot, hostRoot } = mapping;
    if (containerPath === containerRoot) return { mapping, hostPath: hostRoot };
    const prefix = containerRoot.endsWith('/') ? containerRoot : `${containerRoot}/`;
    if (containerPath.startsWith(prefix)) {
      return { mapping, hostPath: `${hostRoot.replace(/\/$/, '')}/${containerPath.slice(prefix.length)}` };
    }
  }
  return undefined;
}

/**
 * Rewrite a container path to its host equivalent. Returns the input unchanged
 * when no mount matches — a link to the wrong file is worse than no link.
 */
export function toHostPath(containerPath: string, mappings: PathMapping[]): string {
  return matchMapping(containerPath, mappings)?.hostPath ?? containerPath;
}

/**
 * Like `toHostPath`, but also surfaces which machine (if any) the winning
 * mapping belongs to. A mirror mapping carries `machine`/`sshUser`/
 * `sshAddress`; a self mapping carries none of them; an unmatched path
 * resolves to itself with no machine fields at all.
 */
export function resolveLocation(
  containerPath: string,
  mappings: PathMapping[],
): { hostPath: string; machine?: string; sshUser?: string; sshAddress?: string } {
  const found = matchMapping(containerPath, mappings);
  if (!found) return { hostPath: containerPath };
  const { hostPath, mapping } = found;
  return { hostPath, machine: mapping.machine, sshUser: mapping.sshUser, sshAddress: mapping.sshAddress };
}

/**
 * A VS Code deep link. Paths may contain spaces (`__CODING NEW`), so the path
 * component must be encoded; `vscode://file/<abs>` expects a leading slash.
 */
export function editorUrl(hostPath: string, line?: number): string {
  const encoded = hostPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `vscode://file${encoded}${line ? `:${line}` : ''}`;
}

/**
 * A VS Code Remote-SSH deep link, for a location that resolved onto another
 * machine's mirror. Deliberately no `:line` suffix: unlike `vscode://file/...`,
 * the vscode-remote URI scheme has no line-jump convention to hang one off —
 * appending it anyway would just make it a dead fragment. `line` stays in the
 * signature to mirror `editorUrl`'s shape at call sites, but omitting the
 * suffix beats emitting one that lies.
 */
export function remoteEditorUrl(
  loc: { hostPath: string; sshUser?: string; sshAddress?: string },
  line?: number,
): string {
  const encoded = loc.hostPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `vscode://vscode-remote/ssh-remote+${loc.sshUser}@${loc.sshAddress}${encoded}`;
}

/** kdb logs record `line:N`; commits record a sha. Extract a line if present. */
export function lineFromSourceRef(sourceRef?: string): number | undefined {
  const m = sourceRef?.match(/^line:(\d+)$/);
  return m ? Number(m[1]) : undefined;
}
