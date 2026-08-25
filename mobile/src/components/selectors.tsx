import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, fonts, tint } from '../theme';

/**
 * Search and Ask are two *modes* of one instrument, producing two different
 * surfaces. The segmented control (web ModeSwitch) announces that a choice
 * exists and shows which one is armed; the amber treatment marks the
 * generative mode before a word is typed.
 */
export function ModeSwitch<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; icon?: string; accent?: boolean }[];
  onChange: (v: T) => void;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: colors.panel,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        borderRadius: 10,
        padding: 2,
        gap: 2,
        alignSelf: 'flex-start',
      }}
      accessibilityRole="tablist"
    >
      {options.map((o) => {
        const on = value === o.value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              onChange(o.value);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: 8,
              backgroundColor: on
                ? o.accent
                  ? tint(colors.kdb, 12)
                  : colors.panel2
                : 'transparent',
              borderWidth: on && o.accent ? StyleSheet.hairlineWidth : 0,
              borderColor: on && o.accent ? tint(colors.kdb, 45) : 'transparent',
            }}
          >
            {o.icon ? <Text style={{ fontSize: 11, color: on ? colors.ink : colors.muted }}>{o.icon}</Text> : null}
            <Text
              style={{
                fontSize: 13,
                color: on ? (o.accent ? colors.kdb : colors.ink) : colors.muted,
                fontWeight: on ? '600' : '400',
              }}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Checkbox picker for a subset of options (web MultiSelect): opens as a modal
 * sheet — the native form of the popover — with an "all" row and checkmarks.
 * The trigger summarizes the selection so the current filter is always legible.
 */
export function MultiSelect<T extends string>({
  options,
  selected,
  onChange,
  allLabel,
  label,
  render,
}: {
  options: readonly T[];
  selected: T[];
  onChange: (next: T[]) => void;
  allLabel: string;
  label: string;
  render?: (v: T) => string;
}) {
  const [open, setOpen] = useState(false);

  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (render?.(selected[0]!) ?? selected[0])
        : `${selected.length} selected`;

  const toggle = (v: T) => {
    Haptics.selectionAsync().catch(() => {});
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  };

  const rows = useMemo(() => options.map((v) => ({ v, on: selected.includes(v) })), [options, selected]);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{
          backgroundColor: colors.panel,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
          borderRadius: 8,
          paddingHorizontal: 9,
          paddingVertical: 7,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
        }}
      >
        <Text style={{ fontFamily: fonts.mono, fontSize: 12.5, color: colors.muted }}>{summary}</Text>
        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' }}>
          <Pressable style={{ flex: 1 }} onPress={() => setOpen(false)} />
          <View
            style={{
              backgroundColor: colors.bg,
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.line,
              maxHeight: '70%',
              paddingBottom: 20,
            }}
          >
            <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
              <View style={{ width: 40, height: 4.5, borderRadius: 3, backgroundColor: colors.line }} />
            </View>
            <Text
              style={{
                fontFamily: fonts.display,
                textTransform: 'uppercase',
                letterSpacing: 2,
                fontSize: 11,
                color: colors.muted,
                paddingHorizontal: 18,
                paddingVertical: 10,
              }}
            >
              {label}
            </Text>
            <ScrollView>
              <OptionRow
                checked={selected.length === 0}
                title={allLabel}
                onPress={() => {
                  onChange([]);
                  setOpen(false);
                }}
                strong={selected.length === 0}
              />
              <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: 4 }} />
              {rows.map(({ v, on }) => (
                <OptionRow
                  key={v}
                  checked={on}
                  title={render?.(v) ?? v}
                  onPress={() => toggle(v)}
                />
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

function OptionRow({
  checked,
  title,
  onPress,
  strong,
}: {
  checked: boolean;
  title: string;
  onPress: () => void;
  strong?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: tint(colors.ink, 6) }}
      style={({ pressed }) => ({
        paddingHorizontal: 18,
        paddingVertical: 11,
        backgroundColor: pressed ? colors.panel2 : 'transparent',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
      })}
    >
      <View
        style={{
          width: 15,
          height: 15,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: checked ? colors.kdb : colors.faint,
          backgroundColor: checked ? colors.kdb : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? <Text style={{ fontSize: 10, color: colors.bg, lineHeight: 11 }}>✓</Text> : null}
      </View>
      <Text
        style={{
          fontFamily: fonts.mono,
          fontSize: 13,
          color: checked || strong ? colors.ink : colors.muted,
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}

/** A single-choice dropdown in the same visual language (web's `<select>`). */
export function SingleSelect<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  /** '' value renders as its own label. */
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{
          backgroundColor: colors.panel,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
          borderRadius: 8,
          paddingHorizontal: 9,
          paddingVertical: 7,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
        }}
      >
        <Text style={{ fontFamily: fonts.mono, fontSize: 12.5, color: colors.muted }}>
          {current?.label ?? value}
        </Text>
        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' }}>
          <Pressable style={{ flex: 1 }} onPress={() => setOpen(false)} />
          <View
            style={{
              backgroundColor: colors.bg,
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.line,
              maxHeight: '65%',
              paddingBottom: 20,
            }}
          >
            <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
              <View style={{ width: 40, height: 4.5, borderRadius: 3, backgroundColor: colors.line }} />
            </View>
            <ScrollView>
              {options.map((o) => (
                <OptionRow
                  key={o.value || '__none__'}
                  checked={o.value === value}
                  title={o.label}
                  onPress={() => {
                    Haptics.selectionAsync().catch(() => {});
                    onChange(o.value);
                    setOpen(false);
                  }}
                />
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}
