import type { ProjectRow, Stats } from '../types';
import { Eyebrow } from './ui';

export type View = 'search' | 'timeline' | 'components' | 'sessions';

const VIEWS: { key: View; label: string; hotkey: string }[] = [
  { key: 'search', label: 'Search & Ask', hotkey: '1' },
  { key: 'timeline', label: 'Timeline', hotkey: '2' },
  { key: 'components', label: 'Components', hotkey: '3' },
  { key: 'sessions', label: 'Sessions', hotkey: '4' },
];

export function Sidebar({
  projects,
  project,
  view,
  stats,
  onProject,
  onView,
  onReindex,
}: {
  projects: ProjectRow[];
  project: string;
  view: View;
  stats: Stats | null;
  onProject: (slug: string) => void;
  onView: (v: View) => void;
  onReindex: () => void;
}) {
  return (
    <aside className="w-60 shrink-0 border-r border-line flex flex-col h-screen sticky top-0">
      <div className="px-4 pt-4 pb-3 border-b border-line">
        <h1 className="font-display font-bold text-[17px] tracking-tight">
          KDB<span style={{ color: 'var(--color-kdb)' }}>Scope</span>
        </h1>
        <p className="font-mono text-[10px] text-faint mt-0.5">project memory, searchable</p>
      </div>

      <nav className="px-2 py-3 border-b border-line" aria-label="Views">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => onView(v.key)}
            className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-[13px] ${
              view === v.key ? 'bg-panel-2 text-ink' : 'text-muted hover:bg-panel'
            }`}
          >
            <span>{v.label}</span>
            <kbd className="font-mono text-[10px] text-faint">{v.hotkey}</kbd>
          </button>
        ))}
      </nav>

      <div className="px-2 py-3 flex-1 overflow-y-auto">
        <div className="px-2.5">
          <Eyebrow>Projects</Eyebrow>
        </div>
        <button
          onClick={() => onProject('')}
          className={`w-full text-left px-2.5 py-1 rounded-md text-[13px] ${
            project === '' ? 'bg-panel-2 text-ink' : 'text-muted hover:bg-panel'
          }`}
        >
          all projects
        </button>
        {projects.map((p) => (
          <button
            key={p.slug}
            onClick={() => onProject(p.slug)}
            className={`w-full flex items-baseline gap-2 text-left px-2.5 py-1 rounded-md text-[13px] ${
              project === p.slug ? 'bg-panel-2 text-ink' : 'text-muted hover:bg-panel'
            }`}
            title={p.rootPath}
          >
            <span
              className="size-1.5 rounded-full shrink-0 self-center"
              style={{ background: p.hasKdb ? 'var(--color-kdb)' : 'var(--color-line)' }}
            />
            <span className="truncate flex-1">{p.slug}</span>
            <span className="font-mono text-[10px] text-faint">{p.entryCount}</span>
          </button>
        ))}
      </div>

      <div className="px-4 py-3 border-t border-line font-mono text-[10px] text-faint space-y-1">
        {stats && (
          <>
            <div>
              {stats.entries.toLocaleString()} entries · {stats.chunks.toLocaleString()} chunks
            </div>
            <div>
              embedder {stats.embedder} ·{' '}
              <span style={{ color: stats.errors ? 'var(--color-report)' : undefined }}>
                {stats.errors} errors
              </span>
            </div>
            <div>last run {stats.lastRunAt ? stats.lastRunAt.slice(5, 16).replace('T', ' ') : '—'}</div>
          </>
        )}
        <button
          onClick={onReindex}
          className="mt-1 w-full py-1 rounded border border-line text-muted hover:border-faint hover:text-ink"
        >
          Reindex now
        </button>
      </div>
    </aside>
  );
}
