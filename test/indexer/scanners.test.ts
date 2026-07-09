import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  discoverProjects,
  listDocFiles,
  listKdbFiles,
} from '../../packages/indexer/src/scanners.js';

const root = mkdtempSync(join(tmpdir(), 'kdbscope-scan-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Layout mirrors the real __CODING NEW structure.
mkdirSync(join(root, 'DeepCast/kdb/components'), { recursive: true });
mkdirSync(join(root, 'DeepCast/.git'), { recursive: true });
mkdirSync(join(root, 'DeepCast/Lycos/kdb'), { recursive: true });
mkdirSync(join(root, 'GitOnly/.git'), { recursive: true });
mkdirSync(join(root, 'JustFiles'), { recursive: true });
mkdirSync(join(root, 'node_modules/evil'), { recursive: true });
writeFileSync(join(root, 'DeepCast/kdb/changelog.log'), 'x');
writeFileSync(join(root, 'DeepCast/kdb/session.log'), 'x');
writeFileSync(join(root, 'DeepCast/kdb/backlog.log'), 'x');
writeFileSync(join(root, 'DeepCast/kdb/changelog.md'), 'generated view');
writeFileSync(join(root, 'DeepCast/kdb/CRITICAL_REPORT_2025.md'), 'loose report');
writeFileSync(join(root, 'DeepCast/kdb/components/worker.log'), 'x');
writeFileSync(join(root, 'DeepCast/kdb/components/worker.md'), 'generated view');
writeFileSync(join(root, 'DeepCast/README.md'), 'readme');
mkdirSync(join(root, 'DeepCast/docs/adr'), { recursive: true });
writeFileSync(join(root, 'DeepCast/docs/adr/20260101-x.md'), 'adr');
mkdirSync(join(root, 'DeepCast/node_modules/pkg'), { recursive: true });
writeFileSync(join(root, 'DeepCast/node_modules/pkg/README.md'), 'ignore me');

describe('discoverProjects', () => {
  it('finds kdb and git projects, including nested kdb projects', () => {
    const projects = discoverProjects([{ container: root }]);
    const slugs = projects.map((p) => p.slug).sort();
    expect(slugs).toEqual(['deepcast', 'deepcast-lycos', 'gitonly']);
    const dc = projects.find((p) => p.slug === 'deepcast')!;
    expect(dc.hasKdb).toBe(true);
    expect(projects.find((p) => p.slug === 'gitonly')!.hasKdb).toBe(false);
  });

  /**
   * Claude Code encodes a session's *host* cwd into its directory name, so
   * every project must carry the host path alongside its container path.
   */
  it('maps each project to its host path', () => {
    const projects = discoverProjects([{ container: root, host: '/Users/x/Code' }]);
    expect(projects.find((p) => p.slug === 'deepcast')!.hostPath).toBe('/Users/x/Code/DeepCast');
    expect(projects.find((p) => p.slug === 'deepcast-lycos')!.hostPath).toBe(
      '/Users/x/Code/DeepCast/Lycos',
    );
  });

  it('leaves hostPath undefined when a root has no host mapping', () => {
    expect(discoverProjects([{ container: root }])[0]!.hostPath).toBeUndefined();
  });

  it('scans several roots and does not duplicate a repeated project name', () => {
    const projects = discoverProjects([{ container: root }, { container: root }]);
    expect(projects.filter((p) => p.slug === 'deepcast')).toHaveLength(1);
  });

  it('tolerates a root that does not exist', () => {
    const projects = discoverProjects([{ container: root }, { container: '/no/such/root' }]);
    expect(projects.length).toBeGreaterThan(0);
  });
});

describe('listKdbFiles', () => {
  it('lists logs + loose reports, skips generated md views', () => {
    const files = listKdbFiles(join(root, 'DeepCast'));
    const byType = Object.groupBy(files, (f) => f.sourceType);
    expect(byType.kdb_changelog).toHaveLength(1);
    expect(byType.kdb_session).toHaveLength(1);
    expect(byType.kdb_backlog).toHaveLength(1);
    expect(byType.kdb_component).toHaveLength(1);
    expect(byType.kdb_component![0]!.component).toBe('worker');
    expect(byType.kdb_report).toHaveLength(1);
    expect(byType.kdb_report![0]!.path).toContain('CRITICAL_REPORT');
    // changelog.md (generated view) and components/worker.md must be absent.
    expect(files.some((f) => f.path.endsWith('.md') && f.path.includes('changelog'))).toBe(false);
  });
});

describe('listDocFiles', () => {
  it('collects root md + docs tree, ignores node_modules', () => {
    const files = listDocFiles(join(root, 'DeepCast'));
    expect(files.some((f) => f.endsWith('README.md'))).toBe(true);
    expect(files.some((f) => f.includes('docs/adr'))).toBe(true);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });
});
