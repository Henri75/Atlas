import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { ProjectRow, Stats } from './types';
import { Sidebar, type View } from './components/Sidebar';
import { SearchView } from './views/SearchView';
import { TimelineView } from './views/TimelineView';
import { ComponentsView } from './views/ComponentsView';
import { SessionsView } from './views/SessionsView';

/**
 * Shell: sidebar (views + projects + status) and the active view.
 * Keyboard: '/' focuses search, 1–4 switch views, Esc backs out of a session.
 */
export default function App() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [project, setProject] = useState('');
  const [view, setView] = useState<View>('search');
  const [openSessionId, setOpenSessionId] = useState('');
  const [offline, setOffline] = useState(false);
  const [toast, setToast] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);

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
      } else if (!typing && ['1', '2', '3', '4'].includes(e.key)) {
        setView((['search', 'timeline', 'components', 'sessions'] as View[])[Number(e.key) - 1]!);
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

  return (
    <div className="flex min-h-screen">
      <Sidebar
        projects={projects}
        project={project}
        view={view}
        stats={stats}
        onProject={setProject}
        onView={(v) => {
          setView(v);
          if (v !== 'sessions') setOpenSessionId('');
        }}
        onReindex={() => void reindex()}
      />
      <main className="flex-1 px-6 py-6 min-w-0">
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
              The stack may still be starting. Check <code className="font-mono">make ps</code> and{' '}
              <code className="font-mono">make logs</code>.
            </span>
          </div>
        )}
        {view === 'search' && (
          <SearchView project={project} inputRef={searchRef} onOpenSession={openSession} />
        )}
        {view === 'timeline' && (
          <TimelineView
            project={project}
            projects={projects}
            onProject={setProject}
            onOpenSession={openSession}
          />
        )}
        {view === 'components' && (
          <ComponentsView project={project} projects={projects} onProject={setProject} />
        )}
        {view === 'sessions' && (
          <SessionsView
            project={project}
            projects={projects}
            onProject={setProject}
            openSessionId={openSessionId}
            onOpenSession={openSession}
          />
        )}
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
