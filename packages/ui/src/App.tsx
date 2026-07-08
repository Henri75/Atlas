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
  const [toast, setToast] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(() => {
    void api.projects().then(setProjects).catch(() => setProjects([]));
    void api.stats().then(setStats).catch(() => setStats(null));
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
        {view === 'search' && (
          <SearchView project={project} inputRef={searchRef} onOpenSession={openSession} />
        )}
        {view === 'timeline' && <TimelineView project={project} onOpenSession={openSession} />}
        {view === 'components' && <ComponentsView project={project} />}
        {view === 'sessions' && (
          <SessionsView project={project} openSessionId={openSessionId} onOpenSession={openSession} />
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
