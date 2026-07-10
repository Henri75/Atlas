#!/usr/bin/env node
import { Command } from 'commander';
import { get, post, postStream, qs } from './api.js';
import {
  SOURCE_BADGE,
  bold,
  bytes,
  cyan,
  date,
  dim,
  duration,
  green,
  hr,
  magenta,
  num,
  red,
  yellow,
} from './format.js';

/**
 * kdbs — terminal client for KDBScope. Every command supports --json for
 * scripting/agents; human output is compact and scannable.
 */

const program = new Command()
  .name('kdbs')
  .description('KDBScope: search & ask across all your projects’ history')
  .version('0.1.0')
  .option('--json', 'raw JSON output');

const isJson = () => program.opts().json === true;
const out = (data: unknown, human: () => void) => {
  if (isJson()) console.log(JSON.stringify(data, null, 2));
  else human();
};

/** Search degrades silently; say what broke and what it costs. */
function degradedReason(mode: string): string {
  if (mode === 'sparse-only') {
    return 'Embedding provider unreachable — keyword matching only, similar wording will be missed.';
  }
  if (mode === 'fts') {
    return 'Vector index unreachable — Postgres text search, weaker ranking and recall.';
  }
  return `Degraded search (${mode}).`;
}

/** Staleness tag: archived is loud (downranked), aging is informational. */
function staleTag(h: any): string {
  if (h.docStatus === 'archived') {
    return ` ${red(`[archived${h.ageMonths != null ? ` ${h.ageMonths}mo` : ''}]`)}`;
  }
  if (h.docStatus === 'aging') return ` ${yellow(`[aging ${h.ageMonths}mo]`)}`;
  return '';
}

function printHit(h: any, i: number) {
  const badge = SOURCE_BADGE[h.sourceType] ?? h.sourceType;
  console.log(
    `${dim(String(i + 1).padStart(2))} ${bold(h.title.slice(0, 90))}\n` +
      `   ${cyan(h.projectSlug)} ${magenta(badge)}${h.component ? ` ${yellow(h.component)}` : ''}${staleTag(h)} ${dim(date(h.occurredAt))}\n` +
      `   ${dim(h.snippet.replace(/\s+/g, ' ').slice(0, 160))}`,
  );
}

program
  .command('search')
  .argument('<query...>')
  .option('-p, --project <slug>')
  .option('-s, --source <type>')
  .option('-c, --component <name>')
  .option('-k, --kind <kind>', 'insight | plan | summary | action | prompt | response')
  .option('-n, --limit <n>', 'max results', '10')
  .option('--doc-status <s>', 'active (exclude archived docs) | archived (only them)')
  .description('hybrid search across all indexed history')
  .action(async (words, o) => {
    const r = await get(
      `/api/search${qs({ q: words.join(' '), project: o.project, source: o.source, component: o.component, kind: o.kind, docStatus: o.docStatus, limit: o.limit })}`,
    );
    out(r, () => {
      if (r.degraded) console.log(yellow(`⚠ ${degradedReason(r.mode)}\n`));
      console.log(dim(`${r.hits.length} hits · ${r.mode} · ${r.tookMs}ms`));
      console.log(hr());
      r.hits.forEach(printHit);
    });
  });

program
  .command('ask')
  .argument('<question...>')
  .option('-p, --project <slug>')
  .option('-k, --k <n>', 'context blocks', '12')
  .option('--no-stream', 'wait for the whole answer instead of streaming it')
  .description('ask a question, get a cited answer synthesized by the LLM')
  .action(async (words, o) => {
    const body = { question: words.join(' '), project: o.project, k: Number(o.k) };
    const printSources = (sources: any[]) => {
      console.log(`\n${hr()}\n${dim('sources:')}`);
      for (const s of sources) {
        console.log(`${dim(`[${s.n}]`)} ${cyan(s.projectSlug)} ${s.title.slice(0, 80)} ${dim(date(s.occurredAt))}`);
      }
    };

    // --json must stay one valid document, so buffer rather than stream it.
    if (isJson() || o.stream === false) {
      const r = await post('/api/ask', body);
      out(r, () => {
        if (r.degraded) console.log(yellow('⚠ LLM unavailable — sources only\n'));
        console.log(r.answer);
        printSources(r.sources);
      });
      return;
    }

    let sources: any[] = [];
    let degraded = false;
    for await (const ev of postStream('/api/ask/stream', body)) {
      if (ev.type === 'sources') sources = ev.sources;
      else if (ev.type === 'delta') process.stdout.write(ev.text);
      else if (ev.type === 'done') degraded = ev.degraded;
      else if (ev.type === 'error') throw new Error(ev.message);
    }
    if (degraded) console.log(yellow('\n\n⚠ LLM unavailable — sources only'));
    printSources(sources);
  });

program
  .command('projects')
  .description('list indexed projects')
  .action(async () => {
    const r = await get('/api/projects');
    out(r, () => {
      for (const p of r) {
        console.log(
          `${bold(p.slug.padEnd(24))} ${String(p.entryCount).padStart(6)} entries ` +
            `${p.hasKdb ? green('kdb') : dim('—')}  ${dim(p.rootPath || '(claude only)')}`,
        );
      }
    });
  });

program
  .command('timeline')
  .argument('<project>')
  .option('-n, --limit <n>', 'items', '30')
  .option('--sources <list>', 'comma-separated source types')
  .description('what happened in a project, newest first')
  .action(async (project, o) => {
    const r = await get(`/api/projects/${project}/timeline${qs({ limit: o.limit, sources: o.sources })}`);
    out(r, () => {
      for (const t of r.items) {
        const badge = SOURCE_BADGE[t.sourceType] ?? t.sourceType;
        console.log(
          `${dim(date(t.occurredAt))} ${magenta(badge.padEnd(11))} ${t.component ? yellow(`[${t.component}] `) : ''}${t.title.slice(0, 100)}`,
        );
      }
    });
  });

program
  .command('components')
  .argument('<project>')
  .description('list a project’s components')
  .action(async (project) => {
    const r = await get(`/api/projects/${project}/components`);
    out(r, () => {
      for (const c of r.components) {
        console.log(`${bold(c.component.padEnd(40))} ${String(c.count).padStart(5)}  ${dim(date(c.lastAt))}`);
      }
    });
  });

program
  .command('component')
  .argument('<project>')
  .argument('<name>')
  .description('full history of one component')
  .action(async (project, name) => {
    const r = await get(`/api/projects/${project}/components/${encodeURIComponent(name)}`);
    out(r, () => {
      for (const e of r.entries) {
        console.log(`${hr()}\n${bold(e.title)} ${dim(date(e.occurred_at))}\n${e.body.slice(0, 1200)}`);
      }
    });
  });

program
  .command('sessions')
  .argument('<project>')
  .description('recent Claude Code sessions for a project')
  .action(async (project) => {
    const r = await get(`/api/projects/${project}/sessions`);
    out(r, () => {
      for (const s of r.sessions) {
        console.log(
          `${bold(s.id.slice(0, 8))} ${dim(date(s.started_at))} ${String(s.prompt_count).padStart(3)} prompts  ${(s.title ?? '').slice(0, 80)}`,
        );
      }
    });
  });

program
  .command('session')
  .argument('<id>')
  .description('replay one session (prompts + substantial responses)')
  .action(async (id) => {
    const r = await get(`/api/sessions/${id}`);
    out(r, () => {
      const s = r.session;
      console.log(`${bold(s.title ?? s.id)} ${dim(s.cwd ?? '')}\n${hr()}`);
      for (const e of r.entries) {
        const kind = e.meta?.kind === 'prompt' ? green('YOU') : cyan('AI ');
        console.log(`${kind} ${dim(date(e.occurred_at))} ${e.body.slice(0, 500).replace(/\n+/g, ' ')}\n`);
      }
      const files = s.files_touched ?? [];
      if (files.length) console.log(`${dim('files touched:')}\n  ${files.join('\n  ')}`);
    });
  });

program
  .command('reindex')
  .option('-p, --project <slug>')
  .option('--full', 'reset scan state and reprocess everything')
  .description('trigger an index update now')
  .action(async (o) => {
    const r = await post('/api/admin/reindex', { project: o.project, full: o.full === true });
    out(r, () => console.log(green(`reindex triggered (${r.enqueued} job)`)));
  });

program
  .command('status')
  .description('what is indexed, whether it is healthy, and what it costs')
  .action(async () => {
    // The dashboard endpoint carries storage and health too; it is slower than
    // /api/stats, which is fine for a command someone typed.
    const r = await get('/api/dashboard');
    out(r, () => {
      console.log(`${bold('projects')}  ${num(r.projects)}`);
      console.log(`${bold('entries')}   ${num(r.entries)}`);
      console.log(`${bold('chunks')}    ${num(r.chunks)}`);
      console.log(`${bold('sessions')}  ${num(r.sessions)}`);
      console.log(
        `${bold('errors')}    ${r.recentErrors > 0 ? red(`${num(r.recentErrors)} in the last hour`) : green('none in the last hour')}` +
          dim(` (${num(r.errors)} lifetime)`),
      );
      console.log(`${bold('embedder')}  ${r.embedder} → ${dim(r.collection)}`);
      console.log(`${bold('last run')}  ${date(r.lastRunAt) || dim('never')}`);
      if (r.pending != null) {
        console.log(`${bold('queued')}    ${num(r.pending)} scan job${r.pending === 1 ? '' : 's'}`);
      }
      if (r.backfill) {
        const pct = Math.round((r.backfill.done / Math.max(1, r.backfill.total)) * 100);
        console.log(
          yellow(
            `re-embed  ${num(r.backfill.done)}/${num(r.backfill.total)} ` +
              `(${pct}%, ~${duration(r.backfill.etaSec)} left) — results incomplete until this finishes`,
          ),
        );
      }

      if (r.health) {
        console.log(dim('\nservices:'));
        for (const [name, up] of Object.entries(r.health as Record<string, boolean>)) {
          console.log(`  ${name.padEnd(12)} ${up ? green('running') : red('unreachable')}`);
        }
      }

      if (r.storage) {
        console.log(dim('\nstorage:'));
        console.log(`  ${'postgres'.padEnd(12)} ${bytes(r.storage.postgresBytes)} ${dim('disk')}`);
        console.log(`  ${'qdrant'.padEnd(12)} ${bytes(r.storage.qdrantBytes)} ${dim('disk')}`);
        console.log(`  ${'redis'.padEnd(12)} ${bytes(r.storage.redisMemoryBytes)} ${dim('memory')}`);
        const stale = (r.storage.collections ?? []).filter((c: any) => !c.active && c.bytes > 0);
        const staleBytes = stale.reduce((s: number, c: any) => s + c.bytes, 0);
        if (staleBytes > 0) {
          console.log(
            yellow(
              `  ${bytes(staleBytes)} of stale vectors from an old embedding model — nothing reads them`,
            ),
          );
        }
      }

      console.log(dim('\nby source:'));
      for (const [k, v] of Object.entries(r.bySource ?? {})) {
        console.log(`  ${(SOURCE_BADGE[k] ?? k).padEnd(12)} ${num(v as number).padStart(9)}`);
      }
    });
  });

program.parseAsync().catch((e) => {
  console.error(red(`error: ${e.message}`));
  process.exit(1);
});
