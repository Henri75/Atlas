#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { evalConfig } from './config.js';
import { generatePools } from './generate.js';
import { judgeAll } from './judgeAll.js';
import { consolidate, fromTranscripts, fromUsageLog } from './mine.js';
import { loadQueries, mergeQueries, saveQueries } from './pools.js';
import { formatSignals } from './report.js';
import { measureSignals } from './retrieve.js';
import { execute, recordBaseline } from './run.js';
import { connect, mapLimit } from './services.js';
import type { QueryFile } from './types.js';

/**
 * Retrieval evaluation harness.
 *
 * Subcommands split along how expensive and how repeatable each step is: `run`
 * is free and deterministic and is expected to be run constantly; `judge` and
 * `generate` cost LLM calls and are run rarely, on purpose. Bundling them into
 * one command would make the cheap thing feel expensive and quietly re-label
 * fixtures that a baseline depends on.
 */

const program = new Command();
program
  .name('atlas-eval')
  .description('measure Atlas retrieval quality against committed judgements');

program
  .command('mine')
  .description('refresh Pool A from usage_log + Claude transcripts (merges, never overwrites)')
  .option('--dry-run', 'report what would be added without writing the fixture')
  .action(async (opts: { dryRun?: boolean }) => {
    const cfg = evalConfig();
    const stack = await connect(cfg);
    try {
      const [usage, transcripts] = await Promise.all([
        fromUsageLog(stack.catalog),
        fromTranscripts(cfg.claudeProjectsDir),
      ]);
      const { queries, report } = consolidate([...usage, ...transcripts]);

      console.log(`mined ${report.fromUsageLog} usage_log + ${report.fromTranscripts} transcript calls`);
      if (report.droppedLoadTests.length) {
        console.log('\ndropped as load tests (many texts differing only by a number):');
        for (const d of report.droppedLoadTests) {
          console.log(`  ${String(d.count).padStart(4)} x  ${d.template.slice(0, 70)}`);
        }
      }
      console.log(`\n${report.distinct} distinct queries after collapsing duplicates`);

      const existing: QueryFile = existsSync(cfg.fixtures.queries)
        ? await loadQueries(cfg.fixtures.queries)
        : { version: 1, generatedAt: new Date().toISOString(), queries: [] };
      const merged = mergeQueries(existing.queries, queries);
      console.log(`${merged.kept} already committed, ${merged.added} new`);

      const byClass = new Map<string, number>();
      for (const q of merged.queries) {
        if (q.pool === 'A') byClass.set(q.class, (byClass.get(q.class) ?? 0) + 1);
      }
      console.log('\nPool A by class (heuristic — correct by hand in the fixture):');
      for (const [cls, n] of [...byClass].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${cls.padEnd(14)} ${n}`);
      }

      if (opts.dryRun) {
        console.log('\n--dry-run: fixture not written');
        return;
      }
      await saveQueries(cfg.fixtures.queries, {
        ...existing,
        generatedAt: new Date().toISOString(),
        queries: merged.queries,
      });
      console.log(`\nwrote ${cfg.fixtures.queries}`);
    } finally {
      await stack.close();
    }
  });

program
  .command('run')
  .description('measure retrieval quality; add --variant to A/B against the in-run baseline')
  .option('--variant <name>', 'candidate variant to compare against the baseline')
  .option('--floor <n>', 'slots reserved for non-session types (cap-as-floor only)', Number)
  .option('--pool <ids>', 'restrict to pools, e.g. A or A,B', (v: string) => v.split(','))
  .option('--class <name>', 'restrict to one query class')
  .action(async (opts: { variant?: string; floor?: number; pool?: string[]; class?: string }) => {
    const cfg = evalConfig();
    const outcome = await execute(cfg, {
      ...(opts.variant ? { variant: opts.variant } : {}),
      ...(opts.floor ? { floor: opts.floor } : {}),
      ...(opts.pool ? { pools: opts.pool as never } : {}),
      ...(opts.class ? { class: opts.class } : {}),
    });
    console.log(outcome.text);
    // A run whose conclusion depends on how unjudged candidates are treated has
    // not concluded anything, and must not read as a pass.
    if (outcome.comparisons && !outcome.comparisons.holds) process.exitCode = 2;
  });

program
  .command('baseline')
  .description('record the committed baseline (refuses if retrieval is degraded)')
  .action(async () => {
    const path = await recordBaseline(evalConfig());
    console.log(`wrote ${path}`);
  });

program
  .command('signals')
  .description('record candidate relevance signals for B4 calibration (no bands, no thresholds)')
  .action(async () => {
    const cfg = evalConfig();
    const stack = await connect(cfg);
    try {
      const { queries } = await loadQueries(cfg.fixtures.queries);
      const rows = await mapLimit(queries, cfg.concurrency, (q) => measureSignals(stack, cfg, q));
      await writeFile(
        cfg.fixtures.signals,
        `${JSON.stringify({ version: 1, recordedAt: new Date().toISOString(), rows }, null, 2)}\n`,
        'utf8',
      );
      console.log(formatSignals(rows));
      console.log(`wrote ${cfg.fixtures.signals}`);
    } finally {
      await stack.close();
    }
  });

program
  .command('judge')
  .description('grade Pool A candidates with the judge model')
  .option('--top-up', 'only judge candidates that carry no label yet')
  .option('--limit <n>', 'judge at most this many queries (for a smoke run)', Number)
  .action(async (opts: { topUp?: boolean; limit?: number }) => {
    const cfg = evalConfig();
    console.log(await judgeAll(cfg, { topUp: opts.topUp === true, ...(opts.limit ? { limit: opts.limit } : {}) }));
  });

program
  .command('generate')
  .description('build Pool B (known-item) and Pool N (verified negatives)')
  .option('--pool-b <n>', 'how many known-item questions to generate', Number)
  .option('--pool-n <n>', 'how many negatives to generate', Number)
  .action(async (opts: { poolB?: number; poolN?: number }) => {
    const cfg = evalConfig();
    console.log(
      await generatePools(cfg, {
        ...(opts.poolB ? { countB: opts.poolB } : {}),
        ...(opts.poolN ? { countN: opts.poolN } : {}),
      }),
    );
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(`[eval] ${(e as Error).message}`);
  process.exitCode = 1;
});
