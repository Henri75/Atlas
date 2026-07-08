import { useEffect, useState } from 'react';
import { api } from '../api';
import type { TimelineItem } from '../types';
import { Badge, Empty, Eyebrow, SpineRow, Spinner, Stamp } from '../components/ui';

/**
 * The core-sample rail: a project's merged history, newest first, grouped by
 * day with mono date rulers. Source colors make the strata readable at a glance.
 */
export function TimelineView({
  project,
  onOpenSession,
}: {
  project: string;
  onOpenSession: (id: string) => void;
}) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const load = async (before?: string) => {
    if (!project) return;
    setLoading(true);
    try {
      const r = await api.timeline(project, { limit: 60, before });
      setItems((prev) => (before ? [...prev, ...r.items] : r.items));
      setDone(r.items.length < 60);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setItems([]);
    setDone(false);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  if (!project) return <Empty title="Pick a project to see its timeline." />;

  let lastDay = '';
  return (
    <div className="max-w-4xl mx-auto">
      <Eyebrow>Timeline — {project}</Eyebrow>
      <div className="space-y-1.5">
        {items.map((t) => {
          const day = t.occurredAt.slice(0, 10);
          const ruler = day !== lastDay;
          lastDay = day;
          return (
            <div key={t.entryId}>
              {ruler && (
                <div className="flex items-center gap-3 pt-4 pb-1.5">
                  <span className="font-mono text-[11px] text-faint">{day}</span>
                  <div className="flex-1 h-px bg-line" />
                </div>
              )}
              <SpineRow
                source={t.sourceType}
                onClick={t.sessionId ? () => onOpenSession(t.sessionId!) : undefined}
              >
                <div className="flex items-baseline gap-2">
                  <Stamp iso={t.occurredAt} />
                  <Badge source={t.sourceType} />
                  {t.component && (
                    <span className="font-mono text-[11px] text-muted">{t.component}</span>
                  )}
                </div>
                <div className="mt-0.5 text-[14px]">{t.title}</div>
              </SpineRow>
            </div>
          );
        })}
      </div>
      {loading && <Spinner />}
      {!loading && !done && items.length > 0 && (
        <button
          onClick={() => void load(items[items.length - 1]!.occurredAt)}
          className="mt-4 w-full py-2 text-sm text-muted bg-panel border border-line rounded-md hover:border-faint"
        >
          Load older
        </button>
      )}
      {!loading && items.length === 0 && <Empty title="No dated activity indexed yet." />}
    </div>
  );
}
