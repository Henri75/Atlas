import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { EvalConfig } from './config.js';
import { RELEVANT_AT } from './metrics.js';
import { gradesByQuery, hashJudgements, loadJudgements, loadQueries, relevantByQuery } from './pools.js';
import { runVariant, type Measured } from './retrieve.js';
import {
  compare,
  decisionHolds,
  formatComparison,
  formatSummary,
  scoreQuery,
  summarise,
  type Comparison,
  type Judgements,
  type QueryScore,
} from './report.js';
import { connect, driftFields, fingerprint, mapLimit, type Stack } from './services.js';
import type { BaselineFile, EvalQuery, JudgementFile, PoolId } from './types.js';
import { BASELINE, variantByName } from './variants.js';

/**
 * The measurement run.
 *
 * The baseline variant is re-measured in the same process as any candidate, every
 * time. The committed baseline is only a trend marker — comparing a candidate
 * against a number recorded days ago would fold corpus growth into the delta and
 * report it as a ranking improvement, which is the class of mistake this harness
 * exists to make impossible.
 */

/**
 * Judgements, or an empty set when none are committed yet.
 *
 * An empty set is a legitimate state — Pool B and the signal panel need no
 * judgements at all — so this is not an error. But it makes every Pool A metric
 * unavailable, and the report says so loudly rather than printing zeros that
 * would read as "retrieval found nothing relevant".
 */
export async function readJudgements(cfg: EvalConfig): Promise<JudgementFile> {
  if (existsSync(cfg.fixtures.judgements)) return loadJudgements(cfg.fixtures.judgements);
  return {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    primaryJudge: 'none',
    shuffleSeed: 0,
    labels: [],
    unjudged: [],
  };
}

export function indexJudgements(j: JudgementFile): Judgements {
  const unjudged = new Map<string, Set<number>>();
  for (const u of j.unjudged) {
    let set = unjudged.get(u.queryId);
    if (!set) unjudged.set(u.queryId, (set = new Set()));
    set.add(u.entryId);
  }
  return {
    grades: gradesByQuery(j),
    relevant: relevantByQuery(j, RELEVANT_AT),
    unjudged,
  };
}

export interface RunOptions {
  variant?: string;
  floor?: number;
  pools?: PoolId[];
  class?: string;
  /** Pinned clock, so a run is reproducible and recency cannot drift it. */
  nowMs?: number;
}

export interface RunOutcome {
  scores: Map<string, QueryScore[]>;
  degraded: string[];
  text: string;
  comparisons?: { optimistic: Comparison[]; pessimistic: Comparison[]; holds: boolean; flipped: string[] };
}

async function measureAll(
  stack: Stack,
  cfg: EvalConfig,
  queries: EvalQuery[],
  variantName: string,
  floor: number,
  nowMs: number,
): Promise<Measured[]> {
  const variant = variantName === BASELINE.name ? BASELINE : variantByName(variantName, floor);
  return mapLimit(queries, cfg.concurrency, (q) => runVariant(stack, cfg, q, variant, nowMs));
}

export async function execute(cfg: EvalConfig, opts: RunOptions = {}): Promise<RunOutcome> {
  const stack = await connect(cfg);
  try {
    const queryFile = await loadQueries(cfg.fixtures.queries);
    const pools = opts.pools ?? (['A', 'B', 'N'] as PoolId[]);
    const queries = queryFile.queries
      .filter((q) => pools.includes(q.pool))
      .filter((q) => !opts.class || q.class === opts.class);
    if (!queries.length) throw new Error('no queries matched the requested pools/class');

    const judgements = await readJudgements(cfg);
    const idx = indexJudgements(judgements);
    // One clock for the whole run, so the recency term cannot make two variants
    // differ for a reason that has nothing to do with what is being compared.
    const nowMs = opts.nowMs ?? Date.now();

    const names = [BASELINE.name, ...(opts.variant ? [opts.variant] : [])];
    const measured = new Map<string, Measured[]>();
    for (const name of names) {
      process.stderr.write(`measuring ${name} over ${queries.length} queries…\n`);
      measured.set(name, await measureAll(stack, cfg, queries, name, opts.floor ?? 4, nowMs));
    }

    const score = (name: string, unjudgedAs: 0 | 3) =>
      queries.map((q, i) =>
        scoreQuery(q, measured.get(name)![i]!, idx, cfg.k, cfg.poolCutoff, unjudgedAs),
      );

    const scores = new Map<string, QueryScore[]>();
    for (const name of names) scores.set(name, score(name, 0));

    const degradedQueries = [
      ...new Set(
        names.flatMap((n) => measured.get(n)!.filter((m) => m.degraded).map((m) => m.mode)),
      ),
    ];

    let text = '';
    const fp = await fingerprint(stack, hashJudgements(judgements));
    text += `index: ${fp.entries.toLocaleString('en-US')} entries, newest ${fp.newestOccurredAt?.slice(0, 10) ?? '?'}, ${fp.collection}\n`;
    text += `judgements: ${judgements.labels.length} labels (${judgements.primaryJudge}), ${judgements.unjudged.length} unjudged, hash ${fp.judgementsHash}\n`;

    if (degradedQueries.length) {
      text += `\n!! DEGRADED RETRIEVAL (${degradedQueries.join(', ')}) — scores are not comparable to a hybrid baseline\n`;
    }

    const totalUnjudged = scores.get(BASELINE.name)!.reduce((n, s) => n + s.unjudged, 0);
    if (!judgements.labels.length) {
      text += '\n!! no judgements committed — Pool A metrics are unavailable (run `eval judge`)\n';
    } else if (totalUnjudged) {
      // Say which bound the tables show. A reader who assumed the optimistic one
      // would read every Pool A figure as better than the harness can defend.
      text +=
        `\n   ${totalUnjudged} retrieved candidates carry no judgement. The tables below show the ` +
        `PESSIMISTIC bound (unjudged = irrelevant); any A/B verdict is checked against both bounds.\n`;
    }

    for (const name of names) {
      for (const pool of pools) {
        if (pool === 'N') continue;
        text += formatSummary(`${name} — pool ${pool}`, summarise(scores.get(name)!, pool), pool);
      }
    }

    let comparisons: RunOutcome['comparisons'];
    if (opts.variant) {
      const optimistic = compare(score(BASELINE.name, 3), score(opts.variant, 3), cfg.seed);
      const pessimistic = compare(score(BASELINE.name, 0), score(opts.variant, 0), cfg.seed);
      const { holds, flipped } = decisionHolds(optimistic, pessimistic);
      comparisons = { optimistic, pessimistic, holds, flipped };
      text += formatComparison(opts.variant, pessimistic);
      if (!holds) {
        text +=
          `\n!! INCONCLUSIVE — ${flipped.length} comparison(s) flip between the optimistic and ` +
          `pessimistic treatment of unjudged candidates:\n     ${flipped.join(', ')}\n` +
          '   Run `eval judge --top-up` to label them, then re-run.\n';
      }
    }

    // Trend only: a candidate is never compared against this, because the corpus
    // it was measured on no longer exists.
    if (existsSync(cfg.fixtures.baseline)) {
      const committed = JSON.parse(await readFile(cfg.fixtures.baseline, 'utf8')) as BaselineFile;
      const drift = driftFields(committed.fingerprint, fp);
      if (drift.length) {
        text += `\ncommitted baseline recorded ${committed.recordedAt.slice(0, 10)}; index has since changed (${drift.join(', ')}) — treat it as a trend marker, not a comparison\n`;
      }
    }

    return { scores, degraded: degradedQueries, text, comparisons };
  } finally {
    await stack.close();
  }
}

/**
 * Record the committed baseline.
 *
 * Refuses on degraded retrieval: sparse-only and FTS produce scores on entirely
 * different scales, so a baseline captured then would silently poison every later
 * comparison against it.
 */
export async function recordBaseline(cfg: EvalConfig): Promise<string> {
  const outcome = await execute(cfg);
  if (outcome.degraded.length) {
    throw new Error(
      `retrieval was degraded (${outcome.degraded.join(', ')}) — refusing to record a baseline. ` +
        'Fix the embedder or Qdrant and retry.',
    );
  }
  const stack = await connect(cfg);
  try {
    const judgements = await readJudgements(cfg);
    const metrics: Record<string, unknown> = {};
    for (const [name, scores] of outcome.scores) {
      metrics[name] = {
        A: summarise(scores, 'A'),
        B: summarise(scores, 'B'),
      };
    }
    const file: BaselineFile = {
      version: 1,
      recordedAt: new Date().toISOString(),
      fingerprint: await fingerprint(stack, hashJudgements(judgements)),
      metrics,
    };
    await writeFile(cfg.fixtures.baseline, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    return cfg.fixtures.baseline;
  } finally {
    await stack.close();
  }
}
