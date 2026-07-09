import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ProjectRow, TimelineItem } from '../types';
import {
  Badge,
  Empty,
  Eyebrow,
  FilterInput,
  Highlight,
  PickProject,
  SpineRow,
  Spinner,
  Stamp,
  matches,
} from '../components/ui';
import { usePersistentState } from '../usePersistentState';

type Layout = 'feed' | 'table';

/**
 * Two ways to read a project's history:
 *  - feed: grouped by day, source colour on a spine (good for browsing).
 *  - table: date and time in their own columns (good for scanning when things
 *    happened). The choice is persisted — it is a working preference, not a
 *    per-visit decision.
 */
export function TimelineView({
  project,
  projects,
  onProject,
  onOpenSession,
}: {
  project: string;
  projects: ProjectRow[];
  onProject: (slug: string) => void;
  onOpenSession: (id: string) => void;
}) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [q, setQ] = useState('');
  const [layout, setLayout] = usePersistentState<Layout>('kdbscope.timeline.layout', 'feed');

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
    setQ('');
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const shown = useMemo(
    () => items.filter((t) => matches(t.title, q) || matches(t.component, q)),
    [items, q],
  );

  if (!project) return <PickProject what="timeline" projects={projects} onProject={onProject} />;

  const openIfSession = (t: TimelineItem) => (t.sessionId ? () => onOpenSession(t.sessionId!) : undefined);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-baseline justify-between">
        <Eyebrow>Timeline — {project}</Eyebrow>
        <div className="flex gap-1 mb-2" role="group" aria-label="Layout">
          {(['feed', 'table'] as Layout[]).map((l) => (
            <button
              key={l}
              onClick={() => setLayout(l)}
              aria-pressed={layout === l}
              className={`font-mono text-[10px] tracking-widest px-2 py-1 rounded-sm border ${
                layout === l
                  ? 'text-ink border-faint bg-panel-2'
                  : 'text-muted border-line hover:text-ink'
              }`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <FilterInput
        value={q}
        onChange={setQ}
        placeholder="Filter loaded entries by title or component…"
        count={{ shown: shown.length, total: items.length }}
      />

      {layout === 'table' ? (
        <TableLayout items={shown} needle={q} onOpen={openIfSession} />
      ) : (
        <FeedLayout items={shown} needle={q} onOpen={openIfSession} />
      )}

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
      {!loading && items.length > 0 && shown.length === 0 && (
        <Empty
          title="Nothing loaded matches that filter."
          hint="The filter searches what is loaded — try “Load older” for more."
        />
      )}
    </div>
  );
}

function FeedLayout({
  items,
  needle,
  onOpen,
}: {
  items: TimelineItem[];
  needle: string;
  onOpen: (t: TimelineItem) => (() => void) | undefined;
}) {
  let lastDay = '';
  return (
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
            <SpineRow source={t.sourceType} onClick={onOpen(t)}>
              <div className="flex items-baseline gap-2">
                <Stamp iso={t.occurredAt} />
                <Badge source={t.sourceType} />
                {t.component && (
                  <span className="font-mono text-[11px] text-muted">
                    <Highlight text={t.component} needle={needle} />
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[14px]">
                <Highlight text={t.title} needle={needle} />
              </div>
            </SpineRow>
          </div>
        );
      })}
    </div>
  );
}

/** Date and time as their own columns, so history is scannable by when. */
function TableLayout({
  items,
  needle,
  onOpen,
}: {
  items: TimelineItem[];
  needle: string;
  onOpen: (t: TimelineItem) => (() => void) | undefined;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="text-faint font-mono text-[10px] tracking-widest uppercase">
            <th className="py-1.5 pr-3 font-normal">Date</th>
            <th className="py-1.5 pr-3 font-normal">Time</th>
            <th className="py-1.5 pr-3 font-normal">Source</th>
            <th className="py-1.5 pr-3 font-normal">Component</th>
            <th className="py-1.5 font-normal">What happened</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => {
            const open = onOpen(t);
            return (
              <tr
                key={t.entryId}
                onClick={open}
                className={`border-t border-line align-top ${open ? 'cursor-pointer hover:bg-panel' : ''}`}
              >
                {/* tabular-nums keeps the columns from jittering row to row. */}
                <td className="py-1.5 pr-3 font-mono text-[11px] text-muted whitespace-nowrap tabular-nums">
                  {t.occurredAt.slice(0, 10)}
                </td>
                <td className="py-1.5 pr-3 font-mono text-[11px] text-faint whitespace-nowrap tabular-nums">
                  {t.occurredAt.slice(11, 16)}
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <Badge source={t.sourceType} />
                </td>
                <td className="py-1.5 pr-3 font-mono text-[11px] text-muted max-w-40 truncate">
                  {t.component ? <Highlight text={t.component} needle={needle} /> : '—'}
                </td>
                <td className="py-1.5 text-[13px]">
                  <Highlight text={t.title} needle={needle} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
