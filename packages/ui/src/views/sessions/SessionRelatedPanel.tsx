import { useEffect, useState } from 'react';
import type { RelatedResponse } from '@atlas/shared';
import { api } from '../../api';
import { Badge, Empty, Eyebrow, Spinner, Stamp } from '../../components/ui';
import { usePersistentState } from '../../usePersistentState';
import { RelatedList, RelatedTimeline } from './RelatedTimeline';

/**
 * "What else worked on this, before and after."
 *
 * The chart and the list are the same data twice, deliberately: the chart
 * answers "when, and is this a cluster or a trickle", the list answers "which
 * one, and why". Hovering either highlights the other.
 */
export function SessionRelatedPanel({
  sessionId,
  onOpenSession,
}: {
  sessionId: string;
  onOpenSession: (id: string) => void;
}) {
  const [data, setData] = useState<RelatedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hovered, setHovered] = useState<string | undefined>();
  const [direction, setDirection] = usePersistentState<'both' | 'before' | 'after'>(
    'atlas.session.related.direction',
    'both',
  );
  const [crossProject, setCrossProject] = usePersistentState<boolean>(
    'atlas.session.related.cross',
    true,
  );

  useEffect(() => {
    setData(null);
    setLoading(true);
    setError('');
    api
      .sessionRelated(sessionId, {
        ...(direction === 'both' ? {} : { direction }),
        crossProject: crossProject ? undefined : 'false',
      })
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [sessionId, direction, crossProject]);

  if (error) return <Empty title="Could not look for related sessions." hint={error} />;
  if (loading) return <Spinner label="tracing this work" />;
  if (!data) return null;

  const options: { key: 'both' | 'before' | 'after'; label: string }[] = [
    { key: 'both', label: 'both' },
    { key: 'before', label: 'before' },
    { key: 'after', label: 'after' },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 pb-3 border-b border-line">
        <div className="flex gap-1" role="group" aria-label="Direction">
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => setDirection(o.key)}
              aria-pressed={direction === o.key}
              className="font-mono text-[10px] tracking-widest px-2 py-1 rounded-sm border"
              style={{
                color: direction === o.key ? 'var(--color-kdb)' : 'var(--color-faint)',
                borderColor: direction === o.key ? 'var(--color-kdb)' : 'var(--color-line)',
                background:
                  direction === o.key
                    ? 'color-mix(in srgb, var(--color-kdb) 12%, transparent)'
                    : 'transparent',
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 font-mono text-[10px] text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={crossProject}
            onChange={(e) => setCrossProject(e.target.checked)}
            className="accent-[var(--color-kdb)]"
          />
          other projects
        </label>
        <div className="flex-1" />
        <span className="font-mono text-[10px] text-faint">{data.tookMs} ms</span>
      </div>

      {data.related.length > 0 && (
        <div className="mt-4">
          <RelatedTimeline
            data={data}
            onOpenSession={onOpenSession}
            selectedId={hovered}
            onSelect={setHovered}
          />
        </div>
      )}

      <div className="mt-5">
        {data.related.length > 0 ? (
          <>
            <Eyebrow>Related sessions</Eyebrow>
            <RelatedList
              data={data}
              onOpen={onOpenSession}
              hoveredId={hovered}
              onHover={setHovered}
            />
          </>
        ) : (
          <Empty
            title="Nothing else worked on this."
            hint={data.note ?? 'No other session shares this one’s files, subject or time window.'}
          />
        )}
      </div>

      {data.contextEvents?.length ? (
        <div className="mt-6">
          <Eyebrow>Other records touching the same files</Eyebrow>
          {/* The cross-source join: work on a thing is often recorded in a
              commit or a changelog rather than in another conversation. */}
          <div className="space-y-1.5">
            {data.contextEvents.map((e) => (
              <div
                key={e.entryId}
                className="flex items-baseline gap-2 flex-wrap px-3 py-1.5 rounded-md bg-panel"
              >
                <Badge source={e.sourceType} />
                <span className="text-[12px] flex-1 min-w-0 truncate">{e.title}</span>
                <span
                  className="font-mono text-[10px]"
                  style={{ color: 'var(--color-git)' }}
                  title={e.sharedFiles.join('\n')}
                >
                  {e.sharedFiles.length} shared
                </span>
                <Stamp iso={e.occurredAt} />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
