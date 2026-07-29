import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { ROUTE_CLASS_META, type UsageCallDetail } from '../../types';
import { Empty, Eyebrow, Spinner } from '../../components/ui';
import { Swatch, clientColor } from '../../components/charts';
import { compact, millis, plural, relativeTime } from '../../format';
import { describeQuery } from '../../describeQuery';
import { StatusBadge } from './CallsTab';

/**
 * One call in full: what was asked, what came back, what it cost.
 *
 * The point of the whole feature. An aggregate can say ask is slow; only this can
 * say whether the answer was worth the wait.
 */
export function CallDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const [call, setCall] = useState<UsageCallDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setCall(null);
    api
      .usageCall(id)
      .then((c) => live && (setCall(c), setError('')))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const reply = call?.reply;
  const asked = useMemo(() => describeQuery(call?.query), [call?.query]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
      <button className="flex-1 bg-black/40" aria-label="Close" onClick={onClose} />
      <div className="w-full max-w-2xl bg-panel border-l border-line overflow-y-auto rise">
        <div className="sticky top-0 bg-panel border-b border-line px-5 py-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="font-mono text-[11px] text-faint">call #{id}</div>
            <div className="font-display text-[15px] font-semibold truncate">
              {call?.tool ?? call?.path ?? '…'}
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink text-lg leading-none">
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-6">
          {error && <Empty title="Cannot load this call." hint={error} />}
          {!call && !error && <Spinner label="loading call" />}

          {call && (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px]">
                <Field label="When">
                  <span title={call.at}>{relativeTime(call.at)}</span>
                </Field>
                <Field label="Client">
                  <Swatch color={clientColor(call.client)}>{call.client}</Swatch>
                </Field>
                <Field label="Route">
                  <span className="font-mono text-[11.5px]">
                    {call.method} {call.path}
                  </span>
                </Field>
                <Field label="Class">
                  <span
                    className="font-mono text-[11.5px]"
                    title={ROUTE_CLASS_META[call.routeClass]?.hint}
                  >
                    {call.routeClass}
                  </span>
                </Field>
                <Field label="Took">{millis(call.durationMs)}</Field>
                <Field label="Outcome">
                  <StatusBadge status={call.status} />
                </Field>
                {reply?.model && (
                  <Field label="Model served">
                    {/* From the gateway's x-g2p-reply-model header, not the
                        response body — the body often echoes what was requested,
                        which would hide every substitution. */}
                    <span title="Reported by the gateway as the model that actually answered">
                      {reply.model}
                    </span>
                    {reply.attempts != null && reply.attempts > 1 && (
                      <span
                        className="ml-1.5 font-mono text-[10px]"
                        style={{ color: 'var(--color-report)' }}
                        title="The gateway failed over internally before it succeeded"
                      >
                        {reply.attempts} attempts
                      </span>
                    )}
                  </Field>
                )}
                {reply?.requestId && (
                  <Field label="Gateway request">
                    {/* The handle for correlating a suspect answer against the
                        gateway's own logs. Selectable, hence the mono span. */}
                    <span className="font-mono text-[11px] select-all">{reply.requestId}</span>
                  </Field>
                )}
                {reply?.ttftMs != null && <Field label="First token">{millis(reply.ttftMs)}</Field>}
                {reply?.promptTokens != null && (
                  <Field label="Tokens">
                    {compact(reply.promptTokens)} in
                    {reply.completionTokens != null
                      ? ` · ${compact(reply.completionTokens)} out`
                      : ''}
                  </Field>
                )}
                {reply?.resultCount != null && (
                  <Field label="Results">{plural(reply.resultCount, 'result')}</Field>
                )}
              </dl>

              {asked && (
                <section>
                  <Eyebrow>Asked</Eyebrow>
                  {asked.text ? (
                    <p className="text-[13.5px] whitespace-pre-wrap">{asked.text}</p>
                  ) : (
                    <p className="text-[12px] text-faint">no search text — filters only</p>
                  )}
                  {asked.filters.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {asked.filters.map((f) => (
                        <span
                          key={f.key}
                          className="font-mono text-[10px] px-1.5 py-0.5 rounded"
                          style={{ background: 'var(--color-panel-2)', color: 'var(--color-muted)' }}
                        >
                          {f.key}: {f.value}
                        </span>
                      ))}
                    </div>
                  )}
                  {/* The raw string stays available: this is a monitoring tool,
                      and a decoded view that cannot be checked against the
                      original is a view you have to trust. */}
                  {asked.decoded && (
                    <details className="mt-2">
                      <summary className="font-mono text-[10px] text-faint cursor-pointer hover:text-muted">
                        raw query string
                      </summary>
                      <code className="block mt-1 font-mono text-[10.5px] text-muted break-all">
                        {call.query}
                      </code>
                    </details>
                  )}
                </section>
              )}

              {reply?.degraded && (
                <p
                  className="rounded-md border px-3 py-2 text-[12px]"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--color-report) 45%, transparent)',
                    color: 'var(--color-report)',
                  }}
                >
                  Degraded answer — the LLM was unreachable, so Atlas returned the retrieved
                  sources with an explanation instead of a synthesis.
                </p>
              )}

              {reply?.error && (
                <section>
                  <Eyebrow>Failed with</Eyebrow>
                  <pre
                    className="text-[11.5px] font-mono whitespace-pre-wrap rounded-md border px-3 py-2"
                    style={{
                      borderColor: 'color-mix(in srgb, var(--color-report) 40%, transparent)',
                      color: 'var(--color-report)',
                    }}
                  >
                    {reply.error}
                  </pre>
                </section>
              )}

              {reply?.answer && (
                <section>
                  <Eyebrow>Atlas answered</Eyebrow>
                  <div className="text-[13.5px] whitespace-pre-wrap leading-relaxed">
                    {reply.answer}
                  </div>
                </section>
              )}

              {reply?.topHits && reply.topHits.length > 0 && (
                <section>
                  <Eyebrow>Top sources</Eyebrow>
                  <ol className="space-y-1.5">
                    {reply.topHits.map((h, i) => (
                      <li
                        key={`${h.entryId}-${i}`}
                        className="flex items-baseline gap-2 text-[12.5px]"
                      >
                        <span className="font-mono text-[10px] text-faint w-4 shrink-0">
                          {i + 1}
                        </span>
                        <span className="flex-1 min-w-0 truncate" title={h.title}>
                          {h.title}
                        </span>
                        <span className="font-mono text-[10px] text-faint shrink-0">
                          {h.projectSlug}
                        </span>
                        {h.score != null && (
                          <span
                            className="font-mono text-[10px] shrink-0"
                            style={{ color: 'var(--color-kdb)' }}
                            title="Fused hybrid-search score"
                          >
                            {h.score.toFixed(3)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {!call.hasReply && (
                <p className="text-[12px] text-faint">
                  No reply was recorded for this call. Replies are kept for search and ask only,
                  and only for calls made after reply capture shipped.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-wider text-faint">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
