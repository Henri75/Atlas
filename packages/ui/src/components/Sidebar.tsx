import type { Stats } from '../types';
import { compact, duration, exact, relativeTime } from '../format';
import { VIEWS, type View } from '../nav';
import { SettingsMenu } from './SettingsMenu';

/**
 * The rail answers one question: *how* am I looking? Projects — *what* am I
 * looking at — moved to the scope bar above the content, because the two are
 * different axes and stacking them in one column with the same treatment is
 * what made this panel confusing to read.
 *
 * The view list itself lives in ../nav, shared with the settings menu below.
 */

/**
 * Shown only while the vector collection is being rebuilt (model switch or a
 * resumed backfill). Search still works, but against a partial collection —
 * say so, or an incomplete result set reads as "nothing found".
 */
function BackfillBar({ backfill }: { backfill: NonNullable<Stats['backfill']> }) {
  const pct = Math.min(100, Math.round((backfill.done / Math.max(1, backfill.total)) * 100));
  const left = duration(backfill.etaSec);
  return (
    <div className="pt-1.5" role="status">
      <div className="flex justify-between mb-1" style={{ color: 'var(--color-kdb)' }}>
        <span>re-embedding index</span>
        <span>{backfill.etaSec > 30 ? `~${left} left` : 'finishing'}</span>
      </div>
      <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--color-line)' }}>
        <div
          className="h-full transition-[width] duration-500"
          style={{ width: `${pct}%`, background: 'var(--color-kdb)' }}
        />
      </div>
      <div className="mt-1" title={`${exact(backfill.done)} of ${exact(backfill.total)}`}>
        {compact(backfill.done)}/{compact(backfill.total)} · results are incomplete until this
        finishes
      </div>
    </div>
  );
}

export function Sidebar({
  view,
  stats,
  startView,
  onView,
  onStartView,
  onReindex,
}: {
  view: View;
  stats: Stats | null;
  startView: View;
  onView: (v: View) => void;
  onStartView: (v: View) => void;
  onReindex: () => void;
}) {
  return (
    <aside className="w-56 shrink-0 border-r border-line flex flex-col h-screen sticky top-0">
      <div className="px-4 pt-4 pb-3 border-b border-line">
        <h1 className="font-display font-bold text-[17px] tracking-tight">Atlas</h1>
        <p className="font-mono text-[10px] text-faint mt-0.5">project memory, searchable</p>
      </div>

      <nav className="px-2 py-3 flex-1" aria-label="Views">
        {VIEWS.map((v) => {
          const on = view === v.key;
          return (
            <button
              key={v.key}
              onClick={() => onView(v.key)}
              aria-current={on ? 'page' : undefined}
              className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] ${
                on ? 'bg-panel-2 text-ink' : 'text-muted hover:bg-panel'
              }`}
              // The accent bar is the same device a record's spine uses, so
              // "this one is selected" reads identically everywhere in Atlas.
              style={on ? { boxShadow: 'inset 2px 0 0 var(--color-kdb)' } : undefined}
            >
              <span className="w-4 text-center text-[12px] opacity-80" aria-hidden>
                {v.icon}
              </span>
              <span className="flex-1 text-left">{v.label}</span>
              <kbd className="font-mono text-[10px] text-faint">{v.hotkey}</kbd>
            </button>
          );
        })}
      </nav>

      <div className="px-4 py-3 border-t border-line font-mono text-[10px] text-faint space-y-1">
        {stats && (
          <>
            <div title={`${exact(stats.entries)} entries · ${exact(stats.chunks)} chunks`}>
              {compact(stats.entries)} entries · {compact(stats.chunks)} chunks
            </div>
            <div>
              embedder {stats.embedder} ·{' '}
              {stats.recentErrors > 0 ? (
                <span
                  style={{ color: 'var(--color-report)' }}
                  title={`${exact(stats.errors)} lifetime`}
                >
                  {compact(stats.recentErrors)} errors/hr
                </span>
              ) : (
                <span title={`${exact(stats.errors)} lifetime`}>no recent errors</span>
              )}
            </div>
            {stats.unsearchableEntries > 0 && (
              <div
                style={{ color: 'var(--color-report)' }}
                title="Indexed but not yet embedded — search cannot return these until the reconciler catches up"
              >
                {compact(stats.unsearchableEntries)} not searchable
              </div>
            )}
            <div title={stats.lastRunAt ?? undefined}>
              indexed {relativeTime(stats.lastRunAt)}
              {stats.pending ? ` · ${compact(stats.pending)} queued` : ''}
            </div>
            {stats.backfill && <BackfillBar backfill={stats.backfill} />}
          </>
        )}
        <div className="mt-1 space-y-1">
          <button
            onClick={onReindex}
            className="w-full py-1 rounded border border-line text-muted hover:border-faint hover:text-ink"
          >
            Reindex now
          </button>
          <SettingsMenu startView={startView} onStartView={onStartView} />
        </div>
      </div>
    </aside>
  );
}
