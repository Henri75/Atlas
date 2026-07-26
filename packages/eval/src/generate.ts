import { EmptyCompletionError, chatComplete, isTransient, withRetry, type ChatMessage } from '@atlas/core';
import type { EvalConfig } from './config.js';
import { JudgeFormatError, judgeQuery } from './judge.js';
import { RELEVANT_AT } from './metrics.js';
import { LEAKAGE_THRESHOLD, expandGold, leakage, loadQueries, queryId, saveQueries } from './pools.js';
import { candidatePool } from './retrieve.js';
import { connect, mapLimit, type Stack } from './services.js';
import type { EvalQuery, QueryClass, QueryFile } from './types.js';
import { QUERY_CLASSES } from './types.js';

/**
 * Pools B and N.
 *
 * Pool B exists because 21 real queries cannot support a per-class comparison —
 * the mined set has 3 temporal and 2 procedural questions, where one query swings
 * a class by a third. Its questions are generated *from* known entries, so the
 * gold answer needs no judge and the pool can be as large as it needs to be.
 *
 * Pool N exists because B4 has to distinguish "weak" from "nothing relevant", and
 * with no unanswerable questions there is nothing to calibrate the latter against.
 */

/** Source types Pool B draws from, and how many questions each contributes. */
const POOL_B_MIX: { sourceType: string; share: number }[] = [
  { sourceType: 'kdb_component', share: 0.25 },
  { sourceType: 'doc', share: 0.25 },
  { sourceType: 'git_commit', share: 0.15 },
  { sourceType: 'kdb_changelog', share: 0.15 },
  // Sessions are 90% of the corpus and the type the cap suppresses, so the
  // source-mix question is undecidable without questions whose real answer is a
  // session. Under-represented relative to the corpus on purpose: at 90% they
  // would drown every other type's signal.
  { sourceType: 'claude_session', share: 0.2 },
];

const GENERATOR_SYSTEM = `You write evaluation questions for a search engine over a software project's recorded history.

You are shown ONE entry. Write the question that this entry is the best answer to — the question somebody would ask months later when they need this information back.

Hard rules:
- Write as somebody who has NOT seen this entry. They know the project, not this text.
- Do NOT reuse identifiers, file names, function names, error strings, or any verbatim phrase longer than three words from the entry. Describe things in your own words.
- Do not mention dates unless the question is genuinely about when something happened.
- One question, 8-25 words, ending in a question mark.
- It must be answerable from this entry, and specific enough that a different entry about a different subject would not answer it.

Reply with ONLY the question text. No preamble, no quotes.`;

const NEGATIVE_SYSTEM = `You write questions for testing a search engine's ability to say "I found nothing relevant".

Write questions that sound exactly like real questions about a software project's history, but about technologies and concerns that this project does NOT use. You will be told which technologies the project DOES use — avoid all of them and anything adjacent.

Each question must be plausible, specific, and technical — the kind a developer would really ask. Vague questions are useless here because anything vague matches something.

Reply with ONLY a JSON array of question strings, no prose and no fence.`;

/**
 * One LLM call, retried with an *escalating* token budget.
 *
 * The escalation is the point. The judge model is a reasoning model: it spends
 * several hundred completion tokens thinking before emitting anything, so a
 * budget sized for the visible answer comes back truncated and empty. Retrying
 * that request unchanged fails identically every time — measured the hard way, as
 * 45 consecutive empty completions across 15 entries. Doubling the budget each
 * attempt fixes the truncated case, while a genuinely transient blank is fixed by
 * the retry itself.
 */
async function complete(cfg: EvalConfig, messages: ChatMessage[], maxTokens: number): Promise<string> {
  let attempt = 0;
  return withRetry(
    async () => {
      const budget = Math.min(8192, maxTokens * 2 ** attempt++);
      return chatComplete({ ...cfg.llm } as never, messages, {
        temperature: 0.4,
        maxTokens: budget,
        clientId: 'atlas-eval',
        // This wrapper owns the retry policy; a second live budget inside
        // chatComplete would multiply the attempts and hide the escalation.
        retry: { attempts: 1 },
      });
    },
    {
      attempts: 3,
      baseDelayMs: 1500,
      isRetryable: (e) => isTransient(e) || e instanceof EmptyCompletionError,
      onRetry: (n, e) =>
        process.stderr.write(
          `  retry ${n} with ${Math.min(8192, maxTokens * 2 ** attempt)} tokens (${(e as Error).message.slice(0, 90)})\n`,
        ),
    },
  );
}

interface SourceEntry {
  id: number;
  sourceType: string;
  slug: string;
  title: string;
  body: string;
  occurredAt?: string;
}

/**
 * Sample entries worth writing a question about.
 *
 * Filtered on body length because a 40-character session line ("Assistant: ok")
 * cannot support a specific question, and a question generated from one would be
 * unanswerable noise that every variant fails equally — measuring nothing.
 */
async function sampleEntries(stack: Stack, sourceType: string, want: number): Promise<SourceEntry[]> {
  const r = await stack.catalog.pool.query(
    `SELECT e.id, e.source_type, p.slug, e.title, e.body, e.occurred_at
       FROM entries e JOIN projects p ON p.id = e.project_id
      WHERE e.source_type = $1 AND length(e.body) BETWEEN 400 AND 6000
      ORDER BY e.id % 97, e.id
      LIMIT $2`,
    [sourceType, want * 3],
  );
  return r.rows.map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    slug: row.slug,
    title: row.title,
    body: String(row.body),
    occurredAt: row.occurred_at?.toISOString(),
  }));
}

/** Deterministic class for a generated question, spread evenly over the classes. */
function classFor(index: number): QueryClass {
  return QUERY_CLASSES[index % QUERY_CLASSES.length]!;
}

export interface GenerateOptions {
  countB?: number;
  countN?: number;
}

export async function generatePools(cfg: EvalConfig, opts: GenerateOptions = {}): Promise<string> {
  const countB = opts.countB ?? 40;
  const countN = opts.countN ?? 12;
  const stack = await connect(cfg);
  try {
    const existing = await loadQueries(cfg.fixtures.queries);
    const known = new Set(existing.queries.map((q) => q.id));
    const generated: EvalQuery[] = [];
    let rejected = 0;

    // ---- Pool B ----------------------------------------------------------
    let index = 0;
    for (const { sourceType, share } of POOL_B_MIX) {
      const want = Math.max(1, Math.round(countB * share));
      const pool = await sampleEntries(stack, sourceType, want);
      process.stderr.write(`pool B: ${sourceType} — ${pool.length} candidate entries for ${want} questions\n`);

      let made = 0;
      for (const entry of pool) {
        if (made >= want) break;
        const cls = classFor(index++);
        let question: string;
        try {
          question = (
            await complete(
              cfg,
              [
                { role: 'system', content: GENERATOR_SYSTEM },
                {
                  role: 'user',
                  content:
                    `Write a "${cls}" question. Entry:\n\n` +
                    `${entry.slug} / ${entry.sourceType}\n${entry.title}\n${entry.body.slice(0, 2500)}`,
                },
              ],
              // Sized for a reasoning model: the visible answer is one sentence,
              // but ~500 tokens of reasoning precede it. Escalates on retry.
              1200,
            )
          )
            .trim()
            .replace(/^["'`]|["'`]$/g, '');
        } catch (e) {
          process.stderr.write(`  generation failed for entry ${entry.id}: ${(e as Error).message}\n`);
          continue;
        }

        const overlap = leakage(question, `${entry.title} ${entry.body}`);
        if (overlap > LEAKAGE_THRESHOLD) {
          // The generator echoed the entry: the keyword branch would find this
          // regardless of ranking, inflating every score and biasing against
          // changes that improve semantic matching.
          rejected++;
          continue;
        }

        const id = queryId(question, {});
        if (known.has(id)) continue;
        known.add(id);

        // Gold set = this entry plus anything that is the same content recorded
        // again, because reranking keeps the best-scoring member of a duplicate
        // group and that need not be this row.
        const siblings = await stack.catalog.pool.query(
          `SELECT e.id AS "entryId", p.slug AS "projectSlug", e.source_type AS "sourceType",
                  e.title, e.occurred_at AS "occurredAt"
             FROM entries e JOIN projects p ON p.id = e.project_id
            WHERE e.title = $1 AND e.source_type = $2`,
          [entry.title, entry.sourceType],
        );
        const target = {
          entryId: entry.id,
          projectSlug: entry.slug,
          sourceType: entry.sourceType,
          title: entry.title,
          ...(entry.occurredAt ? { occurredAt: entry.occurredAt } : {}),
        };
        const gold = expandGold(
          target as never,
          siblings.rows.map((s) => ({
            entryId: s.entryId,
            projectSlug: s.projectSlug,
            sourceType: s.sourceType,
            title: s.title,
            occurredAt: s.occurredAt?.toISOString(),
          })) as never,
        );

        generated.push({
          id,
          pool: 'B',
          text: question,
          class: cls,
          filters: {},
          provenance: {
            source: 'generated',
            at: new Date().toISOString(),
            fromEntryId: entry.id,
            fromSourceType: entry.sourceType,
            generator: cfg.llm.model,
          },
          gold,
          leakage: Number(overlap.toFixed(3)),
        });
        made++;
      }
    }

    // ---- Pool N ----------------------------------------------------------
    // Name what the project *does* use, so the generator can avoid it. Taken
    // from the corpus rather than hand-listed, so it stays true as the index grows.
    const topics = await stack.catalog.pool.query(
      `SELECT DISTINCT p.slug FROM projects p JOIN entries e ON e.project_id = p.id LIMIT 40`,
    );
    const negatives: string[] = [];
    // Batched, because a reasoning model asked for 18 questions at once spends
    // long enough thinking to exceed chatComplete's 120s ceiling — measured: the
    // single-call version aborted on timeout every time. Four per call keeps each
    // completion short enough to land, and a batch that fails costs four
    // questions rather than the whole pool.
    const NEG_BATCH = 4;
    const domains = [
      'message queues and event streaming',
      'payments, billing and subscriptions',
      'mobile app store releases and crash reporting',
      'Kubernetes, service meshes and cluster networking',
      'data warehousing and BI dashboards',
    ];
    for (let b = 0; b * NEG_BATCH < countN + 4; b++) {
      try {
        const reply = await complete(
          cfg,
          [
            { role: 'system', content: NEGATIVE_SYSTEM },
            {
              role: 'user',
              content:
                `Write ${NEG_BATCH} questions about ${domains[b % domains.length]}. ` +
                `The project uses: Postgres, Qdrant, Redis, Docker, TypeScript, Node, Python, ` +
                `Ollama, React, Hono, vitest, and these codebases: ` +
                `${topics.rows.map((t) => t.slug).join(', ')}. Avoid all of it.`,
            },
          ],
          1500,
        );
        const start = reply.indexOf('[');
        const end = reply.lastIndexOf(']');
        if (start === -1 || end <= start) throw new JudgeFormatError('no array in negatives reply');
        for (const item of JSON.parse(reply.slice(start, end + 1)) as unknown[]) {
          if (typeof item === 'string' && item.trim().length > 15) negatives.push(item.trim());
        }
      } catch (e) {
        process.stderr.write(`negatives batch ${b + 1} failed: ${(e as Error).message}\n`);
      }
    }
    process.stderr.write(`pool N: ${negatives.length} candidates to verify\n`);

    // Verify the absence rather than assuming it. A "negative" that turns out to
    // have an answer is not a negative — it is a Pool A query nobody had asked yet.
    let promoted = 0;
    let verified = 0;
    for (const text of negatives) {
      if (verified >= countN) break;
      const id = queryId(text, {});
      if (known.has(id)) continue;
      const probe: EvalQuery = {
        id,
        pool: 'N',
        text,
        class: 'definitional',
        filters: {},
        provenance: { source: 'generated', at: new Date().toISOString(), generator: cfg.llm.model },
      };
      const { ids } = await candidatePool(stack, cfg, probe);
      if (!ids.length) {
        known.add(id);
        generated.push(probe);
        verified++;
        continue;
      }
      const rows = await stack.catalog.getEntries(ids.slice(0, cfg.judge.batchSize));
      const candidates = [...rows.entries()].map(([entryId, row]) => ({
        entryId,
        sourceType: row.source_type,
        projectSlug: row.slug,
        title: row.title,
        body: String(row.body),
        ...(row.occurred_at ? { occurredAt: row.occurred_at.toISOString() } : {}),
      }));
      const judged = await judgeQuery(cfg, cfg.judge.primary, text, 'definitional', candidates, cfg.seed);
      const anyRelevant = judged.grades.some((g) => g.grade >= RELEVANT_AT);
      if (anyRelevant) {
        promoted++;
        process.stderr.write(`  not a negative (has an answer): ${text.slice(0, 70)}\n`);
        continue;
      }
      known.add(id);
      generated.push(probe);
      verified++;
    }

    // ---- Validate Pool B's leakage threshold empirically -----------------
    // If the accepted questions were still echoing their source entries, keyword
    // search alone would find nearly all of them. Measured, then committed, so
    // 0.6 is a number with evidence behind it rather than a preference.
    const poolB = generated.filter((q) => q.pool === 'B');
    const sparseHits = await mapLimit(poolB, cfg.concurrency, async (q) => {
      const hits = await stack.catalog.ftsSearch(q.text, {}, cfg.poolCutoff).catch(() => []);
      const gold = new Set(q.gold ?? []);
      return hits.some((h) => gold.has(h.entryId)) ? 1 : 0;
    });
    const sparseOnlyHitAt30 = sparseHits.length
      ? sparseHits.reduce((a: number, b: number) => a + b, 0) / sparseHits.length
      : 0;

    const file: QueryFile = {
      ...existing,
      generatedAt: new Date().toISOString(),
      poolB: {
        leakageThreshold: LEAKAGE_THRESHOLD,
        rejected,
        accepted: poolB.length,
        sparseOnlyHitAt30: Number(sparseOnlyHitAt30.toFixed(3)),
      },
      queries: [...existing.queries, ...generated],
    };
    await saveQueries(cfg.fixtures.queries, file);

    return (
      `\npool B: ${poolB.length} questions accepted, ${rejected} rejected for leakage > ${LEAKAGE_THRESHOLD}\n` +
      `pool N: ${verified} verified negatives, ${promoted} rejected because they had real answers\n` +
      `leakage check: sparse-only hit@${cfg.poolCutoff} over pool B = ${sparseOnlyHitAt30.toFixed(3)}` +
      `${sparseOnlyHitAt30 > 0.8 ? '  !! near 1.0 means leakage survived — lower the threshold' : ''}\n` +
      `wrote ${cfg.fixtures.queries}\n`
    );
  } finally {
    await stack.close();
  }
}
