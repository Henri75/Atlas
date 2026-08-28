import { useEffect, useRef, useState } from 'react';
import {
  ENTRY_KIND_META as KIND,
  SESSION_SECTIONS,
  describeDid,
  sectionMeta,
  type SessionInsightResponse,
} from '@atlas/shared';
import { api } from '../../api';
import { Markdown } from '../../components/Markdown';
import { Badge, Empty, Eyebrow, Spinner, Stamp } from '../../components/ui';
import { usePersistentState } from '../../usePersistentState';
import { compact, plural } from '../../format';

/**
 * The insight report.
 *
 * Two things this component must never do, both of which are trust failures
 * rather than aesthetic ones: present a model's reading of a session as if it
 * were recorded fact, and render an empty frame when the model is unavailable.
 * Hence the AI mark on every generated block, and a deterministic report that
 * stands entirely on its own underneath.
 */

function AiMark({ title }: { title?: string }) {
  return (
    <span
      className="font-mono text-[9px] tracking-widest px-1 py-0.5 rounded-sm align-middle"
      title={title ?? 'Written by a language model from the evidence below — verify before relying on it'}
      style={{
        color: 'var(--color-claude)',
        background: 'color-mix(in srgb, var(--color-claude) 12%, transparent)',
      }}
    >
      AI
    </span>
  );
}

function Section({
  id,
  children,
  count,
}: {
  id: string;
  children: React.ReactNode;
  count?: number;
}) {
  const meta = sectionMeta(id);
  return (
    <section className="mt-6" aria-labelledby={`sec-${id}`}>
      <div className="flex items-baseline gap-2 mb-2">
        <h3
          id={`sec-${id}`}
          className="font-display uppercase tracking-[0.18em] text-[11px] text-muted"
        >
          {meta.label}
        </h3>
        {meta.source !== 'facts' && <AiMark />}
        {count != null && <span className="font-mono text-[10px] text-faint">{count}</span>}
      </div>
      {children}
    </section>
  );
}

/** Section picker. The user's choice persists — a report is a personal shape. */
function SectionPicker({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Report sections">
      {SESSION_SECTIONS.map((s) => {
        const on = selected.includes(s.id);
        const color = s.source === 'facts' ? 'var(--color-kdb)' : 'var(--color-claude)';
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onToggle(s.id)}
            aria-pressed={on}
            title={`${s.blurb}${s.source === 'facts' ? '' : ' — needs a model call'}`}
            className="font-mono text-[10px] tracking-widest px-2 py-1 rounded-sm border transition-colors"
            style={{
              color: on ? color : 'var(--color-faint)',
              borderColor: on ? color : 'var(--color-line)',
              background: on ? `color-mix(in srgb, ${color} 12%, transparent)` : 'transparent',
            }}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

export function SessionInsightsPanel({ sessionId }: { sessionId: string }) {
  const [sections, setSections] = usePersistentState<string[]>(
    'atlas.session.sections',
    SESSION_SECTIONS.map((s) => s.id),
  );
  const [useLlm, setUseLlm] = usePersistentState<boolean>('atlas.session.llm', true);
  const [report, setReport] = useState<SessionInsightResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Toggling sections re-requests, and a report with the AI layer on can take
  // many seconds while one without it returns immediately — so an earlier
  // request can easily land after a later one and overwrite it.
  const seq = useRef(0);
  const load = (refresh = false) => {
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    api
      .sessionInsights(sessionId, {
        sections: sections.join(','),
        llm: useLlm ? undefined : 'false',
        ...(refresh ? { refresh: '1' } : {}),
      })
      .then((r) => {
        if (mine === seq.current) setReport(r);
      })
      .catch((e: Error) => {
        if (mine === seq.current) setError(e.message);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  };

  // Generated on demand — never prefetched. The LLM layer costs a completion,
  // so it is bought when a reader actually opens the report.
  useEffect(() => {
    setReport(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sections.join(','), useLlm]);

  const toggle = (id: string) =>
    setSections((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));

  if (error) {
    return <Empty title="Could not build the report." hint={error} />;
  }
  if (loading && !report) return <Spinner label="reading the session" />;
  if (!report) return null;

  const f = report.facts;
  const n = report.narrative;
  const show = (id: string) => sections.includes(id);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 pb-3 border-b border-line">
        <SectionPicker selected={sections} onToggle={toggle} />
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 font-mono text-[10px] text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={useLlm}
            onChange={(e) => setUseLlm(e.target.checked)}
            className="accent-[var(--color-claude)]"
          />
          AI layer
        </label>
        <button
          type="button"
          onClick={() => load(true)}
          className="font-mono text-[10px] text-muted hover:text-ink underline underline-offset-2"
        >
          regenerate
        </button>
      </div>

      {/* Provenance, always visible. A cached report and a fresh one are not the
          same claim, and neither is a report whose model was unreachable. */}
      <p className="mt-2 font-mono text-[10px] text-faint">
        {report.llm.status === 'ok' && `AI layer by ${report.llm.model ?? 'the configured model'}`}
        {report.llm.status === 'off' && 'Recorded facts only — the AI layer is off.'}
        {report.llm.status === 'unavailable' && (
          <span style={{ color: 'var(--color-report)' }}>
            AI layer unavailable ({report.llm.reason ?? 'no reason given'}) — everything below is
            recorded fact.
          </span>
        )}
        {report.cached && ' · cached'}
        {loading && ' · refreshing…'}
      </p>

      {n?.headline && (
        <p className="mt-4 text-[15px] leading-snug">
          <AiMark /> <span className="ml-1">{n.headline}</span>
        </p>
      )}
      {n?.summary?.length ? (
        <ul className="mt-2 space-y-1 text-[13px] text-muted">
          {n.summary.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      ) : null}

      {show('overview') && (
        <Section id="overview">
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
            <span>{f.overview.projectSlug}</span>
            <Stamp iso={f.overview.startedAt} />
            <span>{plural(f.overview.entryCount, 'message')}</span>
            <span>{compact(f.overview.actionCount)} actions</span>
            <span>{plural(f.overview.fileCount, 'file')}</span>
            {f.overview.machine && <span>{f.overview.machine}</span>}
          </div>
          {f.overview.cwd && (
            <p className="mt-1 font-mono text-[11px] text-faint break-all">{f.overview.cwd}</p>
          )}
        </Section>
      )}

      {show('goals') && f.goals?.length ? (
        <Section id="goals" count={f.goals.length}>
          <ol className="space-y-2">
            {f.goals.map((g) => (
              <li
                key={g.entryId}
                className="border-l-2 pl-2.5 text-[13px]"
                style={{ borderLeftColor: KIND.prompt.color }}
              >
                <Markdown text={g.text} compact className="text-ink/90" />
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {show('did') && f.did ? (
        <Section id="did">
          <p className="font-mono text-[11px] text-muted">
            {describeDid(f.did) || 'No recorded tool activity.'}
          </p>
          {f.did.commands.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {f.did.commands.map((c) => (
                <span
                  key={c.name}
                  className="font-mono text-[10px] px-1.5 py-0.5 rounded-sm bg-panel-2 text-muted"
                >
                  {c.name}
                  <span className="text-faint"> ×{c.count}</span>
                </span>
              ))}
            </div>
          )}
          {f.did.files.length > 0 && (
            <ul className="mt-2 font-mono text-[11px] text-muted space-y-0.5">
              {f.did.files.map((x) => (
                <li key={x.path} className="truncate">
                  {x.path}
                  {x.count > 1 && <span className="text-faint"> ×{x.count}</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {show('highlights') && f.highlights?.length ? (
        <Section id="highlights" count={f.highlights.length}>
          <div className="space-y-2">
            {f.highlights.map((h) => (
              <div
                key={h.entryId}
                className="border-l-2 pl-2.5"
                style={{ borderLeftColor: KIND[h.kind].color }}
              >
                <span
                  className="font-mono text-[9px] tracking-widest"
                  style={{ color: KIND[h.kind].color }}
                >
                  {KIND[h.kind].label}
                </span>
                <Markdown text={h.text} compact className="text-[13px] text-ink/90" />
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {show('decisions') && n?.decisions?.length ? (
        <Section id="decisions" count={n.decisions.length}>
          <ul className="space-y-2">
            {n.decisions.map((d, i) => (
              <li key={i} className="text-[13px]">
                <span className="text-ink">{d.text}</span>
                {d.why && <span className="text-muted"> — {d.why}</span>}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {show('problems') && n?.problems?.length ? (
        <Section id="problems" count={n.problems.length}>
          <ul className="space-y-2">
            {n.problems.map((p, i) => (
              <li key={i} className="text-[13px]">
                <span className="text-ink">{p.text}</span>
                {p.resolution && <span className="text-muted"> → {p.resolution}</span>}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {show('followups') && (n?.followups?.length || f.followupMarkers?.length) ? (
        <Section id="followups" count={n?.followups?.length ?? f.followupMarkers?.length}>
          {n?.followups?.length ? (
            <ul className="space-y-1.5 text-[13px]">
              {n.followups.map((x, i) => (
                <li key={i}>
                  {x.text}
                  {x.confidence && (
                    <span className="font-mono text-[10px] text-faint"> ({x.confidence})</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {/* The raw markers are shown alongside the distilled list, never
              replaced by it: a wrong distillation must be visible, not
              authoritative. */}
          {f.followupMarkers?.length ? (
            <details className="mt-2">
              <summary className="font-mono text-[10px] text-faint cursor-pointer">
                {f.followupMarkers.length} marker
                {f.followupMarkers.length === 1 ? '' : 's'} found in the transcript
              </summary>
              <ul className="mt-1.5 space-y-1">
                {f.followupMarkers.map((m, i) => (
                  <li key={i} className="text-[12px] text-muted">
                    <span className="font-mono text-[9px] tracking-widest text-faint mr-1.5">
                      {m.marker}
                    </span>
                    {m.sentence}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Section>
      ) : null}

      {show('backlog') && f.backlog?.length ? (
        <Section id="backlog" count={f.backlog.length}>
          <p className="font-mono text-[10px] text-faint mb-1.5">
            Open items whose wording overlaps this session — a lead to check, not a claim that
            they were resolved.
          </p>
          <ul className="space-y-1">
            {f.backlog.map((b) => (
              <li key={`${b.sourcePath}:${b.line}`} className="text-[12px] text-muted">
                <span className="font-mono text-[10px] text-faint mr-1.5">L{b.line}</span>
                {b.text}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {show('trail') && f.trail?.length ? (
        <Section id="trail" count={f.trail.length}>
          <div className="space-y-1.5">
            {f.trail.map((t) => (
              <div key={t.entryId} className="flex items-baseline gap-2 flex-wrap">
                <Badge source={t.sourceType} />
                <span className="text-[12px] flex-1 min-w-0 truncate">{t.title}</span>
                {t.sharedFiles?.length ? (
                  <span
                    className="font-mono text-[10px]"
                    style={{ color: 'var(--color-git)' }}
                    title={t.sharedFiles.join('\n')}
                  >
                    {t.sharedFiles.length} shared file
                    {t.sharedFiles.length === 1 ? '' : 's'}
                  </span>
                ) : null}
                <Stamp iso={t.occurredAt} />
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {sections.length === 0 && (
        <Empty title="No sections selected." hint="Pick at least one above." />
      )}
    </div>
  );
}
