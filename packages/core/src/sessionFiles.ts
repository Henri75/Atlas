/**
 * Session file identity: turning the absolute paths a transcript recorded into
 * keys that are comparable across machines, users and checkouts.
 *
 * Why this module exists at all. `sessions.files_touched` holds paths exactly
 * as Claude Code wrote them, which means they carry the home directory, user
 * name and checkout location of whatever machine the session ran on. Measured
 * on this index (2026-08-28), the most frequently touched files in the whole
 * corpus are
 *
 *     /Users/nasta/__CODING NEW/DeepCast/Makefile          131 sessions
 *     /Users/nasta/.claude/projects/…/memory/MEMORY.md     183 sessions
 *
 * — paths belonging to a machine and user that no longer exist here. Comparing
 * raw strings therefore scores ZERO overlap between a session from that era and
 * one from today, on the same file of the same repository. Normalisation is not
 * a refinement of the file signal; without it the file signal does not work.
 *
 * The second job here is inverse document frequency. `Makefile`, `CLAUDE.md`
 * and `package.json` are touched by hundreds of unrelated sessions; a raw
 * overlap count would make every session look related to every other. Weighting
 * by IDF is what turns "we both touched a file" into evidence.
 */

/** Everything needed to map an absolute path onto a comparable key. */
export interface NormalizeContext {
  /**
   * Absolute project roots known to the catalog — `projects.root_path` plus
   * every `project_locations.root_path`. Longest match wins, so a nested repo
   * (`…/DeepCast/Lycos`) resolves against itself rather than its parent.
   */
  roots?: string[];
  /**
   * Basenames of those roots (`DeepCast`, `kdb`, `google-gemini-pool`). This is
   * what rescues paths from machines Atlas has never seen: the checkout prefix
   * differs, but the repository directory name does not.
   */
  repoNames?: string[];
}

const HOME_PREFIX = /^\/(?:Users|home|var\/root)\/[^/]+\//;

function segments(p: string): string[] {
  return p.split('/').filter(Boolean);
}

/**
 * Normalise one recorded path to a repo-relative comparison key.
 *
 * The ladder, in order, each step falling through to the next:
 *
 * 1. **Known root prefix.** Longest first, so `…/DeepCast/Lycos/Makefile`
 *    resolves against the Lycos checkout, not DeepCast's.
 * 2. **Known repository name, matched from the RIGHT.** `…/CODING/DeepCast/
 *    Lycos/Makefile` yields `makefile` (Lycos-relative), which is the correct
 *    reading — the rightmost repo segment is the innermost checkout.
 * 3. **`.claude` data files.** These are not repository files at all, and their
 *    directory component encodes a host path that differs per machine. Keyed as
 *    `.claude/<last two segments>`; they are high-frequency and will be damped
 *    by IDF anyway, so precision here buys nothing.
 * 4. **Home-relative.** `/Users/<anyone>/x/y` -> `~/x/y`, which at least
 *    collapses two users' home-relative files onto one key.
 * 5. **Last three segments.** A blunt final fallback that still beats an
 *    absolute path for cross-machine comparison.
 *
 * Case is folded because the corpus spans macOS checkouts of the same repo in
 * differently-cased directories. The result is a comparison key only — never
 * display text, and never something to resolve back to a file.
 */
export function normalizeSessionPath(raw: string, ctx: NormalizeContext = {}): string {
  const path = (raw ?? '').trim();
  if (!path) return '';

  // Relative paths appear in transcripts too and are already repo-relative.
  if (!path.startsWith('/')) return path.replace(/^\.\//, '').toLowerCase();

  const roots = [...(ctx.roots ?? [])]
    .filter(Boolean)
    .map((r) => r.replace(/\/+$/, ''))
    .sort((a, b) => b.length - a.length);
  for (const root of roots) {
    if (path === root) return '';
    if (path.startsWith(`${root}/`)) return path.slice(root.length + 1).toLowerCase();
  }

  const segs = segments(path);

  const names = new Set((ctx.repoNames ?? []).filter(Boolean).map((n) => n.toLowerCase()));
  if (names.size) {
    for (let i = segs.length - 2; i >= 0; i--) {
      if (names.has(segs[i]!.toLowerCase())) return segs.slice(i + 1).join('/').toLowerCase();
    }
  }

  const claudeAt = segs.lastIndexOf('.claude');
  if (claudeAt !== -1) return ['.claude', ...segs.slice(-2)].join('/').toLowerCase();

  if (HOME_PREFIX.test(path)) return `~/${path.replace(HOME_PREFIX, '')}`.toLowerCase();

  return segs.slice(-3).join('/').toLowerCase();
}

/** Normalise a whole list, dropping empties and duplicates, order preserved. */
export function normalizeSessionPaths(raw: string[], ctx: NormalizeContext = {}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of raw ?? []) {
    const key = normalizeSessionPath(p, ctx);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * BM25-shaped inverse document frequency, clamped positive.
 *
 * The `+0.5` smoothing and the `1 +` inside the log are what keep this above
 * zero for a file present in *every* session: a plain `log(N/df)` would hand
 * `Makefile` a weight of exactly 0 and, worse, hand a file in more than half
 * the corpus a NEGATIVE weight, which would let a shared stop-file *reduce*
 * a similarity score below what no overlap at all would score.
 */
export function fileIdf(df: number, total: number): number {
  const n = Math.max(total, 1);
  const d = Math.min(Math.max(df, 0), n);
  return Math.log(1 + (n - d + 0.5) / (d + 0.5));
}

/**
 * Share of the file-bearing corpus above which a file stops generating
 * candidates. 5% of 2,322 file-bearing sessions is ~116, which excludes exactly
 * the observed stop-files (`MEMORY.md` 183, `Makefile` 131) and keeps everything
 * that identifies real work.
 *
 * Candidate *generation* only. A stop-file still contributes its (small) IDF
 * weight when a candidate found by some other route is scored — dropping it from
 * scoring as well would throw away real, if weak, evidence.
 */
export const STOP_FILE_DF_RATIO = 0.05;

export function isStopFile(df: number, total: number, ratio = STOP_FILE_DF_RATIO): boolean {
  return total > 0 && df > Math.max(ratio * total, 1);
}

/**
 * IDF-weighted cosine over two binary file sets, in [0, 1].
 *
 * Cosine rather than Jaccard because session file-set sizes differ by two orders
 * of magnitude in this corpus (median 3, max 265): Jaccard would score a
 * 3-file session against a 265-file session that *contains all three* at 0.011,
 * which reads as unrelated when it is in fact total containment.
 */
export function fileSimilarity(
  a: readonly string[],
  b: readonly string[],
  idfOf: (path: string) => number,
): number {
  if (!a.length || !b.length) return 0;
  const bs = new Set(b);
  let num = 0;
  let na = 0;
  let nb = 0;
  const seenA = new Set<string>();
  for (const p of a) {
    if (seenA.has(p)) continue;
    seenA.add(p);
    const w = idfOf(p);
    na += w * w;
    if (bs.has(p)) num += w * w;
  }
  const seenB = new Set<string>();
  for (const p of b) {
    if (seenB.has(p)) continue;
    seenB.add(p);
    const w = idfOf(p);
    nb += w * w;
  }
  if (na <= 0 || nb <= 0) return 0;
  return num / Math.sqrt(na * nb);
}

/** The shared files between two sets, heaviest (most identifying) first. */
export function sharedFiles(
  a: readonly string[],
  b: readonly string[],
  idfOf: (path: string) => number,
  limit = 8,
): string[] {
  const bs = new Set(b);
  return [...new Set(a)]
    .filter((p) => bs.has(p))
    .sort((x, y) => idfOf(y) - idfOf(x))
    .slice(0, limit);
}
