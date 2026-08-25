import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { compact, matches, type ProjectRow } from '@atlas/shared';
import type { ScopeHandle } from '../hooks/useScope';
import { FilterInput } from './FilterInput';
import { colors, fonts, tint } from '../theme';

/**
 * What the current view is looking at, stated where it can't be missed — the
 * web's ScopeBar as a horizontally-scrolling chip row. The picker opens as a
 * modal with favourites floating to the top (flattening the moment you type:
 * a pinned favourite must never outrank a better match).
 */
export function ScopeBar({
  scope,
  projects,
  favorites,
  onToggleFavorite,
  note,
}: {
  scope: ScopeHandle;
  projects: ProjectRow[];
  favorites: string[];
  onToggleFavorite: (slug: string) => void;
  note?: string;
}) {
  const byslug = useMemo(() => new Map(projects.map((p) => [p.slug, p])), [projects]);
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <View
      style={{
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.line,
        backgroundColor: tint(colors.kdb, 3),
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: 1.2, textTransform: 'uppercase', color: colors.faint }}>
          Scope
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, alignItems: 'center', flexShrink: 1 }}>
          {scope.isAll ? (
            <Text style={{ fontSize: 13, color: colors.muted }}>all projects</Text>
          ) : (
            scope.projects.map((slug) => {
              const count = byslug.get(slug)?.entryCount;
              return (
                <View
                  key={slug}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 5,
                    paddingLeft: 10,
                    paddingRight: 5,
                    paddingVertical: 4,
                    borderRadius: 999,
                    backgroundColor: tint(colors.kdb, 14),
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: tint(colors.kdb, 45),
                  }}
                >
                  <Text style={{ fontSize: 12.5 }}>{slug}</Text>
                  {count !== undefined ? (
                    <Text style={{ fontFamily: fonts.mono, fontSize: 9.5, color: colors.kdb }}>
                      {compact(count)}
                    </Text>
                  ) : null}
                  <Pressable
                    hitSlop={6}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                      scope.remove(slug);
                    }}
                    accessibilityLabel={`Remove ${slug} from scope`}
                  >
                    <Text style={{ color: colors.faint, fontSize: 12 }}>✕</Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </ScrollView>

        <Pressable
          onPress={() => setPickerOpen(true)}
          accessibilityLabel="Add a project to the scope"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 999,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.line,
            borderStyle: 'dashed',
          }}
        >
          <Text style={{ fontSize: 12.5, color: colors.muted }}>+ add</Text>
        </Pressable>

        {!scope.isAll ? (
          <Pressable onPress={scope.clear} hitSlop={6}>
            <Text style={{ fontSize: 12, color: colors.faint }}>clear</Text>
          </Pressable>
        ) : null}

        <View style={{ flex: 1 }} />
        {note ? (
          <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.report }} numberOfLines={1}>
            {note}
          </Text>
        ) : null}
        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>
          {scope.isAll ? `${projects.length}` : `${scope.projects.length}/${projects.length}`}
        </Text>
      </View>

      <ProjectPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        scope={scope}
        projects={projects}
        favorites={favorites}
        onToggleFavorite={onToggleFavorite}
      />
    </View>
  );
}

function ProjectPickerModal({
  open,
  onClose,
  scope,
  projects,
  favorites,
  onToggleFavorite,
}: {
  open: boolean;
  onClose: () => void;
  scope: ScopeHandle;
  projects: ProjectRow[];
  favorites: string[];
  onToggleFavorite: (slug: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const favSet = useMemo(() => new Set(favorites), [favorites]);

  const shown = useMemo(() => projects.filter((p) => matches(p.slug, filter)), [projects, filter]);
  const filtering = filter.trim().length > 0;
  const favShown = filtering ? [] : shown.filter((p) => favSet.has(p.slug));
  const restShown = filtering ? shown : shown.filter((p) => !favSet.has(p.slug));

  const row = (p: ProjectRow) => {
    const on = scope.projects.includes(p.slug);
    const isFav = favSet.has(p.slug);
    return (
      <View key={p.slug} style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Pressable
          onPress={() => scope.toggle(p.slug)}
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingHorizontal: 16,
            paddingVertical: 11,
            backgroundColor: pressed ? colors.panel2 : 'transparent',
          })}
          accessibilityState={{ selected: on }}
        >
          <View
            style={{
              width: 15,
              height: 15,
              borderRadius: 4,
              borderWidth: 1,
              borderColor: on ? colors.kdb : colors.line,
              backgroundColor: on ? colors.kdb : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {on ? <Text style={{ fontSize: 9.5, color: colors.bg }}>✓</Text> : null}
          </View>
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              fontSize: 13,
              color: on ? colors.ink : colors.muted,
            }}
          >
            {p.slug}
          </Text>
          <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>
            {compact(p.entryCount)}
          </Text>
        </Pressable>
        <Pressable
          hitSlop={8}
          onPress={() => {
            Haptics.selectionAsync().catch(() => {});
            onToggleFavorite(p.slug);
          }}
          style={{ paddingHorizontal: 14, paddingVertical: 10 }}
          accessibilityLabel={isFav ? `Unfavourite ${p.slug}` : `Favourite ${p.slug}`}
        >
          <Text style={{ fontSize: 13, color: isFav ? colors.kdb : colors.faint }}>
            {isFav ? '★' : '☆'}
          </Text>
        </Pressable>
      </View>
    );
  };

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.line,
            height: '78%',
            paddingBottom: 24,
          }}
        >
          <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
            <View style={{ width: 40, height: 4.5, borderRadius: 3, backgroundColor: colors.line }} />
          </View>
          <View style={{ paddingHorizontal: 16, paddingBottom: 6 }}>
            <FilterInput
              value={filter}
              onChange={setFilter}
              placeholder="Filter projects…"
              count={{ shown: shown.length, total: projects.length }}
            />
          </View>
          <ScrollView style={{ flexGrow: 0 }}>
            {favShown.length > 0 ? (
              <>
                <SectionHead>★ Favourites</SectionHead>
                {favShown.map(row)}
                <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: 5 }} />
              </>
            ) : null}
            {restShown.map(row)}
            {shown.length === 0 ? (
              <Text style={{ paddingHorizontal: 18, paddingVertical: 14, fontSize: 12, color: colors.faint }}>
                No project matches “{filter}”.
              </Text>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <Text
      style={{
        fontFamily: fonts.display,
        textTransform: 'uppercase',
        letterSpacing: 2,
        fontSize: 10,
        color: colors.faint,
        paddingHorizontal: 18,
        paddingTop: 8,
        paddingBottom: 4,
      }}
    >
      {children}
    </Text>
  );
}
