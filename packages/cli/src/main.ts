#!/usr/bin/env node
import { Command } from 'commander';
import { get, post, postStream, qs } from './api.js';
import { SOURCE_BADGE, bold, cyan, date, dim, green, hr, magenta, red, yellow } from './format.js';

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

function printHit(h: any, i: number) {
  const badge = SOURCE_BADGE[h.sourceType] ?? h.sourceType;
  console.log(
    `${dim(String(i + 1).padStart(2))} ${bold(h.title.slice(0, 90))}\n` +
      `   ${cyan(h.projectSlug)} ${magenta(badge)}${h.component ? ` ${yellow(h.component)}` : ''} ${dim(date(h.occurredAt))}\n` +
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
  .description('hybrid search across all indexed history')
  .action(async (words, o) => {
    const r = await get(
      `/api/search${qs({ q: words.join(' '), project: o.project, source: o.source, component: o.component, kind: o.kind, limit: o.limit })}`,
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
  .description('index stats and freshness')
  .action(async () => {
    const r = await get('/api/stats');
    out(r, () => {
      console.log(`${bold('projects')}  ${r.projects}`);
      console.log(`${bold('entries')}   ${r.entries}`);
      console.log(`${bold('chunks')}    ${r.chunks}`);
      console.log(
        `${bold('errors')}    ${r.recentErrors > 0 ? red(`${r.recentErrors} in the last hour`) : green('none in the last hour')}` +
          dim(` (${r.errors} lifetime)`),
      );
      console.log(`${bold('embedder')}  ${r.embedder} → ${dim(r.collection)}`);
      console.log(`${bold('last run')}  ${date(r.lastRunAt) || dim('never')}`);
      if (r.pending != null) {
        console.log(`${bold('queued')}    ${r.pending} scan job${r.pending === 1 ? '' : 's'}`);
      }
      if (r.backfill) {
        const pct = Math.round((r.backfill.done / Math.max(1, r.backfill.total)) * 100);
        const mins = Math.round(r.backfill.etaSec / 60);
        console.log(
          yellow(
            `re-embed  ${r.backfill.done.toLocaleString()}/${r.backfill.total.toLocaleString()} ` +
              `(${pct}%, ~${mins}m left) — results incomplete until this finishes`,
          ),
        );
      }
      console.log(dim('\nby source:'));
      for (const [k, v] of Object.entries(r.bySource ?? {})) {
        console.log(`  ${(SOURCE_BADGE[k] ?? k).padEnd(12)} ${v}`);
      }
    });
  });

program.parseAsync().catch((e) => {
  console.error(red(`error: ${e.message}`));
  process.exit(1);
});
