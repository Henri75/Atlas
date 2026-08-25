import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import {
  SOURCE_META,
  compact,
  exact,
  matches as sharedMatches,
  type SourceType,
} from '@atlas/shared';
import { colors, fonts, metrics, tint } from '../theme';

/**
 * The small shared pieces, ported 1:1 from packages/ui/src/components/ui.tsx:
 * source badge, spine row, date stamp, eyebrows, empty states, pulse dots.
 */

/** Which source a record came from — mono caps on a tinted field. */
export function Badge({ source }: { source: SourceType }) {
  const m = SOURCE_META[source] ?? { label: source, color: colors.muted };
  return (
    <Text
      style={{
        color: m.color,
        backgroundColor: tint(m.color, 12),
        fontFamily: fonts.mono,
        fontSize: 10,
        letterSpacing: 2.5,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 3,
        overflow: 'hidden',
      }}
    >
      {m.label}
    </Text>
  );
}

/**
 * The signature element: every record carries a spine in its source color.
 * Entrance uses the web's `rise` motion (120ms ease-out), reduced to opacity +
 * a 4px lift; long lists animate only their newest rows cheaply.
 */
export function SpineRow({
  source,
  children,
  onPress,
  onLongPress,
}: {
  source: SourceType;
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(rise, {
      toValue: 1,
      duration: 120,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [rise]);

  const color = SOURCE_META[source]?.color ?? colors.muted;
  return (
    <Animated.View
      style={{
        opacity: rise,
        transform: [
          {
            translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }),
          },
        ],
        borderLeftWidth: metrics.spineWidth,
        borderLeftColor: color,
        backgroundColor: colors.panel,
        borderTopRightRadius: metrics.cardRadius - 2,
        borderBottomRightRadius: metrics.cardRadius - 2,
        overflow: 'hidden',
      }}
    >
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        disabled={!onPress}
        android_ripple={{ color: tint(colors.ink, 6) }}
        style={({ pressed }) => ({
          paddingHorizontal: 12,
          paddingVertical: 10,
          backgroundColor: pressed ? colors.panel2 : 'transparent',
        })}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

/**
 * Where a record came from — shown only when the scope spans more than one
 * project; in a single-project view it would be noise on every row.
 */
export function ProjectTag({ slug }: { slug?: string }) {
  if (!slug) return null;
  return (
    <Text
      style={{
        fontFamily: fonts.mono,
        fontSize: 9.5,
        color: colors.muted,
        backgroundColor: colors.panel2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        borderRadius: 3,
        paddingHorizontal: 5,
        paddingVertical: 1,
        overflow: 'hidden',
      }}
    >
      {slug}
    </Text>
  );
}

/** Which machine a record was first ingested from (fleet installs only). */
export function MachineBadge({ machine }: { machine?: string }) {
  if (!machine) return null;
  return (
    <Text
      style={{
        fontFamily: fonts.mono,
        fontSize: 9.5,
        color: colors.muted,
        backgroundColor: colors.panel2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        borderRadius: 3,
        paddingHorizontal: 5,
        paddingVertical: 1,
        overflow: 'hidden',
      }}
    >
      ⌂ {machine}
    </Text>
  );
}

export function Stamp({ iso }: { iso?: string }) {
  if (!iso) return null;
  return (
    <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint }}>
      {iso.slice(0, 16).replace('T', ' ')}
    </Text>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        fontFamily: fonts.display,
        textTransform: 'uppercase',
        letterSpacing: 2,
        fontSize: 11,
        color: colors.muted,
        marginBottom: 8,
      }}
    >
      {children}
    </Text>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 56, paddingHorizontal: 24 }}>
      <Text style={{ color: colors.muted, fontSize: 14, textAlign: 'center' }}>{title}</Text>
      {hint ? (
        <Text
          style={{
            color: colors.faint,
            fontSize: 12.5,
            marginTop: 6,
            textAlign: 'center',
            lineHeight: 18,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** Empty state for views that need one project — offers the choice right here. */
export function PickProject({
  what,
  projects,
  onProject,
}: {
  what: string;
  projects: { slug: string; entryCount: number }[];
  onProject: (slug: string) => void;
}) {
  if (!projects.length) {
    return (
      <Empty
        title="No projects indexed yet."
        hint="The first scan may still be running — check Overview, or run `atlas status`."
      />
    );
  }
  return (
    <View style={{ paddingVertical: 32 }}>
      <Text style={{ color: colors.muted, textAlign: 'center', fontSize: 13.5 }}>
        Choose a project to see its {what}.
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 20 }}>
        {projects.slice(0, 40).map((p) => (
          <Chip key={p.slug} label={p.slug} count={p.entryCount} onPress={() => onProject(p.slug)} />
        ))}
      </View>
    </View>
  );
}

export function Chip({
  label,
  count,
  onPress,
}: {
  label: string;
  count?: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: tint(colors.ink, 8) }}
      style={{
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        backgroundColor: colors.panel,
        paddingHorizontal: 12,
        paddingVertical: 7,
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 8,
      }}
    >
      <Text style={{ color: colors.muted, fontSize: 13 }}>{label}</Text>
      {count !== undefined && (
        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>
          {compact(count)}
        </Text>
      )}
    </Pressable>
  );
}

/* -------------------------------------------------------------------------
 * Waiting states. Motion is the point: it distinguishes a slow request from
 * a hung one, which static text cannot (web Pulse/Spinner).
 * ---------------------------------------------------------------------- */

export function Dots({ size = 4, color = colors.kdb }: { size?: number; color?: string }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(anim, { toValue: 3, duration: 1200, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
      {[0, 1, 2].map((i) => {
        const phase = Animated.modulo(Animated.add(anim, 3 - i), 3);
        const scale = phase.interpolate({
          inputRange: [0, 0.4, 0.8, 1],
          outputRange: [1, 0.8, 0.8, 1],
          extrapolate: 'clamp',
        });
        const opacity = phase.interpolate({
          inputRange: [0, 0.4, 0.8, 1],
          outputRange: [1, 0.25, 0.25, 1],
          extrapolate: 'clamp',
        });
        return (
          <Animated.View
            key={i}
            style={{
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: color,
              transform: [{ scale }],
              opacity,
            }}
          />
        );
      })}
    </View>
  );
}

export function Pulse({ label = 'querying' }: { label?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Dots />
      <Text style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.faint }}>{label}…</Text>
    </View>
  );
}

export function Spinner({ label = 'querying' }: { label?: string }) {
  return (
    <View style={{ paddingVertical: 28, alignItems: 'center' }}>
      <Pulse label={label} />
    </View>
  );
}

/** Client-side filter box state helper (pure, from shared). */
export const matches = sharedMatches;

/** "showing N of M" caption for filter boxes. */
export function CountCaption({ shown, total }: { shown: number; total: number }) {
  return (
    <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint }}>
      {shown === total ? `${exact(total)}` : `${shown} of ${total}`}
    </Text>
  );
}

/** Case-insensitive highlight of `needle` inside `text`, as Text spans. */
export function Highlight({
  text,
  needle,
  style,
  numberOfLines,
}: {
  text: string;
  needle: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const parts = useMemo(() => {
    if (!needle) return [{ t: text, hit: false }];
    const lower = text.toLowerCase();
    const target = needle.toLowerCase();
    const out: { t: string; hit: boolean }[] = [];
    let i = 0;
    for (;;) {
      const at = lower.indexOf(target, i);
      if (at === -1) {
        out.push({ t: text.slice(i), hit: false });
        break;
      }
      if (at > i) out.push({ t: text.slice(i, at), hit: false });
      out.push({ t: text.slice(at, at + target.length), hit: true });
      i = at + target.length;
    }
    return out;
  }, [text, needle]);

  return (
    <Text numberOfLines={numberOfLines} style={style}>
      {parts.map((p, i) =>
        p.hit ? (
          <Text
            key={i}
            style={{ backgroundColor: tint(colors.kdb, 30), color: (style as any)?.color ?? colors.ink }}
          >
            {p.t}
          </Text>
        ) : (
          <Text key={i}>{p.t}</Text>
        ),
      )}
    </Text>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center' }, style]}>{children}</View>;
}

export { colors, fonts, metrics };
