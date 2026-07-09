import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ComponentRow, ProjectRow } from '../types';
import {
  Badge,
  Empty,
  Eyebrow,
  FilterInput,
  PickProject,
  SpineRow,
  Spinner,
  Stamp,
  matches,
} from '../components/ui';

/** Component explorer: list on the left, selected component's history on the right. */
export function ComponentsView({
  project,
  projects,
  onProject,
}: {
  project: string;
  projects: ProjectRow[];
  onProject: (slug: string) => void;
}) {
  const [components, setComponents] = useState<ComponentRow[]>([]);
  const [selected, setSelected] = useState('');
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const shownComponents = useMemo(
    () => components.filter((c) => matches(c.component, q)),
    [components, q],
  );

  useEffect(() => {
    setComponents([]);
    setSelected('');
    setEntries([]);
    if (!project) return;
    void api.components(project).then((r) => setComponents(r.components));
  }, [project]);

  useEffect(() => {
    if (!project || !selected) return;
    setLoading(true);
    void api
      .componentHistory(project, selected)
      .then((r) => setEntries(r.entries))
      .finally(() => setLoading(false));
  }, [project, selected]);

  if (!project) return <PickProject what="components" projects={projects} onProject={onProject} />;
  if (!components.length)
    return <Empty title="No components recorded." hint="Component logs live in kdb/components/." />;

  return (
    <div className="grid grid-cols-[280px_1fr] gap-6 max-w-6xl mx-auto">
      <div>
        <Eyebrow>Components — {project}</Eyebrow>
        <FilterInput
          value={q}
          onChange={setQ}
          placeholder="Filter components…"
          count={{ shown: shownComponents.length, total: components.length }}
        />
        <div className="space-y-0.5 max-h-[75vh] overflow-y-auto pr-1">
          {shownComponents.map((c) => (
            <button
              key={c.component}
              onClick={() => setSelected(c.component)}
              className={`w-full text-left px-2.5 py-1.5 rounded-md text-[13px] flex items-baseline gap-2 ${
                selected === c.component ? 'bg-panel-2 text-ink' : 'text-muted hover:bg-panel'
              }`}
            >
              <span className="truncate flex-1">{c.component}</span>
              <span className="font-mono text-[11px] text-faint">{c.count}</span>
            </button>
          ))}
        </div>
      </div>
      <div>
        {!selected && <Empty title="Select a component." hint="Its full recorded history appears here." />}
        {loading && <Spinner />}
        {!loading && selected && (
          <div className="space-y-2">
            <Eyebrow>{selected}</Eyebrow>
            {entries.map((e) => (
              <SpineRow key={e.id} source={e.source_type ?? 'kdb_component'}>
                <div className="flex items-baseline gap-2">
                  <Badge source={e.source_type ?? 'kdb_component'} />
                  <span className="font-medium text-[14px] flex-1">{e.title}</span>
                  <Stamp iso={e.occurred_at} />
                </div>
                <pre className="mt-2 text-[12.5px] text-muted whitespace-pre-wrap font-sans leading-relaxed max-h-72 overflow-y-auto">
                  {e.body}
                </pre>
              </SpineRow>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
