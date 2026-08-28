import type { Catalog } from './catalog.js';
import type { SearchService } from './search.js';
import { fileIdf, fileSimilarity, isStopFile, sharedFiles } from './sessionFiles.js';
import {
  RELATED_SUBSTANCE_FLOOR,
  aggregateMatchScores,
  kindWeight,
  substancePrior,
} from './sessionRanking.js';
import { cardFacts, substanceOf } from './sessionSearch.js';
import type { MatchReason, SessionCard, SessionRowFull, SourceType } from './types.js';

/**
 * Related sessions: "what else worked on this, before and after?"
 *
 * The question is about a *topic*, not a conversation, and the honest answer
 * has to come from more than one kind of evidence — because the corpus makes
 * every single signal insufficient on its own:
 *
 *   - **files** are the strongest signal and only 28% of sessions have any;
 *   - **semantics** cover the rest, but the median session holds three
 *     messages, which is barely enough text to embed;
 *   - **time** always exists and proves nothing by itself.
 *
 * So all three run, each contributes only when it is available, and the score
 * is renormalised over the legs that actually fired. A fixed denominator would
 * systematically bury the 72% of sessions with no files — punishing them for
 * missing data rather than for being unrelated.
 *
 * Every result says which legs produced it. "We only had timestamps to go on"
 * is a real answer and must never be disguised as similarity.
 */

export type RelatedLeg = 'file' | 'semantic' | 'temporal';
export type RelatedDirection = 'before' | 'after' | 'overlapping';

export interface RelatedSession extends SessionCard {
  direction: RelatedDirection;
  /** Signed milliseconds from the anchor's start to this session's start. */
  deltaMs: number;
  /** Per-leg contributions, so a score can be argued with. */
  legs: { file: number; semantic: number; temporal: number };
  /** Normalised paths both sessions touched, most identifying first. */
  sharedFiles: string[];
}

/** A commit or kdb line that touched the same files — context, not a session. */
export interface ContextEvent {
  entryId: number;
  sourceType: SourceType;
  title: string;
  occurredAt?: string;
  sourceRef?: string;
  projectSlug: string;
  sharedFiles: string[];
}

export interface RelatedResult {
  anchor: SessionCard;
  related: RelatedSession[];
  /** Which legs produced any candidate at all. */
  basis: RelatedLeg[];
  contextEvents?: ContextEvent[];
  tookMs: number;
  note?: string;
}

export interface RelatedOptions {
  limit?: number;
  direction?: 'before' | 'after' | 'both';
  /** Allow neighbours from other projects (a fix often spans repos). */
  crossProject?: boolean;
  /** Also compute commits/kdb entries touching the same files. */
  context?: boolean;
  /** Temporal candidate half-window, days. */
  windowDays?: number;
  nowMs?: number;
}

/**
 * Leg weights — the most a single leg can contribute on its own.
 *
 * Files outrank semantics because a shared file is evidence of what a session
 * *did*, while semantic similarity is evidence of what it *talked about*, and
 * the corpus is full of sessions that discuss the same subject without ever
 * being the same work. Time is a tiebreak and nothing more: everything in the
 * candidate set is already temporally plausible, so letting proximity carry
 * real weight would rank "happened the same afternoon" as "about the same
 * thing", which is exactly the false positive this feature must not produce.
 *
 * Read as ceilings, not as shares: under the soft-OR combination below, a
 * perfect file match alone reaches 0.55, a perfect subject match alone 0.4,
 * and the two together 0.73 — evidence accumulates rather than being averaged.
 */
const LEG_WEIGHTS: Record<RelatedLeg, number> = { file: 0.55, semantic: 0.4, temporal: 0.05 };

const DEFAULT_WINDOW_DAYS = 14;
const FILE_CANDIDATES = 150;
const SEMANTIC_POOL = 200;
const TEMPORAL_CANDIDATES = 150;
/** Chars of anchor text used to build the semantic probe. */
const PROBE_BUDGET = 1200;

export class SessionRelatedService {
  constructor(
    private catalog: Catalog,
    private search: SearchService,
  ) {}

  async related(sessionId: string, opts: RelatedOptions = {}): Promise<RelatedResult | null> {
    const t0 = Date.now();
    const [anchorRow] = await this.catalog.sessionRows([sessionId]);
    if (!anchorRow) return null;

    const limit = Math.min(Math.max(opts.limit ?? 12, 1), 50);
    const windowDays = Math.min(Math.max(opts.windowDays ?? DEFAULT_WINDOW_DAYS, 1), 365);

    const anchorFiles = (await this.catalog.sessionFilesFor([sessionId])).get(sessionId) ?? [];
    const basis: RelatedLeg[] = [];

    // --- leg 1: files ------------------------------------------------------
    // Stop-files are excluded from CANDIDATE GENERATION only. `Makefile` is in
    // 131 sessions here; letting it generate candidates would drag most of the
    // corpus in before any scoring could reject it. It still contributes its
    // (small) IDF weight when a candidate found another way is scored, so no
    // evidence is thrown away — only the fan-out is bounded.
    const { df, total: filesCorpus } = await this.catalog.fileDocumentFrequency(anchorFiles);
    const idfOf = (p: string) => fileIdf(df.get(p) ?? 1, Math.max(filesCorpus, 1));
    const generating = anchorFiles.filter((p) => !isStopFile(df.get(p) ?? 0, filesCorpus));
    const fileCandidates = generating.length
      ? await this.catalog.sessionsSharingFiles(generating, {
          exclude: sessionId,
          maxDf: Math.max(Math.round(filesCorpus * 0.05), 1),
          limit: FILE_CANDIDATES,
        })
      : [];
    if (fileCandidates.length) basis.push('file');

    // --- leg 2: semantics --------------------------------------------------
    const probe = await this.buildProbe(anchorRow);
    const semantic = new Map<string, number>();
    if (probe) {
      const res = await this.search
        .search(
          probe,
          {
            sourceTypes: ['claude_session'],
            ...(opts.crossProject === false ? { projects: [anchorRow.projectSlug] } : {}),
          },
          SEMANTIC_POOL,
          { maxFetch: SEMANTIC_POOL },
        )
        .catch(() => null);
      const grouped = new Map<string, number[]>();
      for (const h of res?.hits ?? []) {
        if (!h.sessionId || h.sessionId === sessionId) continue;
        const list = grouped.get(h.sessionId) ?? [];
        list.push(h.score * kindWeight(h.kind));
        grouped.set(h.sessionId, list);
      }
      for (const [id, scores] of grouped) semantic.set(id, aggregateMatchScores(scores));
      if (semantic.size) basis.push('semantic');
    }

    // --- leg 3: time -------------------------------------------------------
    const anchorStart = anchorRow.startedAt ? Date.parse(anchorRow.startedAt) : NaN;
    let temporalIds: string[] = [];
    if (Number.isFinite(anchorStart)) {
      const half = windowDays * 24 * 3600_000;
      temporalIds = await this.catalog.sessionsInWindow(
        anchorRow.projectId,
        new Date(anchorStart - half).toISOString(),
        new Date(anchorStart + half).toISOString(),
        { exclude: sessionId, limit: TEMPORAL_CANDIDATES },
      );
      if (temporalIds.length) basis.push('temporal');
    }

    const candidateIds = [
      ...new Set([...fileCandidates.map((c) => c.sessionId), ...semantic.keys(), ...temporalIds]),
    ].filter((id) => id !== sessionId);

    const anchorSubstance = substanceOf(anchorRow);
    const anchor = { ...cardFacts(anchorRow, anchorSubstance), score: 1, why: [], excerpts: [] };

    // Context is computed independently of whether any *session* matched.
    // "No other session touched this, but three commits and a changelog line
    // did" is one of the most useful answers this feature gives, and computing
    // it only on the populated path would suppress it exactly there.
    const contextEvents = opts.context
      ? await this.contextEvents(anchorRow, anchorFiles, idfOf, windowDays).catch(() => [])
      : undefined;

    if (!candidateIds.length) {
      return {
        anchor,
        related: [],
        basis,
        ...(contextEvents ? { contextEvents } : {}),
        tookMs: Date.now() - t0,
        note: contextEvents?.length
          ? 'No other session shares this one\'s files, subject or time window — but the commits and log entries below touched the same files.'
          : 'No other session shares this one\'s files, subject or time window.',
      };
    }

    const rows = await this.catalog.sessionRows(candidateIds);
    const filesByCandidate = await this.catalog.sessionFilesFor(candidateIds);

    // Candidate paths need their own document frequencies: a file the anchor
    // never touched still needs a weight when it appears on the candidate side
    // of the cosine denominator.
    const candidatePaths = [...new Set([...filesByCandidate.values()].flat())];
    const { df: dfAll } = await this.catalog.fileDocumentFrequency([
      ...candidatePaths,
      ...anchorFiles,
    ]);
    const idfAll = (p: string) => fileIdf(dfAll.get(p) ?? df.get(p) ?? 1, Math.max(filesCorpus, 1));

    // Normalising semantic scores against the best one in this candidate set
    // keeps the leg comparable to file similarity, which is already in [0,1].
    // Absolute hybrid scores are not on any interpretable scale.
    const semMax = Math.max(0, ...semantic.values());

    const out: RelatedSession[] = [];
    for (const row of rows) {
      if (opts.crossProject === false && row.projectSlug !== anchorRow.projectSlug) continue;
      const candFiles = filesByCandidate.get(row.sessionId) ?? [];

      const legs = {
        file: anchorFiles.length && candFiles.length ? fileSimilarity(anchorFiles, candFiles, idfAll) : 0,
        semantic: semMax > 0 ? (semantic.get(row.sessionId) ?? 0) / semMax : 0,
        temporal: temporalScore(anchorStart, row.startedAt, windowDays),
      };

      // Combine the legs as a soft OR (noisy-OR), NOT as a weighted mean.
      //
      // Each leg is evidence FOR relatedness; none is evidence against. A
      // weighted mean gets this backwards, and the failure was visible on the
      // first real query: a 3-message session with no files outranked a
      // 502-message session that shared two files, because the heavy session's
      // weak-but-real file score was averaged IN while the trivial one simply
      // had no file term to dilute it. Having evidence made it score worse than
      // having none.
      //
      // Under a soft OR a leg with nothing to say contributes nothing, a weak
      // signal adds a little, and signals accumulate: `1 - Π(1 - w·leg)`.
      // Monotone in every leg, bounded in [0,1), and it cannot punish a
      // candidate for being measurable.
      const base =
        1 -
        (['file', 'semantic', 'temporal'] as RelatedLeg[]).reduce(
          (acc, leg) => acc * (1 - LEG_WEIGHTS[leg] * Math.min(Math.max(legs[leg], 0), 1)),
          1,
        );
      if (base <= 0) continue;

      const substance = substanceOf(row);
      const shared = sharedFiles(anchorFiles, candFiles, idfAll);
      const deltaMs = row.startedAt && Number.isFinite(anchorStart)
        ? Date.parse(row.startedAt) - anchorStart
        : 0;

      out.push({
        ...cardFacts(row, substance),
        // A lower floor than search uses: nobody asked for this session, so a
        // trivial one proposed as "related work" is a false positive the reader
        // has to rule out by hand.
        score: base * substancePrior(substance, RELATED_SUBSTANCE_FLOOR),
        why: relatedWhy(legs, shared, deltaMs),
        excerpts: [],
        direction: directionOf(anchorRow, row),
        deltaMs,
        legs,
        sharedFiles: shared,
      });
    }

    const wanted =
      opts.direction === 'before'
        ? out.filter((r) => r.direction !== 'after')
        : opts.direction === 'after'
          ? out.filter((r) => r.direction !== 'before')
          : out;
    wanted.sort((a, b) => b.score - a.score);
    const related = wanted.slice(0, limit);

    return {
      anchor,
      related,
      basis,
      ...(contextEvents ? { contextEvents } : {}),
      tookMs: Date.now() - t0,
      ...(basis.length === 1 && basis[0] === 'temporal'
        ? {
            note:
              'Only timestamps were usable here — this session records no files and too ' +
              'little text to compare. Treat these as "what else was happening", not as related work.',
          }
        : {}),
    };
  }

  /**
   * Text that stands for what this session was about.
   *
   * Distilled prose first (`insight`/`summary`/`plan` — 9,075 entries in the
   * whole corpus, and precisely the parts worth comparing), then the user's own
   * prompts, then the title. The ladder matters because the median session has
   * three messages: for most of the corpus the title and one prompt is all
   * there is, and a probe built only from insights would return nothing at all.
   */
  private async buildProbe(row: SessionRowFull): Promise<string> {
    const parts: string[] = [];
    if (row.title) parts.push(row.title);
    const distilled = await this.catalog
      .sessionEntriesByKind(row.sessionId, ['insight', 'summary', 'plan'], 6)
      .catch(() => []);
    for (const e of distilled) parts.push(e.body);
    if (joined(parts).length < 200) {
      const prompts = await this.catalog
        .sessionEntriesByKind(row.sessionId, ['prompt'], 4)
        .catch(() => []);
      for (const e of prompts) parts.push(e.body);
    }
    return joined(parts).slice(0, PROBE_BUDGET);
  }

  /**
   * Commits and kdb lines that touched the same files.
   *
   * "What other work was done on this thing" is often recorded in a changelog
   * or a commit rather than in another session — which is the join only Atlas
   * can make, since it holds all four sources. `git_commit` entries already
   * carry their changed paths in `meta.files` (see parsers/gitLog.ts), so this
   * costs one bounded window query and an in-memory filter, with no new index.
   */
  private async contextEvents(
    anchor: SessionRowFull,
    anchorFiles: string[],
    idfOf: (p: string) => number,
    windowDays: number,
  ): Promise<ContextEvent[]> {
    if (!anchorFiles.length || !anchor.startedAt) return [];
    const start = Date.parse(anchor.startedAt);
    if (!Number.isFinite(start)) return [];
    const half = windowDays * 24 * 3600_000;
    const rows = await this.catalog.entriesInWindow(
      anchor.projectId,
      new Date(start - half).toISOString(),
      new Date(start + half).toISOString(),
      ['git_commit', 'kdb_changelog', 'kdb_component'],
      200,
    );
    const wanted = new Set(anchorFiles);
    const norm = this.catalog.normalizeFiles.bind(this.catalog);
    const events: ContextEvent[] = [];
    for (const row of rows) {
      const files: string[] = Array.isArray(row.meta?.files) ? row.meta.files : [];
      if (!files.length) continue;
      const shared = (await norm(files)).filter((p) => wanted.has(p));
      if (!shared.length) continue;
      events.push({
        entryId: row.id,
        sourceType: row.sourceType,
        title: row.title,
        occurredAt: row.occurredAt,
        sourceRef: row.sourceRef,
        projectSlug: anchor.projectSlug,
        sharedFiles: shared.sort((a, b) => idfOf(b) - idfOf(a)).slice(0, 5),
      });
    }
    return events;
  }
}

function joined(parts: string[]): string {
  return parts.filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
}

/**
 * Temporal closeness, decaying to 0 at the edge of the candidate window.
 *
 * Linear, not exponential: this is a tiebreak, and an exponential would make
 * "twenty minutes later" dramatically outrank "two days later" in a way the
 * evidence does not support.
 */
export function temporalScore(anchorStart: number, otherStart: string | undefined, windowDays: number): number {
  if (!Number.isFinite(anchorStart) || !otherStart) return 0;
  const t = Date.parse(otherStart);
  if (!Number.isFinite(t)) return 0;
  const span = windowDays * 24 * 3600_000;
  return Math.max(0, 1 - Math.abs(t - anchorStart) / span);
}

export function directionOf(anchor: SessionRowFull, other: SessionRowFull): RelatedDirection {
  const aStart = anchor.startedAt ? Date.parse(anchor.startedAt) : NaN;
  const aEnd = anchor.endedAt ? Date.parse(anchor.endedAt) : aStart;
  const bStart = other.startedAt ? Date.parse(other.startedAt) : NaN;
  const bEnd = other.endedAt ? Date.parse(other.endedAt) : bStart;
  if (!Number.isFinite(aStart) || !Number.isFinite(bStart)) return 'overlapping';
  if (bEnd < aStart) return 'before';
  if (bStart > aEnd) return 'after';
  return 'overlapping';
}

/**
 * Phrase the evidence, strongest first.
 *
 * Named files rather than a count: "shares packages/core/src/ask.ts" is
 * checkable, "shares 3 files" is a number you have to trust.
 */
export function relatedWhy(
  legs: { file: number; semantic: number; temporal: number },
  shared: string[],
  deltaMs: number,
): MatchReason[] {
  const why: MatchReason[] = [];
  if (legs.file > 0 && shared.length) {
    const head = shared.slice(0, 2).join(', ');
    why.push({
      kind: 'file',
      detail:
        shared.length > 2 ? `shares ${head} and ${shared.length - 2} more` : `shares ${head}`,
      weight: legs.file,
    });
  }
  if (legs.semantic > 0) {
    why.push({ kind: 'semantic', detail: 'discusses the same subject', weight: legs.semantic });
  }
  if (legs.temporal > 0) {
    why.push({ kind: 'time', detail: describeDelta(deltaMs), weight: legs.temporal });
  }
  return why.sort((a, b) => b.weight - a.weight);
}

export function describeDelta(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const when = deltaMs >= 0 ? 'later' : 'earlier';
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return 'at the same time';
  if (mins < 60) return `${mins} min ${when}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ${when}`;
  return `${Math.round(hours / 24)} d ${when}`;
}
