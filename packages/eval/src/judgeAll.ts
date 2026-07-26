import { writeFile } from 'node:fs/promises';
import type { EvalConfig } from './config.js';
import { judgeQuery, stratifiedSubsample, type Candidate } from './judge.js';
import { quadraticWeightedKappa, type Grade } from './metrics.js';
import { loadQueries, saveJudgements } from './pools.js';
import { candidatePool } from './retrieve.js';
import { connect, mapLimit } from './services.js';
import { readJudgements } from './run.js';
import type { EvalQuery, JudgeLabel, JudgementFile, QueryClass } from './types.js';

/**
 * The judging pass: pool candidates, grade them, measure agreement, and write out
 * whatever a human still needs to settle.
 *
 * Run explicitly and rarely — it is the only part of the harness that spends
 * money, and re-running it silently would relabel the fixture that every
 * committed baseline is pinned to.
 */

/** Bodies come from the catalog; only ids travel through retrieval. */
async function toCandidates(
  catalog: Awaited<ReturnType<typeof connect>>['catalog'],
  ids: number[],
): Promise<Candidate[]> {
  const rows = await catalog.getEntries(ids);
  const out: Candidate[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    // An id retrieval knows about but the catalog does not is a real integrity
    // signal, not something to paper over — but it must not stall the pass.
    if (!row) continue;
    out.push({
      entryId: id,
      sourceType: row.source_type,
      projectSlug: row.slug,
      ...(row.component ? { component: row.component } : {}),
      ...(row.occurred_at ? { occurredAt: row.occurred_at.toISOString() } : {}),
      title: row.title,
      body: String(row.body),
    });
  }
  return out;
}

export interface JudgeAllOptions {
  topUp: boolean;
  limit?: number;
}

export async function judgeAll(cfg: EvalConfig, opts: JudgeAllOptions): Promise<string> {
  const stack = await connect(cfg);
  try {
    const { queries } = await loadQueries(cfg.fixtures.queries);
    const existing = await readJudgements(cfg);
    const alreadyLabelled = new Set(
      existing.labels.filter((l) => l.judge !== cfg.judge.second).map((l) => `${l.queryId}:${l.entryId}`),
    );

    // Pool A only.
    //
    // Pool B needs no judge — its gold set is the entry each question was written
    // from. Pool N was absence-verified when it was generated, and contributes no
    // ranking metric, so re-grading it here buys a few documentary labels for
    // roughly 40 minutes of judging. Anything promoted out of Pool N by that
    // verification became a Pool A query and is judged as one.
    let targets = queries.filter((q) => q.pool === 'A');
    if (opts.limit) targets = targets.slice(0, opts.limit);

    const labels: JudgeLabel[] = [...existing.labels];
    const unjudged: JudgementFile['unjudged'] = [...existing.unjudged];
    const forKappa: { queryId: string; entryId: number; grade: Grade; cls: QueryClass }[] = [];
    let graded = 0;
    let skipped = 0;

    // Queries are independent, so they run concurrently. Sequentially this took
    // ~3.6 min per query — a full pass measured in hours, dominated by waiting on
    // a reasoning model.
    //
    // Its own concurrency, lower than the retrieval one: at 4 the gateway returned
    // sustained 429s and timeouts, and each pass that exhausted its retry budget
    // left candidates unjudged. Going wider made the fixture thinner, which is the
    // opposite of the trade it looked like.
    let done = 0;
    await mapLimit(targets, cfg.judge.concurrency, async (q) => {
      const { ids, sources } = await candidatePool(stack, cfg, q);
      const pending = opts.topUp ? ids.filter((id) => !alreadyLabelled.has(`${q.id}:${id}`)) : ids;
      if (!pending.length) {
        skipped++;
        return;
      }
      const candidates = await toCandidates(stack.catalog, pending);
      process.stderr.write(
        `[${++done}/${targets.length}] ${q.class} — ${candidates.length} candidates ` +
          `(hybrid ${sources.hybrid.length}, fts ${sources.fts.length}, dense ${sources.dense.length})\n`,
      );

      for (let start = 0; start < candidates.length; start += cfg.judge.batchSize) {
        const batch = candidates.slice(start, start + cfg.judge.batchSize);
        const r = await judgeQuery(
          cfg,
          cfg.judge.primary,
          q.text,
          q.class,
          batch,
          // Seed varies per query and batch so the shuffle is not the same
          // permutation every time, while staying reproducible from the config.
          cfg.seed + start + q.id.length,
        );
        for (const g of r.grades) {
          labels.push({ queryId: q.id, entryId: g.entryId, grade: g.grade, why: g.why, judge: cfg.judge.primary });
          forKappa.push({ queryId: q.id, entryId: g.entryId, grade: g.grade, cls: q.class });
          graded++;
        }
        for (const u of r.unjudged) unjudged.push({ queryId: q.id, entryId: u.entryId, reason: u.reason });
      }
    });
    // Concurrency makes arrival order nondeterministic, and the κ subsample is
    // drawn from this list — so sort before sampling, or the same seed would pick
    // a different subsample on every run and κ would stop being reproducible.
    forKappa.sort((a, b) => a.queryId.localeCompare(b.queryId) || a.entryId - b.entryId);

    // Agreement over a grade-stratified subsample, re-judged by a second model.
    let agreement: JudgementFile['agreement'];
    const sample = stratifiedSubsample(forKappa, cfg.judge.subsampleFraction, cfg.seed);
    if (sample.length >= 8) {
      process.stderr.write(`\nre-judging ${sample.length} labels with ${cfg.judge.second} for agreement…\n`);
      const byQuery = new Map<string, typeof sample>();
      for (const s of sample) {
        const bucket = byQuery.get(s.queryId);
        if (bucket) bucket.push(s);
        else byQuery.set(s.queryId, [s]);
      }
      const primaryGrades: Grade[] = [];
      const secondGrades: Grade[] = [];
      for (const [queryId, items] of byQuery) {
        const q = queries.find((x) => x.id === queryId)!;
        const candidates = await toCandidates(stack.catalog, items.map((x) => x.entryId));
        const r = await judgeQuery(cfg, cfg.judge.second, q.text, q.class, candidates, cfg.seed + q.id.length);
        const secondBy = new Map(r.grades.map((g) => [g.entryId, g.grade]));
        for (const item of items) {
          const second = secondBy.get(item.entryId);
          if (second === undefined) continue;
          primaryGrades.push(item.grade);
          secondGrades.push(second);
          labels.push({
            queryId,
            entryId: item.entryId,
            grade: second,
            why: r.grades.find((g) => g.entryId === item.entryId)?.why ?? '',
            judge: cfg.judge.second,
          });
        }
      }
      agreement = {
        ...quadraticWeightedKappa(primaryGrades, secondGrades),
        subsampleFraction: cfg.judge.subsampleFraction,
      };
    }

    const file: JudgementFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      primaryJudge: cfg.judge.primary,
      secondJudge: cfg.judge.second,
      shuffleSeed: cfg.seed,
      labels,
      // Keep the previous agreement figure when this pass computed none. A
      // `--top-up` run that graded a handful of new candidates has too small a
      // subsample to measure κ, and dropping the existing one would silently
      // erase the harness's stated resolution floor.
      ...(agreement ?? existing.agreement ? { agreement: agreement ?? existing.agreement } : {}),
      unjudged,
    };
    await saveJudgements(cfg.fixtures.judgements, file);
    await writeArbitration(cfg, file, queries);

    let out = `\ngraded ${graded} new labels across ${targets.length - skipped} queries`;
    if (skipped) out += ` (${skipped} already complete)`;
    out += `\nunjudged: ${unjudged.length}`;
    if (agreement) {
      out +=
        `\nagreement (quadratic-weighted κ over ${agreement.n} double-labelled): ${agreement.kappa.toFixed(3)}` +
        `, exact ${(agreement.exact * 100).toFixed(0)}%`;
      out += `\n  → resolution floor: treat metric differences below ~${resolutionFloor(agreement.kappa).toFixed(2)} as noise`;
    }
    out += `\nwrote ${cfg.fixtures.judgements}`;
    return out;
  } finally {
    await stack.close();
  }
}

/**
 * A rough resolution floor implied by label noise.
 *
 * Deliberately crude and deliberately stated as an order of magnitude: κ measures
 * label agreement, not metric variance, so any exact mapping between them would be
 * false precision. What it is for is refusing to celebrate a +0.01 nDCG delta when
 * the judges themselves disagree on a fifth of the labels.
 */
export function resolutionFloor(kappa: number): number {
  return Math.max(0.01, Math.min(0.2, (1 - kappa) / 2));
}

/**
 * Write out the judge disagreements a human should settle.
 *
 * Only where the two models differ, and only within the subsample — roughly
 * dozens of items rather than the several hundred a flat percentage skim would
 * produce. A human grade overrides both models (see `gradesByQuery`).
 */
async function writeArbitration(
  cfg: EvalConfig,
  file: JudgementFile,
  queries: EvalQuery[],
): Promise<void> {
  const byPair = new Map<string, JudgeLabel[]>();
  for (const l of file.labels) {
    const key = `${l.queryId}:${l.entryId}`;
    const bucket = byPair.get(key);
    if (bucket) bucket.push(l);
    else byPair.set(key, [l]);
  }
  const disputes: string[] = [];
  for (const [key, group] of byPair) {
    if (group.length < 2) continue;
    const grades = new Set(group.map((g) => g.grade));
    if (grades.size < 2) continue;
    const [queryId, entryId] = key.split(':');
    const q = queries.find((x) => x.id === queryId);
    disputes.push(
      `## entry ${entryId} — query ${queryId} (${q?.class ?? '?'})\n` +
        `> ${q?.text.slice(0, 200) ?? '(unknown query)'}\n\n` +
        group.map((g) => `- **${g.judge}**: grade ${g.grade} — ${g.why}`).join('\n') +
        '\n\nHuman grade: _(add a label with judge: "human" to settle)_\n',
    );
  }
  const body =
    `# Judge disagreements awaiting arbitration\n\n` +
    `Generated ${file.generatedAt} from the ${(file.agreement?.subsampleFraction ?? 0) * 100}% double-judged subsample.\n\n` +
    (file.agreement
      ? `Quadratic-weighted κ ${file.agreement.kappa.toFixed(3)} over ${file.agreement.n} labels; ` +
        `${(file.agreement.exact * 100).toFixed(0)}% exact agreement.\n\n`
      : '') +
    (disputes.length
      ? `${disputes.length} disagreement(s).\n\n${disputes.join('\n')}`
      : 'No disagreements in the subsample.\n');
  await writeFile(cfg.fixtures.arbitrate, body, 'utf8');
}
