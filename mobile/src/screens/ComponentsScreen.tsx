import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  compact,
  matches,
  type ComponentRow,
  type EntryRecord,
  type ProjectRow,
} from '@atlas/shared';
import { api } from '../api/endpoints';
import type { ScopeHandle } from '../hooks/useScope';
import { Badge, Empty, Eyebrow, PickProject, Spinner, Stamp } from '../components/atoms';
import { FilterInput } from '../components/FilterInput';
import { Markdown } from '../components/MarkdownNative';
import { colors, fonts, tint } from '../theme';

/**
 * Component explorer (web ComponentsView): list on the left, the selected
 * component's full history on the right. On a phone the two panes become two
 * states of one surface — pick, then read; back to pick again.
 */
export function ComponentsScreen({
  scope,
  projects,
  onProject,
}: {
  scope: ScopeHandle;
  projects: ProjectRow[];
  onProject: (slug: string) => void;
}) {
  const project = scope.project;
  const [components, setComponents] = useState<ComponentRow[]>([]);
  const [selected, setSelected] = useState('');
  const [entries, setEntries] = useState<EntryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const shown = useMemo(() => components.filter((c) => matches(c.component, q)), [components, q]);

  useEffect(() => {
    setComponents([]);
    setSelected('');
    setEntries([]);
    if (!project) return;
    let alive = true;
    void api
      .components(project)
      .then((r) => alive && setComponents(r.components))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project]);

  useEffect(() => {
    if (!project || !selected) return;
    let alive = true;
    setLoading(true);
    void api
      .componentHistory(project, selected)
      .then((r) => alive && setEntries(r.entries))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [project, selected]);

  if (!project) {
    return (
      <ScrollView contentContainerStyle={{ paddingVertical: 12 }}>
        <PickProject what="components" projects={projects} onProject={onProject} />
      </ScrollView>
    );
  }

  // Reading a history — the detail pane takes over.
  if (selected) {
    return (
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 }}>
        <Pressable onPress={() => setSelected('')} hitSlop={8} style={{ alignSelf: 'flex-start' }}>
          <Text style={{ fontSize: 13, color: colors.muted }}>← components</Text>
        </Pressable>
        <View style={{ marginTop: 12 }}>
          <Eyebrow>{selected}</Eyebrow>
        </View>
        {loading ? <Spinner /> : null}
        {!loading ? (
          <View style={{ gap: 8 }}>
            {entries.map((e) => (
              <View
                key={String(e.id)}
                style={{
                  borderLeftWidth: 3,
                  borderLeftColor: colors.kdb,
                  backgroundColor: colors.panel,
                  borderTopRightRadius: 8,
                  borderBottomRightRadius: 8,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                  <Badge source={e.source_type ?? 'kdb_component'} />
                  {e.title ? (
                    <Text numberOfLines={1} style={{ fontWeight: '600', fontSize: 14, flex: 1 }}>
                      {e.title}
                    </Text>
                  ) : (
                    <View style={{ flex: 1 }} />
                  )}
                  <Stamp iso={e.occurred_at} />
                </View>
                <View style={{ marginTop: 6 }}>
                  {/* The structured kdb block IS the point of this view. Long
                      histories scroll inside their own screen here. */}
                  <Markdown text={e.body} baseSize={12.5} />
                </View>
              </View>
            ))}
            {entries.length === 0 ? <Empty title="No recorded history for this component." /> : null}
          </View>
        ) : null}
      </ScrollView>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 }}>
        <Eyebrow>Components — {project}</Eyebrow>
        <FilterInput
          value={q}
          onChange={setQ}
          placeholder="Filter components…"
          count={{ shown: shown.length, total: components.length }}
        />
        <View style={{ gap: 3 }}>
          {shown.map((c) => (
            <Pressable
              key={c.component}
              onPress={() => setSelected(c.component)}
              android_ripple={{ color: tint(colors.ink, 5) }}
              style={({ pressed }) => ({
                paddingHorizontal: 10,
                paddingVertical: 9,
                borderRadius: 8,
                flexDirection: 'row',
                alignItems: 'baseline',
                gap: 8,
                backgroundColor: pressed ? colors.panel2 : 'transparent',
              })}
            >
              <Text numberOfLines={1} style={{ fontSize: 13, color: colors.muted, flex: 1 }}>
                {c.component}
              </Text>
              <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint }}>
                {compact(c.count)}
              </Text>
            </Pressable>
          ))}
          {components.length === 0 ? (
            <Empty title="No components recorded." hint="Component logs live in kdb/components/." />
          ) : null}
          {components.length > 0 && shown.length === 0 ? <Empty title="Nothing matches that filter." /> : null}
        </View>
      </ScrollView>
    </View>
  );
}
