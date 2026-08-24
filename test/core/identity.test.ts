import { describe, expect, it } from 'vitest';
import { Catalog, applyIdentity, assignOccurrenceOrdinals, identityFromStored, distillClaudeJsonl, parseGitLog, parseMarkdownDoc, transcriptIdentityPath } from '@atlas/core';
import { parseChangelog } from '@atlas/core'; // exported via parsers barrel; check index.ts
import type { Entry } from '@atlas/core';

const CTX = { projectSlug: 'kdb', sourcePath: '/data/code/kdb/kdb/changelog.log' };

describe('v3 identity', () => {
  it('kdb lines: same content at different paths/lines → same key (cross-machine dedup)', () => {
    const line = '- [DONE] - [2026-08-01 10:00 UTC] - [Fix] - [core] - [thing happened]';
    const a = parseChangelog(`${line}\n`, CTX);
    const b = parseChangelog(`- [DONE] - [2026-07-01] - [Other] - [x] - [padding]\n${line}\n`,
      { ...CTX, sourcePath: '/data/remote/m4max/code1/kdb/kdb/changelog.log' });
    applyIdentity(a, { rootPath: '/data/code/kdb' });
    applyIdentity(b, { rootPath: '/data/remote/m4max/code1/kdb' });
    assignOccurrenceOrdinals(a); assignOccurrenceOrdinals(b);
    expect(Catalog.dedupKey(a[0]!)).toBe(Catalog.dedupKey(b[1]!));   // same line, shifted position
    expect(Catalog.dedupKey(b[0]!)).not.toBe(Catalog.dedupKey(b[1]!));
  });

  it('identical lines get distinct ordinals, stable under reordering', () => {
    const dup = '- [INFO] - [2026-08-01] - [Note] - [x] - [same text]';
    const es = parseChangelog(`${dup}\n${dup}\n`, CTX);
    applyIdentity(es, { rootPath: '/data/code/kdb' });
    assignOccurrenceOrdinals(es);
    expect(es[0]!.identity!.ref).toBe('occ:1');
    expect(es[1]!.identity!.ref).toBe('occ:2');
  });

  it('claude entries: scope is "claude", slug-independent', () => {
    const e = { projectSlug: 'ghost-users-nasta-kdb', sourceType: 'claude_session' as const, title: 't', body: 'b',
      sourcePath: '/data/remote/m4max/claude/-Users-nasta---CODING-NEW-kdb/abc.jsonl' };
    const f = { ...e, projectSlug: 'kdb', sourcePath: '/data/claude/projects/-Users-nasta---CODING-NEW-kdb/abc.jsonl' };
    applyIdentity([e], { claudeRoot: '/data/remote/m4max/claude' });
    applyIdentity([f], { claudeRoot: '/data/claude/projects' });
    expect(Catalog.dedupKey(e)).toBe(Catalog.dedupKey(f));   // mirrored copy dedups
  });

  it('git: scope keeps the slug — same sha in two projects stays distinct', () => {
    const mk = (slug: string) => ({ projectSlug: slug, sourceType: 'git_commit' as const, title: 'init', body: 'init',
      sourcePath: `/data/code/${slug}`, sourceRef: 'abc123' });
    const [a, b] = [mk('fork-a'), mk('fork-b')];
    applyIdentity([a], { rootPath: '/data/code/fork-a' });
    applyIdentity([b], { rootPath: '/data/code/fork-b' });
    expect(Catalog.dedupKey(a)).not.toBe(Catalog.dedupKey(b));
  });

  it('no known root → stored-path fallback, never a throw', () => {
    const e: Entry = { projectSlug: 'x', sourceType: 'doc', title: 't', body: 'b', sourcePath: '/weird/path.md' };
    applyIdentity([e], { rootPath: '/data/code/other' });
    expect(e.identity!.path).toBe('/weird/path.md');
  });

  it('identityFromStored agrees with applyIdentity on every source type', () => {
    // kdb line: live parse → applyIdentity → same fields through identityFromStored.
    const kdbLine = '- [DONE] - [2026-08-01 10:00 UTC] - [Fix] - [core] - [agreement check]';
    const kdbEntries = parseChangelog(`${kdbLine}\n`, CTX);
    applyIdentity(kdbEntries, { rootPath: '/data/code/kdb' });
    const kdbEntry = kdbEntries[0]!;
    // Pin the actual expected value — the agreement check below only proves
    // the two twins match each other, not that either is right.
    expect(kdbEntry.identity).toEqual({ scope: 'kdb', path: 'kdb/changelog.log', ref: 'line:1' });
    expect(
      identityFromStored(
        {
          source_type: kdbEntry.sourceType,
          source_path: kdbEntry.sourcePath,
          source_ref: kdbEntry.sourceRef ?? null,
          title: kdbEntry.title,
          body: kdbEntry.body,
        },
        'kdb',
        ['/data/code/kdb'],
        [],
      ),
    ).toEqual(kdbEntry.identity);

    // doc with an anchor sourceRef.
    const docBody =
      'Enough characters in this section to clear the eighty character minimum '
      + 'length filter that parseMarkdownDoc applies before keeping a section.';
    const docText = `# readme\n\n## Anchor Section\n\n${docBody}\n`;
    const docCtx = { projectSlug: 'kdb', sourcePath: '/data/code/kdb/docs/readme.md' };
    const docEntries = parseMarkdownDoc(docText, docCtx);
    applyIdentity(docEntries, { rootPath: '/data/code/kdb' });
    const docEntry = docEntries.find((e) => e.sourceRef === '#anchor-section')!;
    expect(docEntry).toBeDefined();
    expect(docEntry.identity).toEqual({ scope: 'kdb', path: 'docs/readme.md', ref: '#anchor-section' });
    expect(
      identityFromStored(
        {
          source_type: docEntry.sourceType,
          source_path: docEntry.sourcePath,
          source_ref: docEntry.sourceRef ?? null,
          title: docEntry.title,
          body: docEntry.body,
        },
        'kdb',
        ['/data/code/kdb'],
        [],
      ),
    ).toEqual(docEntry.identity);

    // git commit.
    const gitRaw =
      '\x01abc123def456\x1f2026-08-01T10:00:00Z\x1fserge\x1fFix the thing\n'
      + 'M\tfile.ts\n';
    const gitEntries = parseGitLog(gitRaw, { projectSlug: 'kdb', repoPath: '/data/code/kdb' });
    applyIdentity(gitEntries, { rootPath: '/data/code/kdb' });
    const gitEntry = gitEntries[0]!;
    expect(gitEntry.identity).toEqual({ scope: 'kdb', path: '.', ref: 'abc123def456' });
    expect(
      identityFromStored(
        {
          source_type: gitEntry.sourceType,
          source_path: gitEntry.sourcePath,
          source_ref: gitEntry.sourceRef ?? null,
          title: gitEntry.title,
          body: gitEntry.body,
        },
        'kdb',
        ['/data/code/kdb'],
        [],
      ),
    ).toEqual(gitEntry.identity);

    // claude entry.
    const claudeSourcePath = '/data/claude/projects/-Users-nasta---CODING-NEW-kdb/abc123.jsonl';
    const { entries: claudeEntries } = distillClaudeJsonl(
      [JSON.stringify({
        type: 'user',
        timestamp: '2026-08-01T10:00:00Z',
        message: { content: 'agreement check prompt' },
      })],
      { projectSlug: 'kdb', sourcePath: claudeSourcePath, sessionId: 'abc123' },
    );
    applyIdentity(claudeEntries, {});
    const claudeEntry = claudeEntries[0]!;
    expect(claudeEntry.identity).toEqual({
      scope: 'claude',
      path: 'abc123.jsonl',
      ref: '',
    });
    expect(
      identityFromStored(
        {
          source_type: claudeEntry.sourceType,
          source_path: claudeEntry.sourcePath,
          source_ref: claudeEntry.sourceRef ?? null,
          title: claudeEntry.title,
          body: claudeEntry.body,
        },
        'kdb',
        [],
        ['/data/claude/projects'],
      ),
    ).toEqual(claudeEntry.identity);
  });

  it('relativeTo: a trailing-slash root still resolves the repo root to "."', () => {
    // Every git commit hits sourcePath === repoPath — a naive prefix check
    // ('/repo/' vs '/repo') would demote it to the full absolute path instead.
    const e: Entry = {
      projectSlug: 'kdb', sourceType: 'git_commit', title: 'init', body: 'init',
      sourcePath: '/data/code/kdb', sourceRef: 'sha1',
    };
    applyIdentity([e], { rootPath: '/data/code/kdb/' });
    expect(e.identity).toEqual({ scope: 'kdb', path: '.', ref: 'sha1' });
  });

  it('relativeTo: an empty root falls back to the full stored path', () => {
    const e: Entry = { projectSlug: 'x', sourceType: 'doc', title: 't', body: 'b', sourcePath: '/weird/path.md' };
    applyIdentity([e], { rootPath: '' });
    expect(e.identity).toEqual({ scope: 'x', path: '/weird/path.md', ref: '' });
  });

  it('identityFromStored: an empty root (ghost project) never de-slashes the stored path', () => {
    // A ghost project's root_path is '' — the naive `${root}/` prefix was
    // '/', which every absolute path starts with, so '/weird/path.md' would
    // silently become 'weird/path.md': a de-slashed string that can collide
    // with a genuinely relative stored path (§6.3's no-false-collision rule).
    const id = identityFromStored(
      { source_type: 'doc', source_path: '/weird/path.md', source_ref: null, title: 't', body: 'b' },
      'ghost-project',
      [''],
      [],
    );
    expect(id).toEqual({ scope: 'ghost-project', path: '/weird/path.md', ref: '' });
  });

  it('ordinals: dedup key multiset is stable under reordering of identical lines (interleaved re-scan)', () => {
    // Simulates a git merge interleaving two machines' append-only tails:
    // relative order among duplicates of the SAME line is preserved even
    // when unrelated lines land between them, so ordinals — and therefore
    // dedup keys — must not depend on absolute position.
    const lineA = '- [DONE] - [2026-08-01] - [Fix] - [core] - [reorder case A]';
    const lineB = '- [DONE] - [2026-08-02] - [Fix] - [core] - [reorder case B]';
    const orderABA = parseChangelog(`${lineA}\n${lineB}\n${lineA}\n`, CTX);
    const orderBAA = parseChangelog(`${lineB}\n${lineA}\n${lineA}\n`, CTX);
    applyIdentity(orderABA, { rootPath: '/data/code/kdb' });
    applyIdentity(orderBAA, { rootPath: '/data/code/kdb' });
    assignOccurrenceOrdinals(orderABA);
    assignOccurrenceOrdinals(orderBAA);
    const keysABA = orderABA.map((e) => Catalog.dedupKey(e)).sort();
    const keysBAA = orderBAA.map((e) => Catalog.dedupKey(e)).sort();
    expect(keysABA).toEqual(keysBAA);
  });
});

/**
 * The 2026-08-24 host migration renamed every transcript directory
 * (`-Users-nasta---CODING-NEW-DeepCast` → `-Users-serge--CODING-DeepCast`) and
 * a key that included the directory re-indexed 347k rows as new. Identity
 * must not notice a rename — on the scan side or the migration side.
 */
describe('transcript identity survives a renamed transcripts directory', () => {
  const root = '/data/claude/projects';
  const file = '74701c4c-3684-4878-bffc-d3499fe76f4d.jsonl';
  const mk = (dir: string, over: Partial<Entry> = {}): Entry => ({
    projectSlug: 'deepcast',
    sourceType: 'claude_session',
    sessionId: file.replace('.jsonl', ''),
    title: 'Insight: something',
    body: 'the body',
    sourcePath: `${root}/${dir}/${file}`,
    ...over,
  });

  it('applyIdentity: same file under old and new directory names → same key', () => {
    const before = mk('-Users-nasta---CODING-NEW-DeepCast');
    const after = mk('-Users-serge--CODING-DeepCast', { projectSlug: 'users-nasta-coding-new-deepcast' });
    applyIdentity([before, after], { claudeRoot: root });
    expect(before.identity).toEqual({ scope: 'claude', path: file, ref: '' });
    expect(Catalog.dedupKey(after)).toBe(Catalog.dedupKey(before));
  });

  it('identityFromStored: the stored old-name row and the freshly scanned new-name entry agree', () => {
    const stored = identityFromStored(
      { source_type: 'claude_session', source_path: `${root}/-Users-nasta---CODING-NEW-DeepCast/${file}`, source_ref: null, title: 't', body: 'b' },
      'deepcast', ['/data/code/DeepCast'], [root],
    );
    const fresh = mk('-Users-serge--CODING-DeepCast');
    applyIdentity([fresh], { claudeRoot: root });
    expect(stored).toEqual(fresh.identity);
  });

  it('keeps nested files distinct from the top-level one and different sessions apart', () => {
    const top = mk('-Users-serge--CODING-DeepCast');
    const nested = mk('-Users-serge--CODING-DeepCast', { sourcePath: `${root}/-Users-serge--CODING-DeepCast/sub/${file}` });
    const other = mk('-Users-serge--CODING-DeepCast', { sourcePath: `${root}/-Users-serge--CODING-DeepCast/other.jsonl` });
    applyIdentity([top, nested, other], { claudeRoot: root });
    expect(new Set([top, nested, other].map((e) => Catalog.dedupKey(e))).size).toBe(3);
  });

  it('a mirror root works the same way, and an unknown root keeps the full path', () => {
    const mirror = '/data/remote_mirror/m4max/claude';
    const e = mk('-Users-serge--CODING-DeepCast', { sourcePath: `${mirror}/-Users-serge--CODING-DeepCast/${file}` });
    applyIdentity([e], { claudeRoot: mirror });
    expect(e.identity!.path).toBe(file);
    expect(transcriptIdentityPath('/elsewhere/x/y.jsonl', root)).toBe('/elsewhere/x/y.jsonl');
  });
});
