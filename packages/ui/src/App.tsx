import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { ProjectRow, Stats } from './types';
import { Sidebar } from './components/Sidebar';
import { isView, type View } from './nav';
import { ScopeBar } from './components/ScopeBar';
import { useScope } from './useScope';
import { usePersistentState } from './usePersistentState';
import { DashboardView } from './views/DashboardView';
import { SearchView } from './views/SearchView';
import { TimelineView } from './views/TimelineView';
import { ComponentsView } from './views/ComponentsView';
import { SessionsView } from './views/SessionsView';
import { MonitorView } from './views/MonitorView';
import { MachinesView } from './views/MachinesView';

/**
 * Shell. Two axes, deliberately kept apart:
 *
 *  - the **rail** picks the view — *how* you are looking;
 *  - the **scope bar** picks the projects — *what* you are looking at.
 *
 * They used to share one column, which is what made the panel hard to read.
 *
 * Keyboard: '/' focuses search, 1–7 switch views, Esc backs out of a session.
 */

/**
 * Views split by how they use a project. Search, Ask and Timeline *filter* by it
 * and take any number. Components and Sessions *browse* one — a component named
 * `ui` in two projects is two different things — so they say so rather than
 * silently showing one project's data under a two-project scope.
 */
const SINGLE_PROJECT_VIEWS: Record<string, string> = {
  components: 'Components browses one project — pick one below',
  sessions: 'Sessions browses one project — pick one below',
};

export default function App() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const scope = useScope();
  const [favorites, setFavorites] = usePersistentState<string[]>('atlas.projects.favorites', []);

  /**
   * Where Atlas opens. Search & Ask by default: it is the thing you came to do,
   * and it renders instantly, where the overview blocks on /api/dashboard doing
   * storage and vector-collection introspection. The overview is one click — or
   * one settings change — away for anyone who wants "is this healthy?" first.
   */
  const [startView, setStartView] = usePersistentState<View>('atlas.startView', 'search');
  // Read once, at mount. Rewriting `view` whenever the preference changes would
  // teleport you out of whatever you were reading the moment you set it.
  const [view, setView] = useState<View>(() => (isView(startView) ? startView : 'search'));

  const [openSessionId, setOpenSessionId] = useState('');
  const [offline, setOffline] = useState(false);
  const [toast, setToast] = useState('');
  const searchRef = useRef<HTMLTextAreaElement | null>(null);

  const toggleFavorite = useCallback(
    (slug: string) =>
      setFavorites((prev) =>
        prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
      ),
    [setFavorites],
  );

  const refresh = useCallback(() => {
    // "no projects" and "cannot reach the API" must not look the same — that
    // ambiguity made a dead backend look like an empty index.
    void Promise.all([api.projects(), api.stats()])
      .then(([p, s]) => {
        setProjects(p);
        setStats(s);
        setOffline(false);
      })
      .catch(() => setOffline(true));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        setView('search');
        setTimeout(() => searchRef.current?.focus(), 0);
      } else if (!typing && ['1', '2', '3', '4', '5', '6', '7'].includes(e.key)) {
        setView(
          (
            ['search', 'dashboard', 'timeline', 'components', 'sessions', 'monitor', 'machines'] as View[]
          )[Number(e.key) - 1]!,
        );
      } else if (e.key === 'Escape' && openSessionId) {
        setOpenSessionId('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSessionId]);

  const openSession = (id: string) => {
    setOpenSessionId(id);
    if (id) setView('sessions');
  };

  const reindex = async () => {
    try {
      await api.reindex({});
      setToast('Reindex triggered — new content appears within a few minutes.');
    } catch (e) {
      setToast(`Reindex failed: ${(e as Error).message}`);
    }
    setTimeout(() => setToast(''), 5000);
  };

  // Only warn when the scope genuinely conflicts with the view: a single-project
  // browser under a 0- or 2+-project scope cannot honour it.
  const scopeNote =
    scope.project === null ? SINGLE_PROJECT_VIEWS[view] : undefined;

  // The dashboard is global by definition; a scope bar over it would imply a
  // filter it does not apply. Monitor is the same: its subject is Atlas's own
  // traffic, which has no project dimension at all. Machines is the fleet, not
  // a project — the same argument applies.
  const showScope = view !== 'dashboard' && view !== 'monitor' && view !== 'machines';

  return (
    <div className="flex min-h-screen">
      <Sidebar
        view={view}
        stats={stats}
        startView={isView(startView) ? startView : 'search'}
        onView={(v) => {
          setView(v);
          if (v !== 'sessions') setOpenSessionId('');
        }}
        onStartView={setStartView}
        onReindex={() => void reindex()}
      />
      <main className="flex-1 min-w-0 flex flex-col">
        {showScope && (
          <ScopeBar
            scope={scope}
            projects={projects}
            favorites={favorites}
            onToggleFavorite={toggleFavorite}
            note={scopeNote}
          />
        )}

        <div className="flex-1 px-6 py-6 min-w-0">
          {offline && (
            <div
              role="alert"
              className="mb-5 rounded-md border px-4 py-3 text-[13px]"
              style={{
                borderColor: 'color-mix(in srgb, var(--color-report) 45%, transparent)',
                background: 'color-mix(in srgb, var(--color-report) 8%, transparent)',
              }}
            >
              <span style={{ color: 'var(--color-report)' }}>Cannot reach the API.</span>{' '}
              <span className="text-muted">
                The stack may still be starting. Check <code className="font-mono">make ps</code>{' '}
                and <code className="font-mono">make logs</code>.
              </span>
            </div>
          )}
          {view === 'dashboard' && <DashboardView onGoTo={setView} />}
          {view === 'search' && (
            <SearchView scope={scope} inputRef={searchRef} onOpenSession={openSession} />
          )}
          {view === 'timeline' && (
            <TimelineView scope={scope} projects={projects} onOpenSession={openSession} />
          )}
          {view === 'components' && (
            <ComponentsView
              project={scope.project}
              projects={projects}
              onProject={(slug) => scope.set([slug])}
            />
          )}
          {view === 'monitor' && <MonitorView />}
          {view === 'machines' && <MachinesView />}
          {view === 'sessions' && (
            <SessionsView
              project={scope.project}
              projects={projects}
              onProject={(slug) => scope.set([slug])}
              openSessionId={openSessionId}
              onOpenSession={openSession}
            />
          )}
        </div>
      </main>
      {toast && (
        <div
          role="status"
          className="fixed bottom-4 right-4 bg-panel-2 border border-line rounded-md px-4 py-2.5 text-sm rise"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
