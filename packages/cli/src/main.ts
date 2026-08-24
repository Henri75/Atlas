#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { Command } from 'commander';
import {
  AtlasResolveError,
  DEFAULT_REMOTE_RSYNC_PATH,
  invalidateCache,
  loadMachinesFileIfPresent,
  machinesFilePath,
  probeInstance,
  readToken,
  resolveActive,
  writeCredentials,
  RESOLVER_API_PORT,
} from '@atlas/core';
import { get, post, postStream, qs } from './api.js';
import { addMachine, removeMachine } from './machinesFile.js';
import { checkRemoteRsync, type Exec } from './rsyncPreflight.js';
import {
  SOURCE_BADGE,
  bold,
  bytes,
  cyan,
  date,
  dim,
  duration,
  formatWhichRows,
  green,
  hr,
  magenta,
  num,
  red,
  syncBadge,
  yellow,
  type WhichRow,
} from './format.js';

const execFile = promisify(execFileCb);

/**
 * atlas — terminal client for Atlas. Every command supports --json for
 * scripting/agents; human output is compact and scannable.
 */

const program = new Command()
  .name('atlas')
  .description(
    'Atlas: search & ask across all your projects’ history (kdb logs, Claude Code sessions, git, docs).\n' +
      'Beta: treat results as leads, not ground truth — `ask` answers come from a mid-size LLM and can be\n' +
      'incomplete or wrong; verify important claims against the cited sources. Use --json for scripting/agents.',
  )
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
  .option('-s, --source <types>', 'one source type or a comma-separated subset (doc,kdb_component)')
  .option('-c, --component <name>')
  .option('-k, --kind <kind>', 'insight | plan | summary | action | prompt | response')
  .option(
    '-m, --machine <name>',
    'first ingested from — shared git-synced content belongs to whichever machine synced first',
  )
  .option('-n, --limit <n>', 'max results', '10')
  .option('--doc-status <s>', 'active (exclude archived docs) | archived (only them)')
  .description('hybrid search across all indexed history')
  .action(async (words, o) => {
    const r = await get(
      `/api/search${qs({ q: words.join(' '), project: o.project, source: o.source, component: o.component, kind: o.kind, machine: o.machine, docStatus: o.docStatus, limit: o.limit })}`,
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

const machinesCmd = program
  .command('machines')
  .description('fleet status and config (config/machines.yaml) — see subcommands');

machinesCmd
  .command('list', { isDefault: true })
  .description('fleet status: sync health, last success, bytes per machine (from /api/machines)')
  .action(async () => {
    const r = await get('/api/machines');
    out(r, () => {
      if (!r.machines.length) {
        console.log(dim('single-machine mode — no config/machines.yaml configured'));
        return;
      }
      for (const m of r.machines) {
        const tag = m.name === r.self ? ' (self)' : '';
        console.log(
          `${bold((m.name + tag).padEnd(26))} ${dim(m.address.padEnd(16))} ` +
            `${m.enabled ? green('enabled ') : dim('disabled')}  ${syncBadge(m.sync?.status)}  ` +
            `${dim('last success')} ${date(m.sync?.lastSuccessAt) || dim('never')}  ${bytes(m.sync?.bytes)}`,
        );
        if (m.sync?.error) console.log(`   ${red(m.sync.error)}`);
      }
      // Fleet-wide, matching the wire shape: a divergence is a disagreement
      // BETWEEN machines about one project's identity (spec §5), so it hangs
      // off the response, not off a single machine row. This used to read a
      // per-machine field the API never sent — dead code that rendered
      // nothing no matter how many divergences the scheduler had recorded.
      if (Array.isArray(r.divergences) && r.divergences.length) {
        console.log('');
        for (const w of r.divergences) console.log(yellow(`⚠ ${w}`));
      }
    });
  });

machinesCmd
  .command('add')
  .description('register a machine in config/machines.yaml (edits the checkout — commit + push after)')
  .requiredOption('--name <name>', 'machine name — frozen once it has indexed data')
  .requiredOption('--address <address>', 'IP or LAN DNS name resolvable from peers (not *.local)')
  .requiredOption('--user <user>', 'SSH user on that machine')
  .option(
    '--code-root <path>',
    'a code root to sync (repeatable: --code-root a --code-root b)',
    (v: string, prev: string[]) => [...prev, v],
    [] as string[],
  )
  .requiredOption('--claude-projects <path>', 'that machine\'s ~/.claude/projects directory')
  .option(
    '--skip-preflight',
    'DANGEROUS: skip the reachability + openrsync check. Only for pre-provisioning a ' +
      'machine that is not reachable yet — until you verify it manually (docs/multi-machine.md ' +
      'step 4), its first sync job may fail outright, or run against openrsync with different ' +
      '--delete/filter semantics than the sync engine assumes.',
  )
  .action(async (o) => {
    if (!o.codeRoot.length) {
      console.error(red('at least one --code-root is required'));
      process.exitCode = 1;
      return;
    }

    if (o.skipPreflight) {
      console.warn(
        yellow(
          `⚠️  --skip-preflight: enrolling "${o.name}" WITHOUT verifying it is reachable or that its ` +
            `rsync is GNU rsync (not openrsync). Verify manually before the first sync: ` +
            `ssh ${o.user}@${o.address} ${DEFAULT_REMOTE_RSYNC_PATH} --version`,
        ),
      );
    } else {
      const preflightExec: Exec = async (cmd, args, opts) => {
        const r = await execFile(cmd, args, { timeout: opts?.timeoutMs });
        return { stdout: r.stdout };
      };
      const result = await checkRemoteRsync(preflightExec, {
        user: o.user,
        address: o.address,
        remoteRsyncPath: DEFAULT_REMOTE_RSYNC_PATH,
      });
      if (!result.ok) {
        if (result.reason === 'unreachable') {
          console.error(
            red(
              `cannot reach ${o.user}@${o.address} (${result.detail}) — the machine must be reachable ` +
                `to enroll (ssh-keyscan needs it too, see docs/multi-machine.md step 3). Use ` +
                `--skip-preflight only to pre-provision a machine that is genuinely offline right now.`,
            ),
          );
        } else if (result.reason === 'openrsync') {
          console.error(
            red(
              `${o.address}'s rsync is openrsync ("${result.detail}") — stock macOS /usr/bin/rsync, ` +
                `whose --delete/filter semantics differ from GNU rsync (docs/multi-machine.md step 4). ` +
                `Run "brew install rsync" on ${o.address}, then retry.`,
            ),
          );
        } else {
          console.error(
            red(
              `could not verify ${o.address}'s rsync — unexpected "--version" output ` +
                `("${result.detail}"), refusing as suspect (docs/multi-machine.md step 4).`,
            ),
          );
        }
        process.exitCode = 1;
        return;
      }
    }

    const path = machinesFilePath();
    const docText = existsSync(path) ? readFileSync(path, 'utf8') : 'machines: []\n';
    try {
      const updated = addMachine(docText, {
        name: o.name,
        address: o.address,
        user: o.user,
        codeRoots: o.codeRoot,
        claudeProjects: o.claudeProjects,
      });
      writeFileSync(path, updated);
      console.log(green(`added "${o.name}" to ${path} — commit + push, then enable it on the next restart`));
    } catch (e) {
      console.error(red(`could not add machine: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });

machinesCmd
  .command('remove <name>')
  .description(
    'remove a machine from config/machines.yaml — refused if it has ever synced (frozen-name rule, spec §3)',
  )
  .action(async (name) => {
    const path = machinesFilePath();
    if (!existsSync(path)) {
      console.error(red(`${path} does not exist — nothing to remove`));
      process.exitCode = 1;
      return;
    }
    // Fail closed: an unreachable API means sync history can't be ruled out.
    let status: any;
    try {
      status = await get('/api/machines');
    } catch (e) {
      console.error(
        red(`cannot verify sync history — API unreachable (${(e as Error).message}); refusing to remove`),
      );
      process.exitCode = 1;
      return;
    }
    const known = status.machines.find((x: any) => x.name === name);
    if (known?.sync) {
      console.error(
        red(`"${name}" has sync history — removing it would orphan indexed data (frozen-name rule)`),
      );
      process.exitCode = 1;
      return;
    }
    try {
      const updated = removeMachine(readFileSync(path, 'utf8'), name);
      writeFileSync(path, updated);
      console.log(green(`removed "${name}" from ${path} — commit + push`));
    } catch (e) {
      console.error(red(`could not remove machine: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });

program
  .command('connect')
  .requiredOption('--token <token>', 'bearer token for this fleet (must match ATLAS_TOKEN on every machine)')
  .description('save a fleet token to ~/.atlas/credentials (mode 0600), then probe and report the active instance')
  .action(async (o) => {
    // Saved before the probe, deliberately: the token should stick even if
    // the fleet isn't reachable right now (spec §8 — this is a config step,
    // not a connectivity check).
    writeCredentials(o.token);
    try {
      const resolved = await resolveActive({ machinesFile: machinesFilePath(), token: o.token, cachePath: null });
      out(resolved, () => {
        console.log(green(`connected: ${resolved.machine} (${resolved.baseUrl})`));
        console.log(dim(`  mcp  ${resolved.mcpUrl}`));
        console.log(dim(`  ui   ${resolved.uiUrl}`));
      });
    } catch (e) {
      if (!(e instanceof AtlasResolveError)) throw e;
      out({ error: e.detail }, () => console.error(red(e.detail)));
      process.exitCode = 1;
    }
  });

program
  .command('which')
  .description('probe every machine in config/machines.yaml right now (ignores the resolver cache) and show which one is active')
  .action(async () => {
    const machinesFile = machinesFilePath();
    const token = readToken();
    const mf = loadMachinesFileIfPresent(machinesFile);

    // "Ignores the resolver cache" has to mean it, for the caller too: this
    // command exists to be believed after something moved, so drop any
    // cached entry before probing rather than leaving the NEXT command
    // (which does read the cache) trusting a host this probe may have just
    // shown to be gone.
    invalidateCache();

    if (!mf || mf.machines.length === 0) {
      out({ rows: [], winner: undefined }, () => {
        console.log(dim(`single-machine mode — no ${machinesFile}`));
      });
      return;
    }

    // Two probe rounds, deliberately: this loop probes every configured
    // machine individually (for the display table, including losers)
    // while `resolveActive` below probes them again to apply the
    // exactly-one-active rule (spec §8) — reusing its selection logic
    // rather than re-deriving it here, at the cost of one extra round trip
    // per machine for a command that exists purely to be a diagnostic.
    const rows: WhichRow[] = await Promise.all(
      mf.machines.map(async (m) => ({
        name: m.name,
        address: m.address,
        outcome: await probeInstance(`http://${m.address}:${RESOLVER_API_PORT}`, token),
      })),
    );

    let winner: string | undefined;
    let errorDetail: string | undefined;
    try {
      winner = (await resolveActive({ machinesFile, token, cachePath: null })).machine;
    } catch (e) {
      if (!(e instanceof AtlasResolveError)) throw e;
      errorDetail = e.detail;
    }

    out({ rows, winner, error: errorDetail }, () => {
      for (const line of formatWhichRows(rows, winner)) console.log(line);
      if (errorDetail) console.log(`\n${red(errorDetail)}`);
    });
    if (errorDetail) process.exitCode = 1;
  });

program
  .command('open')
  .description('resolve the active instance and open its UI (macOS: default browser; elsewhere: prints the URL)')
  .action(async () => {
    try {
      const resolved = await resolveActive({ machinesFile: machinesFilePath(), token: readToken() });
      if (process.platform === 'darwin') {
        await execFile('open', [resolved.uiUrl]);
      } else {
        console.log(resolved.uiUrl);
      }
    } catch (e) {
      if (!(e instanceof AtlasResolveError)) throw e;
      console.error(red(e.detail));
      process.exitCode = 1;
    }
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

/** open = needs attention, resolved = settled, dropped = deliberately let go. */
const statusPaint = (s: string) => (s === 'resolved' ? green : s === 'dropped' ? dim : yellow);

function printBacklogItem(i: any) {
  const paint = statusPaint(i.status);
  const prov = i.provenance !== 'default' ? dim(` (${i.provenance})`) : '';
  const lints = i.lints?.length ? ` ${red(`[${i.lints.join(', ')}]`)}` : '';
  console.log(
    `${dim(`L${String(i.line).padEnd(4)}`)} ${paint(i.status.padEnd(8))}${prov}${lints} ${dim(date(i.date))}${i.component ? ` ${yellow(i.component)}` : ''}\n` +
      `      ${i.text.replace(/\s+/g, ' ').slice(0, 140)}`,
  );
}

program
  .command('backlog')
  .argument('[project]', 'project slug; omit for a cross-project summary')
  .option('--review', 'review open items against project history (Atlas LLM judges, sequential)')
  .option('--item <line>', 'review one item by its line number (any status)')
  .option('--limit <n>', 'max items per review run', '10')
  .description('backlog status: what is open, resolved, dropped — optionally reviewed against the indexed history')
  .action(async (project, o) => {
    if (!project) {
      const projects = await get('/api/projects');
      const rows: any[] = [];
      for (const p of projects) {
        try {
          const v = await get(`/api/projects/${p.slug}/backlog`);
          if (v.items.length) rows.push({ slug: p.slug, ...v.counts });
        } catch {
          /* projects without kdb or with errors just don't appear */
        }
      }
      out(rows, () => {
        for (const r of rows) {
          console.log(
            `${bold(r.slug.padEnd(28))} ${yellow(`${String(r.open).padStart(4)} open`)}  ${green(`${String(r.resolved).padStart(4)} resolved`)}  ${dim(`${String(r.dropped).padStart(3)} dropped`)}`,
          );
        }
      });
      return;
    }

    const view = await get(`/api/projects/${project}/backlog`);

    if (!o.review && !o.item) {
      out(view, () => {
        const c = view.counts;
        console.log(
          `${yellow(`${c.open} open`)}  ${green(`${c.resolved} resolved`)}  ${dim(`${c.dropped} dropped`)}\n${hr()}`,
        );
        for (const i of view.items) printBacklogItem(i);
        if (view.unlinked.length) {
          console.log(`${hr()}\n${red(`${view.unlinked.length} unlinked resolution marker(s)`)} ${dim('(no confident target — link by appending a structured RESOLVED [L<n>#<hash>] line)')}`);
          for (const u of view.unlinked) {
            console.log(`${dim(`L${u.line}`)} ${u.kind.toUpperCase()} ${u.text.replace(/\s+/g, ' ').slice(0, 120)}`);
            for (const cand of u.candidates ?? []) {
              console.log(dim(`      candidate L${cand.line} (${cand.score.toFixed(2)}): ${cand.text.slice(0, 90)}`));
            }
          }
        }
      });
      return;
    }

    // Review mode: one API call per item, sequential — each is retrieval + an
    // LLM judgment, and hammering the local model in parallel buys nothing.
    let targets = o.item
      ? view.items.filter((i: any) => i.line === Number(o.item))
      : view.items.filter((i: any) => i.status === 'open');
    if (!targets.length) {
      console.error(red(o.item ? `no backlog item at line ${o.item}` : 'no open items to review'));
      process.exitCode = 1;
      return;
    }
    const limit = Math.max(1, Number(o.limit ?? 10));
    const skipped = Math.max(0, targets.length - limit);
    targets = targets.slice(0, limit);

    const results: any[] = [];
    for (const [n, item] of targets.entries()) {
      if (!isJson()) {
        console.log(`${dim(`[${n + 1}/${targets.length}]`)} ${bold(`L${item.line}`)} ${item.text.replace(/\s+/g, ' ').slice(0, 110)}`);
      }
      try {
        const r = await post(`/api/projects/${project}/backlog/review`, {
          line: item.line,
          sourcePath: item.sourcePath,
        });
        results.push(r);
        if (!isJson()) {
          const v = r.verdict;
          const paint = v.status === 'confirmed-resolved' ? green : v.status === 'confirmed-open' ? yellow : dim;
          console.log(`   ${paint(v.status)} ${dim(`(${(v.confidence ?? 0).toFixed(2)})`)} ${v.reasoning ?? ''}`);
          if (r.proposedLine) console.log(`   ${cyan('append:')} ${r.proposedLine}`);
        }
      } catch (e) {
        // The API returns the evidence with an explicit llm_unavailable rather
        // than a fabricated verdict; every later item would hit the same wall.
        console.error(red(`review failed: ${(e as Error).message}`));
        process.exitCode = 1;
        break;
      }
    }
    if (skipped && !isJson()) {
      console.log(yellow(`${skipped} more open item(s) not reviewed — raise --limit`));
    }
    if (isJson()) console.log(JSON.stringify(results, null, 2));
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
  .command('usage')
  .option('-d, --days <n>', 'window in days', '7')
  .description('how agents (MCP/CLI) have been using Atlas: calls, latency, errors')
  .action(async (o) => {
    const r = await get(`/api/admin/usage${qs({ days: o.days })}`);
    out(r, () => {
      console.log(
        `${bold('last ' + r.days + ' days')}  ${num(r.calls)} calls · ${r.clients} client kind${r.clients === 1 ? '' : 's'} · ` +
          (r.errors > 0 ? red(`${num(r.errors)} errors`) : green('no errors')),
      );
      if (!r.byTool.length) {
        console.log(dim('no recorded agent traffic yet — MCP and CLI calls land here'));
        return;
      }
      console.log(dim('\nby tool:'));
      for (const t of r.byTool) {
        console.log(
          `  ${magenta(t.client.padEnd(4))} ${bold(String(t.tool).padEnd(28))} ${num(t.calls).padStart(6)} calls  ` +
            `${String(t.avg_ms).padStart(6)}ms avg  ${String(t.max_ms).padStart(7)}ms max  ` +
            (t.errors > 0 ? red(`${t.errors} err`) : dim('0 err')) +
            `  ${dim(date(t.last_at))}`,
        );
      }
      if (r.byDay.length) {
        console.log(dim('\nby day:'));
        for (const d of r.byDay) {
          console.log(`  ${d.day}  ${magenta(d.client.padEnd(4))} ${num(d.calls).padStart(6)} calls`);
        }
      }
    });
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
      // Called out separately from `errors` because it is a different failure:
      // nothing errored *now*, yet this much of the catalog cannot be found by
      // search. It stays quiet at zero rather than adding a permanently-green
      // line nobody reads.
      if (r.unsearchableEntries > 0) {
        console.log(
          `${bold('coverage')}  ${red(`${num(r.unsearchableEntries)} entries not searchable`)}` +
            dim(' (awaiting re-embed)'),
        );
      }
      console.log(`${bold('embedder')}  ${r.embedder} → ${dim(r.collection)}`);
      console.log(`${bold('last run')}  ${date(r.lastRunAt) || dim('never')}`);
      if (Array.isArray(r.activity) && r.activity.length) {
        const today = new Date().toISOString().slice(0, 10);
        const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
        const sum = (from: string) =>
          r.activity.filter((a: any) => a.day >= from).reduce((s: number, a: any) => s + a.count, 0);
        console.log(
          `${bold('activity')}  ${num(sum(today))} entries today · ${num(sum(weekAgo))} last 7 days`,
        );
      }
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
      const detail = new Map(((r.sourceDetail ?? []) as any[]).map((d) => [d.sourceType, d]));
      for (const [k, v] of Object.entries(r.bySource ?? {})) {
        const d = detail.get(k);
        const extra = d
          ? dim(
              `  ${num(d.files).padStart(7)} files  ${bytes(d.volumeChars).padStart(9)}  last ${date(d.lastIndexedAt) || 'never'}`,
            )
          : '';
        console.log(`  ${(SOURCE_BADGE[k] ?? k).padEnd(12)} ${num(v as number).padStart(9)}${extra}`);
      }
      if (r.archivedDocs > 0) {
        console.log(
          dim(`  ${num(r.archivedDocs)} doc sections under archive paths — indexed, downranked`),
        );
      }
    });
  });

/**
 * Measures whether agents actually reach for Assessor/Atlas at the moments the
 * MCP instructions say they should. Reads Claude Code transcripts directly
 * rather than asking the agent: self-reported non-use is unreliable by
 * construction — an agent that never noticed a trigger will produce a fluent
 * post-hoc justification when asked. Tool calls and the reasoning around them
 * are both already on disk, so we count instead of surveying.
 */
program
  .command('adoption')
  .description('Are agents calling Assessor/Atlas when they should? (reads Claude Code transcripts)')
  .option('--since <date>', 'Only sessions on/after this ISO date')
  .option('--until <date>', 'Only sessions before this ISO date (exclusive)')
  .option(
    '--compare <date>',
    'Split at this date and diff the two windows — did an instruction change move the needle?',
  )
  .option('--project <substr>', 'Filter by project directory name')
  .option('--min-turns <n>', 'Ignore sessions below N assistant turns', '5')
  .option('--limit <n>', 'Max sessions to detail', '15')
  // --json is a global option on `program`; declaring it again here would shadow
  // it and silently never bind. Read it through the shared out() helper instead.
  .action(async (o) => {
    const { analyzeAdoption, compareAdoption } = await import('@atlas/core');
    const base = {
      since: o.since,
      until: o.until,
      project: o.project,
      minTurns: Number(o.minTurns) || 5,
    };

    if (o.compare) {
      const c = await compareAdoption(o.compare, base);
      out(c, () => {
        console.log(bold(`\nAdoption before vs after ${o.compare}`));
        console.log(
          dim(
            `${num(c.before.report.sessionsScanned)} sessions before · ` +
              `${num(c.after.report.sessionsScanned)} after\n`,
          ),
        );
        for (const [name, d] of [
          ['assessor', c.assessor],
          ['atlas', c.atlas],
        ] as const) {
          const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
          // Raw counts always shown: at these sample sizes they are the honest
          // signal and the percentage is the misleading one.
          const arrow =
            d.fireRateDelta === null
              ? dim('—')
              : d.fireRateDelta > 0
                ? green(`+${(d.fireRateDelta * 100).toFixed(0)}pp`)
                : d.fireRateDelta < 0
                  ? red(`${(d.fireRateDelta * 100).toFixed(0)}pp`)
                  : dim('0pp');
          console.log(
            `${bold(name.padEnd(9))} ${pct(d.before.fireRate)} → ${pct(d.after.fireRate)}  ${arrow}` +
              dim(`   (n=${d.beforeN} → ${d.afterN})`) +
              (d.significant ? '' : yellow('  ⚠ small sample')),
          );
          console.log(
            dim(
              `          used ${d.before.sessionsUsed}→${d.after.sessionsUsed} · ` +
                `missed ${d.before.sessionsMissed}→${d.after.sessionsMissed} · ` +
                `calls ${d.before.totalCalls}→${d.after.totalCalls}`,
            ),
          );
        }

        if (c.regressedRules.length) {
          console.log(bold('\nGot worse:'));
          for (const r of c.regressedRules.slice(0, 5)) {
            console.log(`  ${red('▲')} ${r.rule.padEnd(30)} ${r.before} → ${r.after}`);
          }
        }
        if (c.improvedRules.length) {
          console.log(bold('\nImproved:'));
          for (const r of c.improvedRules.slice(0, 5)) {
            console.log(`  ${green('▼')} ${r.rule.padEnd(30)} ${r.before} → ${r.after}`);
          }
        }

        console.log(hr());
        for (const caveat of c.caveats) console.log(yellow(`! ${caveat}`));
        console.log();
      });
      return;
    }

    const r = await analyzeAdoption(base);
    out(r, () => {
    console.log(bold(`\nTool adoption — ${num(r.sessionsScanned)} sessions scanned`));
    console.log(dim(`${num(r.sessionsWithTriggers)} contained at least one trigger\n`));

    for (const [name, t] of [
      ['assessor', r.assessor],
      ['atlas', r.atlas],
    ] as const) {
      // fireRate is null when nothing qualified — "no opportunities" must not
      // render as "never fired".
      const rate =
        t.fireRate === null ? dim('n/a') : `${(t.fireRate * 100).toFixed(0)}%`;
      const colour = t.fireRate === null ? dim : t.fireRate >= 0.5 ? green : red;
      console.log(
        `${bold(name.padEnd(9))} used in ${num(t.sessionsUsed)} · missed in ${num(t.sessionsMissed)} · ` +
          `fire rate ${colour(rate)} · ${num(t.totalCalls)} calls`,
      );
      for (const { rule, count } of t.topMissedRules.slice(0, 4)) {
        console.log(dim(`    ${String(count).padStart(3)}×  ${rule}`));
      }
    }

    const admitted = r.sessions.filter((s) => s.admittedNotThoughtOf);
    if (admitted.length) {
      console.log(
        yellow(
          `\n${num(admitted.length)} session(s) where the agent said it didn't think of the tool` +
            dim(' — the clearest instruction gap'),
        ),
      );
    }

    console.log(hr());
    console.log(bold('Candidate missed triggers') + dim(' — heuristic; verify before acting'));
    for (const s of r.sessions.slice(0, Number(o.limit) || 15)) {
      const misses = [...s.missedAssessor, ...s.missedAtlas];
      if (!misses.length) continue;
      console.log(
        `\n${cyan(s.sessionId.slice(0, 8))} ${dim(s.project)} ${dim(date(s.startedAt) || '')} ${dim(`${s.turns} turns`)}`,
      );
      for (const m of misses) {
        console.log(`  ${magenta(m.tool)} ${bold(m.rule)}`);
        console.log(dim(`    "${m.excerpt.slice(0, 160)}"`));
      }
    }
    if (!r.sessions.length) console.log(dim('\n  none found'));
    console.log();
    });
  });

program.parseAsync().catch((e) => {
  console.error(red(`error: ${e.message}`));
  process.exit(1);
});
