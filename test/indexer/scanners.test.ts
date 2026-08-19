import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
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

describe('discoverProjects — machine-aware roots', () => {
  const machRoot = mkdtempSync(join(tmpdir(), 'kdbscope-mach-'));
  afterAll(() => rmSync(machRoot, { recursive: true, force: true }));

  const rootA = join(machRoot, 'rootA');
  const rootB = join(machRoot, 'rootB');
  const rootC = join(machRoot, 'rootC');
  mkdirSync(join(rootA, 'Notes/kdb'), { recursive: true });
  mkdirSync(join(rootA, 'Notes/Sub/kdb'), { recursive: true });
  mkdirSync(join(rootB, 'Notes/kdb'), { recursive: true });
  mkdirSync(join(rootC, 'Notes/kdb'), { recursive: true });

  it('tags each discovered project with its root machine, and maps the host path', () => {
    const projects = discoverProjects([
      { container: rootA, host: '/Users/serge/CODING', machine: 'm1' },
    ]);
    const notes = projects.find((p) => p.slug === 'notes')!;
    expect(notes.machine).toBe('m1');
    expect(notes.hostPath).toBe('/Users/serge/CODING/Notes');
  });

  it('applies slugOverrides to a top-level dir but not to a nested project', () => {
    const projects = discoverProjects([
      { container: rootA, slugOverrides: { Notes: 'm1-notes' } },
    ]);
    expect(projects.find((p) => p.name === 'Notes')?.slug).toBe('m1-notes');
    expect(projects.find((p) => p.name === 'Notes/Sub')?.slug).toBe('notes-sub');
  });

  it('keeps both projects when the same slug is discovered on two different machines', () => {
    const projects = discoverProjects([
      { container: rootA, machine: 'm1' },
      { container: rootB, machine: 'm2' },
    ]);
    const notesEntries = projects.filter((p) => p.slug === 'notes');
    expect(notesEntries).toHaveLength(2);
    expect(notesEntries.map((p) => p.machine).sort()).toEqual(['m1', 'm2']);
  });

  it('first-wins and warns once (naming both paths) on the same slug twice on one machine', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const projects = discoverProjects([{ container: rootA }, { container: rootC }]);
    const notesEntries = projects.filter((p) => p.slug === 'notes');
    expect(notesEntries).toHaveLength(1);
    expect(notesEntries[0]!.rootPath).toBe(join(rootA, 'Notes'));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]!.join(' ');
    expect(message).toContain(join(rootA, 'Notes'));
    expect(message).toContain(join(rootC, 'Notes'));
    warnSpy.mockRestore();
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
    const { files, dropped } = listDocFiles(join(root, 'DeepCast'));
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.endsWith('README.md'))).toBe(true);
    expect(paths.some((p) => p.includes('docs/adr'))).toBe(true);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(dropped).toBe(0);
  });

  it('flags archive-style locations, relative to the project root', () => {
    mkdirSync(join(root, 'DeepCast/docs/Previous/archive'), { recursive: true });
    writeFileSync(join(root, 'DeepCast/docs/Previous/archive/old-notes.md'), 'x');
    const { files } = listDocFiles(join(root, 'DeepCast'));
    const flagged = files.find((f) => f.path.includes('Previous/archive'));
    expect(flagged?.archived).toBe(true);
    expect(files.find((f) => f.path.includes('docs/adr'))?.archived).toBe(false);
    // The project root's own name must never trigger the classifier.
    mkdirSync(join(root, 'Old/docs'), { recursive: true });
    writeFileSync(join(root, 'Old/docs/current.md'), 'x');
    expect(listDocFiles(join(root, 'Old')).files[0]!.archived).toBe(false);
  });

  it('reports how many files the cap dropped instead of hiding them', () => {
    mkdirSync(join(root, 'Capped/docs'), { recursive: true });
    for (let i = 0; i < 12; i++) writeFileSync(join(root, `Capped/docs/f${i}.md`), 'x');
    const { files, dropped } = listDocFiles(join(root, 'Capped'), 10);
    expect(files).toHaveLength(10);
    expect(dropped).toBe(2);
  });

  it('walks deeper than the old depth-4 limit', () => {
    mkdirSync(join(root, 'Deep/docs/a/b/c/d/e'), { recursive: true });
    writeFileSync(join(root, 'Deep/docs/a/b/c/d/e/deep.md'), 'x');
    expect(listDocFiles(join(root, 'Deep')).files.some((f) => f.path.endsWith('deep.md'))).toBe(
      true,
    );
  });
});
