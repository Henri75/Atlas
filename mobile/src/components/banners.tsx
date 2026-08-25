import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, tint } from '../theme';

/**
 * Search degrades silently by design (hybrid → sparse-only → Postgres FTS), so
 * the only sign is result quality — say what broke and what it costs, at the
 * weight of a warning. Ported verbatim in copy and tone.
 */
const DEGRADED: Record<string, { what: string; cost: string }> = {
  'sparse-only': {
    what: 'The embedding provider is unreachable',
    cost: 'Keyword matching only — semantically similar wording will be missed.',
  },
  fts: {
    what: 'The vector index is unreachable',
    cost: 'Falling back to Postgres text search — ranking and recall are weaker.',
  },
};

export function DegradedBanner({ mode }: { mode: string }) {
  const info = DEGRADED[mode];
  if (!info) return null;
  return (
    <View
      style={{
        marginBottom: 12,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: tint(colors.report, 40),
        backgroundColor: tint(colors.report, 8),
        paddingHorizontal: 12,
        paddingVertical: 9,
      }}
    >
      <Text style={{ fontSize: 12, lineHeight: 17 }}>
        <Text style={{ color: colors.report }}>Degraded search · {info.what}. </Text>
        <Text style={{ color: colors.muted }}>{info.cost}</Text>
      </Text>
    </View>
  );
}

export function OfflineBanner({ onRetry }: { onRetry?: () => void }) {
  return (
    <Pressable
      onPress={onRetry}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 16,
        marginTop: 10,
        marginBottom: 4,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: tint(colors.report, 45),
        backgroundColor: tint(colors.report, 8),
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
      accessibilityRole="alert"
    >
      <Text style={{ fontSize: 13, flex: 1, lineHeight: 18 }}>
        <Text style={{ color: colors.report }}>Cannot reach the API.</Text>{' '}
        <Text style={{ color: colors.muted }}>
          The stack may still be starting, or the server address is wrong.
        </Text>
      </Text>
      {onRetry ? <Text style={{ color: colors.claude, fontFamily: fonts.monoMedium, fontSize: 12 }}>retry</Text> : null}
    </Pressable>
  );
}
