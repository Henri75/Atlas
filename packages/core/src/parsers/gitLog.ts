import type { Entry } from '../types.js';

/**
 * Parses the output of:
 *   git log --name-status --pretty=format:'%x01%H%x1f%aI%x1f%an%x1f%s'
 * \x01 marks the start of a commit record; \x1f separates header fields;
 * the commit's name-status lines follow until the next \x01.
 */

export interface GitParseCtx {
  projectSlug: string;
  /** Repo root (used as sourcePath so hits deep-link to the repo). */
  repoPath: string;
}

export const GIT_LOG_FORMAT = '%x01%H%x1f%aI%x1f%an%x1f%s';

const RECORD_SEP = '\x01';
const FIELD_SEP = '\x1f';

export function parseGitLog(raw: string, ctx: GitParseCtx): Entry[] {
  const entries: Entry[] = [];
  for (const record of raw.split(RECORD_SEP)) {
    if (!record.trim()) continue;
    const [head, ...rest] = record.split('\n');
    const [sha, dateIso, author, subject] = head!.split(FIELD_SEP);
    if (!sha || !dateIso) continue;
    const files = rest
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [status, ...paths] = l.split('\t');
        return { status: status ?? '?', path: paths[paths.length - 1] ?? '' };
      })
      .filter((f) => f.path);
    const fileList = files.map((f) => `${f.status} ${f.path}`).join('\n');
    entries.push({
      projectSlug: ctx.projectSlug,
      sourceType: 'git_commit',
      title: subject?.slice(0, 140) || sha.slice(0, 12),
      body: `${subject ?? ''}\n\nAuthor: ${author ?? '?'}\nFiles:\n${fileList}`.trim(),
      occurredAt: dateIso,
      sourcePath: ctx.repoPath,
      sourceRef: sha,
      meta: { files: files.map((f) => f.path).slice(0, 100), author },
    });
  }
  return entries;
}
