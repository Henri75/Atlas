import type { AppConfig } from './config.js';

/**
 * Indexed paths are container paths (`/data/code/...`). An editor deep link
 * needs the path as the host sees it. Only the services know both sides of
 * the bind mounts, so the translation lives here rather than in the UI.
 */

export interface PathMapping {
  containerRoot: string;
  hostRoot: string;
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
  return m.sort((a, b) => b.containerRoot.length - a.containerRoot.length);
}

/**
 * Rewrite a container path to its host equivalent. Returns the input unchanged
 * when no mount matches — a link to the wrong file is worse than no link.
 */
export function toHostPath(containerPath: string, mappings: PathMapping[]): string {
  for (const { containerRoot, hostRoot } of mappings) {
    if (containerPath === containerRoot) return hostRoot;
    const prefix = containerRoot.endsWith('/') ? containerRoot : `${containerRoot}/`;
    if (containerPath.startsWith(prefix)) {
      return `${hostRoot.replace(/\/$/, '')}/${containerPath.slice(prefix.length)}`;
    }
  }
  return containerPath;
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

/** kdb logs record `line:N`; commits record a sha. Extract a line if present. */
export function lineFromSourceRef(sourceRef?: string): number | undefined {
  const m = sourceRef?.match(/^line:(\d+)$/);
  return m ? Number(m[1]) : undefined;
}
