import {
  EmptyCompletionError,
  chatComplete,
  isTransient,
  withRetry,
  type ChatMessage,
} from '@atlas/core';
import type { EvalConfig } from './config.js';
import type { Grade } from './metrics.js';
import { shuffle } from './metrics.js';
import type { QueryClass } from './types.js';

/**
 * LLM relevance judging.
 *
 * The judge is the harness's foundation: every metric is a function of its
 * labels. So this module is written to fail loudly and never to invent a label —
 * a candidate it could not grade comes back as unjudged, not as a zero.
 */

/** The reply was not parseable as grades. Retryable with a repair instruction. */
export class JudgeFormatError extends Error {}

/** A 200 with a blank completion — a heavy model hiccup, worth retrying as-is. */
export class EmptyReplyError extends Error {}

export interface Candidate {
  entryId: number;
  sourceType: string;
  projectSlug: string;
  component?: string;
  occurredAt?: string;
  title: string;
  body: string;
}

/** Bodies are truncated here; the p90 kdb_component body is ~4.9k chars. */
const BODY_CHARS = 800;

/**
 * Grading rubric.
 *
 * The three anchors are not padding — each is a trap this corpus is full of, and
 * each was chosen because a generic "is this relevant?" prompt gets it wrong in a
 * way that would systematically distort the metrics:
 *
 *  - Sessions where somebody *asks* the question are a perfect lexical match and
 *    contain no answer. There are tens of thousands of them, and a judge that
 *    rewards them would score chatter above documentation, which is the exact bug
 *    the source weighting exists to fix.
 *  - The corpus contains many instances of the same class of incident. Crediting
 *    a block about the 07-15 outage for a question about 07-21 would make every
 *    variant look good at temporal questions.
 *  - Activity is recorded after it happens, so the write-up of a Tuesday incident
 *    is usually dated Wednesday. A judge applying naive date matching would mark
 *    the actual answer irrelevant.
 */
export const RUBRIC = `You grade how well each retrieved block answers a question about the recorded history of a software project. The blocks come from project journals (kdb logs), Claude Code session transcripts, git commits and documentation.

Grade each candidate:
3 = directly answers the question, or states the specific fact asked for
2 = substantially helps: partial answer, or names the cause/mechanism/decision asked about
1 = marginal: mentions the subject but adds nothing that answers the question
0 = irrelevant to the question

Apply these rules, which override the general scale:
- A transcript in which somebody ASKS this question, or discusses wanting to know, and does not contain the answer is grade 0 or 1 — never 2 or 3. Matching the question's words is not answering it.
- A block about a DIFFERENT instance of the same kind of event (another outage, another release, another file with a similar name) is grade 0, however similar it reads.
- For questions about a date or period: a block merely timestamped in that period but about an unrelated subject is grade 0. A block that describes the asked-about event is grade 3 even if it is timestamped days later — activity is normally recorded after it happens.

Reply with ONLY a JSON array, no prose and no markdown fence:
[{"n":<candidate number>,"grade":<0|1|2|3>,"why":"<12 words max>"}]
Include one object for every candidate you were shown.`;

export function buildJudgeUser(question: string, cls: QueryClass, candidates: Candidate[]): string {
  const blocks = candidates.map((c, i) => {
    const date = c.occurredAt ? ` (${c.occurredAt.slice(0, 10)})` : '';
    const comp = c.component ? ` / ${c.component}` : '';
    const body = c.body.length > BODY_CHARS ? `${c.body.slice(0, BODY_CHARS)}…` : c.body;
    // No rank and no score, deliberately: a judge shown the ranking it is
    // grading would let today's ranking bless itself.
    return `[${i + 1}] ${c.projectSlug} / ${c.sourceType}${comp}${date}\n${c.title}\n${body}`;
  });
  return `Question (${cls}): ${question}\n\nCandidates:\n\n${blocks.join('\n\n---\n\n')}`;
}

export interface ParsedGrade {
  n: number;
  grade: Grade;
  why: string;
}

/**
 * Pull grades out of a reply.
 *
 * Tolerant about wrapping — a fence, a preamble, trailing commentary — because
 * those are cosmetic and re-asking would cost a call for nothing. Strict about
 * the values: an out-of-range grade or an unknown candidate number is dropped
 * rather than coerced, because coercing it would fabricate a label.
 */
export function parseJudgeReply(reply: string, allowed: Set<number>): ParsedGrade[] {
  if (!reply.trim()) throw new EmptyReplyError('judge returned an empty completion');
  // Widest array in the reply: models sometimes emit a short example array first.
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start === -1 || end <= start) throw new JudgeFormatError(`no JSON array in reply: ${reply.slice(0, 120)}`);
  let raw: unknown;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch (e) {
    throw new JudgeFormatError(`unparseable JSON array: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new JudgeFormatError('parsed value is not an array');

  const out: ParsedGrade[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const n = Number((item as { n?: unknown })?.n);
    const grade = Number((item as { grade?: unknown })?.grade);
    if (!Number.isInteger(n) || !allowed.has(n) || seen.has(n)) continue;
    if (!Number.isInteger(grade) || grade < 0 || grade > 3) continue;
    seen.add(n);
    out.push({ n, grade: grade as Grade, why: String((item as { why?: unknown })?.why ?? '').slice(0, 120) });
  }
  if (!out.length) throw new JudgeFormatError('no valid grades in reply');
  return out;
}

/**
 * How many times to re-ask for candidates the model skipped.
 *
 * Two, and no more. A truncated completion loses the tail of a batch, which one
 * re-ask usually recovers; beyond that the batch is too big or the model is
 * having a bad day, and the honest outcome is `unjudged` rather than a third
 * round of spending.
 */
const MAX_REPAIR_PASSES = 3;

/**
 * Attempts for the transport+blank-reply layer, per pass.
 *
 * Kept small on purpose: this sits *outside* chatComplete, whose own retry is
 * disabled below. Two nested retry budgets multiply, so a dead gateway would
 * otherwise absorb attempts × passes calls before anyone found out.
 */
const TRANSPORT_ATTEMPTS = 3;

export interface JudgeResult {
  grades: { entryId: number; grade: Grade; why: string }[];
  unjudged: { entryId: number; reason: string }[];
  /** Model that answered, and how many passes it took. */
  passes: number;
}

/**
 * Grade one query's candidate pool with one model.
 *
 * Candidates are shuffled under the committed seed, so position carries no
 * information about rank, and two judges see the same order (making their
 * disagreements about relevance rather than about presentation order).
 */
export async function judgeQuery(
  cfg: EvalConfig,
  model: string,
  question: string,
  cls: QueryClass,
  candidates: Candidate[],
  seed: number,
): Promise<JudgeResult> {
  const ordered = shuffle(candidates, seed);
  const byPosition = new Map<number, Candidate>(ordered.map((c, i) => [i + 1, c]));
  const graded = new Map<number, { grade: Grade; why: string }>();
  let lastError = 'not attempted';
  let passes = 0;

  for (let pass = 1; pass <= MAX_REPAIR_PASSES; pass++) {
    const missing = [...byPosition.keys()].filter((n) => !graded.has(n));
    if (!missing.length) break;
    passes = pass;

    // Re-ask only for what is still missing, renumbered contiguously — a model
    // that truncated a 20-item reply will not do better if asked for the same 20.
    const subset = missing.map((n) => byPosition.get(n)!);
    const localToGlobal = new Map<number, number>(missing.map((n, i) => [i + 1, n]));
    const messages: ChatMessage[] = [
      { role: 'system', content: RUBRIC },
      { role: 'user', content: buildJudgeUser(question, cls, subset) },
    ];
    if (pass > 1) {
      messages.push({
        role: 'user',
        content:
          `Your previous reply did not grade every candidate (${lastError}). Reply with ONLY the ` +
          `JSON array, one object per candidate, n from 1 to ${subset.length}.`,
      });
    }

    try {
      let attempt = 0;
      const parsed = await withRetry(
        async () => {
          // Escalating budget. The judge is a reasoning model: it spends several
          // hundred completion tokens thinking before the first graded object, so
          // a budget sized for the JSON alone returns finish_reason "length" and
          // an empty string. Retrying that unchanged can never succeed, so each
          // attempt doubles instead of repeating.
          const budget = Math.min(8192, (900 + subset.length * 150) * 2 ** attempt++);
          const reply = await chatComplete({ ...cfg.llm, model } as never, messages, {
            temperature: 0,
            maxTokens: budget,
            clientId: 'atlas-eval',
            // chatComplete's own retry is disabled: this wrapper owns the
            // policy, and two live budgets would multiply into a long stall.
            retry: { attempts: 1 },
          });
          return parseJudgeReply(reply, new Set(localToGlobal.keys()));
        },
        {
          attempts: TRANSPORT_ATTEMPTS,
          baseDelayMs: 1500,
          // A truncated or blank completion is a budget problem the escalation
          // above fixes; `isTransient` cannot see it, because there is no status
          // and no network error to look at. A format failure gets one immediate
          // retry too, before a repair pass spends a call on a rewritten prompt.
          isRetryable: (e) =>
            isTransient(e) ||
            e instanceof EmptyCompletionError ||
            e instanceof EmptyReplyError ||
            e instanceof JudgeFormatError,
          onRetry: (attempt, e) =>
            process.stderr.write(`  [judge] retry ${attempt} (${(e as Error).message.slice(0, 90)})\n`),
        },
      );
      for (const g of parsed) {
        const global = localToGlobal.get(g.n);
        if (global !== undefined) graded.set(global, { grade: g.grade, why: g.why });
      }
      lastError = `graded ${parsed.length} of ${subset.length}`;
    } catch (e) {
      lastError = (e as Error).message.slice(0, 120);
      console.warn(`  [judge] pass ${pass} failed: ${lastError}`);
    }
  }

  const grades: JudgeResult['grades'] = [];
  const unjudged: JudgeResult['unjudged'] = [];
  for (const [n, candidate] of byPosition) {
    const g = graded.get(n);
    // Never a default grade. An unlabelled candidate scored 0 is a fabricated
    // label, and metrics over fabricated labels are the unearned confidence this
    // whole harness exists to remove. It bounds the metric instead.
    if (g) grades.push({ entryId: candidate.entryId, grade: g.grade, why: g.why });
    else unjudged.push({ entryId: candidate.entryId, reason: lastError });
  }
  return { grades, unjudged, passes };
}

/**
 * Pick the double-judged subsample, stratified by grade and query class.
 *
 * Uniform sampling would be dominated by grade 0 — most of a 70-candidate pool is
 * irrelevant — and the agreement statistic would then be flattered by easy
 * consensus on obvious negatives, understating label noise exactly where
 * decisions are actually made.
 */
export function stratifiedSubsample<T extends { grade: Grade; cls: QueryClass }>(
  labels: T[],
  fraction: number,
  seed: number,
): T[] {
  const strata = new Map<string, T[]>();
  for (const l of labels) {
    const key = `${l.cls}:${l.grade}`;
    const bucket = strata.get(key);
    if (bucket) bucket.push(l);
    else strata.set(key, [l]);
  }
  const out: T[] = [];
  // Sorted keys so the selection is reproducible regardless of insertion order.
  for (const key of [...strata.keys()].sort()) {
    const bucket = strata.get(key)!;
    // At least one from every stratum: a grade that appears rarely is where the
    // judges are most likely to differ, so dropping it would hide the disagreement
    // that matters most.
    const take = Math.max(1, Math.round(bucket.length * fraction));
    out.push(...shuffle(bucket, seed + key.length).slice(0, take));
  }
  return out;
}
