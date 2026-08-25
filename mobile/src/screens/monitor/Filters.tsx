import { rangeLabel, type DateRange, type RangeUnit, type UsageFacet, clientColor } from '@atlas/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { compact } from '@atlas/shared';
import { colors, fonts, tint } from '../../theme';

/**
 * The Monitor filter bar: presets for the time window, noise hiding and
 * error-only chips, then server-facet rows so an option that would return
 * nothing is visibly empty rather than a dead end.
 */

export const PRESETS: { label: string; n: number; unit: RangeUnit }[] = [
  { label: '24h', n: 1, unit: 'days' },
  { label: '7d', n: 7, unit: 'days' },
  { label: '4w', n: 4, unit: 'weeks' },
  { label: '3m', n: 3, unit: 'months' },
];

export interface FilterState {
  range: DateRange;
  client?: string;
  tool?: string;
  status?: 'ok' | 'error';
  q: string;
  hideNoise: boolean;
}

export function Chip({
  on,
  onClick,
  color,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  color?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onClick();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={title}
      style={{
        paddingHorizontal: 8,
        paddingVertical: 3.5,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: on ? color ?? colors.kdb : colors.line,
        backgroundColor: on ? tint(color ?? colors.kdb, 14) : 'transparent',
        alignSelf: 'flex-start',
      }}
    >
      <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: on ? colors.ink : colors.faint }}>
        {children}
      </Text>
    </Pressable>
  );
}

/** The time window governs every tab, so it lives in the shell header. */
export function RangePicker({
  range,
  onChange,
}: {
  range: DateRange;
  onChange: (r: DateRange) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: 'hidden' }}>
      {PRESETS.map((p) => {
        const on = range.mode === 'relative' && range.n === p.n && range.unit === p.unit;
        return (
          <Pressable
            key={p.label}
            onPress={() => onChange({ mode: 'relative', n: p.n, unit: p.unit })}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={{ paddingHorizontal: 9, paddingVertical: 5, backgroundColor: on ? colors.panel2 : 'transparent' }}
          >
            <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: on ? colors.ink : colors.muted }}>
              {p.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Filters({
  state,
  onChange,
  facets,
}: {
  state: FilterState;
  onChange: (next: FilterState) => void;
  facets?: { byClient: UsageFacet[]; byTool: UsageFacet[] };
}) {
  const set = (patch: Partial<FilterState>) => onChange({ ...state, ...patch });

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Chip
          on={state.hideNoise}
          onClick={() => set({ hideNoise: !state.hideNoise })}
          title="Hide /api/projects and any call with no query — traffic rather than intent."
        >
          hide noise
        </Chip>
        <Chip on={state.status === 'error'} onClick={() => set({ status: state.status === 'error' ? undefined : 'error' })} color={colors.report}>
          errors only
        </Chip>
        {state.client || state.tool || state.q || state.status ? (
          <Chip
            on={false}
            onClick={() => set({ client: undefined, tool: undefined, status: undefined, q: '' })}
          >
            clear
          </Chip>
        ) : null}
        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint, marginLeft: 'auto' }}>
          {rangeLabel(state.range)}
        </Text>
      </View>

      {facets && (facets.byClient.length > 0 || facets.byTool.length > 0) ? (
        <View style={{ gap: 6 }}>
          <FacetRow
            label="client"
            facets={facets.byClient}
            selected={state.client}
            onSelect={(k) => set({ client: k })}
            colorOf={clientColor}
          />
          <FacetRow label="tool" facets={facets.byTool.slice(0, 10)} selected={state.tool} onSelect={(k) => set({ tool: k })} />
        </View>
      ) : null}
    </View>
  );
}

/** Clicking the selected facet clears it — no separate "all" control needed. */
function FacetRow({
  label,
  facets,
  selected,
  onSelect,
  colorOf,
}: {
  label: string;
  facets: UsageFacet[];
  selected?: string;
  onSelect: (key: string | undefined) => void;
  colorOf?: (key: string) => string;
}) {
  if (facets.length === 0) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      <Text style={{ fontFamily: fonts.mono, fontSize: 9, textTransform: 'uppercase', letterSpacing: 1.2, color: colors.faint }}>
        {label}
      </Text>
      {facets.map((f) => (
        <Chip
          key={f.key}
          on={selected === f.key}
          onClick={() => onSelect(selected === f.key ? undefined : f.key)}
          color={colorOf?.(f.key)}
          title={`${f.calls} call${f.calls === 1 ? '' : 's'}`}
        >
          {f.key} {compact(f.calls)}
        </Chip>
      ))}
    </View>
  );
}
