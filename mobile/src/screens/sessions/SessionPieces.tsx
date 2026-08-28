import { Pressable, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  ENTRY_KIND_META as KIND,
  MATCH_REASON_COLOR,
  compact,
  duration,
  plural,
  substanceLabel,
  type SessionCard,
} from '@atlas/shared';
import { Highlight, ProjectTag, Stamp } from '../../components/atoms';
import { colors, fonts, tint } from '../../theme';

/**
 * The native half of session intelligence's shared vocabulary.
 *
 * Every wording, colour and threshold here comes from `@atlas/shared` — the
 * same module the web imports — so the two clients cannot describe the same
 * session differently. What is native is only the rendering.
 */

export type SessionTab = 'conversation' | 'insights' | 'related';

/** Where a session is named, these three actions are reachable. */
export function SessionRefActions({
  sessionId,
  onOpen,
}: {
  sessionId: string;
  onOpen: (id: string, tab: SessionTab) => void;
}) {
  const items: { tab: SessionTab; label: string }[] = [
    { tab: 'conversation', label: 'open' },
    { tab: 'insights', label: 'insights' },
    { tab: 'related', label: 'related' },
  ];
  return (
    <View style={{ flexDirection: 'row', gap: 14, marginTop: 8 }}>
      {items.map((i) => (
        <Pressable
          key={i.tab}
          hitSlop={8}
          onPress={() => {
            void Haptics.selectionAsync();
            onOpen(sessionId, i.tab);
          }}
        >
          <Text
            style={{
              fontFamily: fonts.mono,
              fontSize: 11,
              color: colors.muted,
              textDecorationLine: 'underline',
            }}
          >
            {i.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function SubstanceMeter({ value }: { value: number }) {
  const pct = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return (
    <View
      accessibilityLabel={substanceLabel(value)}
      style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: colors.line, overflow: 'hidden' }}
    >
      <View style={{ width: `${pct}%`, height: '100%', backgroundColor: colors.kdb }} />
    </View>
  );
}

/** Why chips — the same claim the web makes, so a ranking stays auditable. */
function WhyChips({ why }: { why: SessionCard['why'] }) {
  if (!why.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {why.slice(0, 4).map((w, i) => {
        const color = MATCH_REASON_COLOR[w.kind] ?? colors.muted;
        return (
          <View
            key={`${w.kind}-${i}`}
            style={{
              borderWidth: 1,
              borderColor: tint(color, 35),
              backgroundColor: tint(color, 10),
              borderRadius: 3,
              paddingHorizontal: 6,
              paddingVertical: 2,
            }}
          >
            <Text style={{ fontFamily: fonts.mono, fontSize: 10, color }}>{w.detail}</Text>
          </View>
        );
      })}
    </View>
  );
}

export function SessionCardRow({
  card,
  needle = '',
  onOpen,
}: {
  card: SessionCard;
  needle?: string;
  onOpen: (id: string, tab: SessionTab) => void;
}) {
  const took = card.durationMs != null ? duration(card.durationMs / 1000) : null;
  return (
    <Pressable
      onPress={() => onOpen(card.sessionId, 'conversation')}
      android_ripple={{ color: tint(colors.ink, 5) }}
      style={({ pressed }) => ({
        borderLeftWidth: 3,
        borderLeftColor: colors.claude,
        backgroundColor: pressed ? colors.panel2 : colors.panel,
        borderTopRightRadius: 8,
        borderBottomRightRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint }}>
          {card.sessionId.slice(0, 8)}
        </Text>
        <ProjectTag slug={card.projectSlug} />
        {card.thread ? (
          <View
            style={{
              backgroundColor: tint(colors.report, 12),
              borderRadius: 3,
              paddingHorizontal: 6,
              paddingVertical: 2,
            }}
          >
            <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.report }}>
              +{card.thread.size - 1} in thread
            </Text>
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        <SubstanceMeter value={card.substance} />
        <Stamp iso={card.startedAt} />
      </View>

      <Highlight
        text={card.title}
        needle={needle}
        style={{ fontSize: 14, color: colors.ink, marginTop: 4 }}
        numberOfLines={2}
      />

      {card.ai?.headline ? (
        <Text style={{ fontSize: 13, color: colors.claude, marginTop: 4 }}>
          <Text style={{ fontFamily: fonts.mono, fontSize: 9 }}>AI </Text>
          {card.ai.headline}
        </Text>
      ) : null}

      <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint, marginTop: 4 }}>
        {plural(card.entryCount, 'message')} · {compact(card.actionCount)} actions
        {card.fileCount > 0 ? ` · ${plural(card.fileCount, 'file')}` : ''}
        {/* "span", not a bare duration — a resumed session's window can be days. */}
        {took ? ` · ${took} span` : ''}
      </Text>

      <WhyChips why={card.why} />

      {card.excerpts.slice(0, 2).map((e) => (
        <View
          key={e.entryId}
          style={{
            borderLeftWidth: 2,
            borderLeftColor: KIND[e.kind].color,
            paddingLeft: 8,
            marginTop: 6,
          }}
        >
          <Text style={{ fontSize: 12, color: colors.muted }} numberOfLines={2}>
            <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: KIND[e.kind].color }}>
              {KIND[e.kind].label}{' '}
            </Text>
            {e.text}
          </Text>
        </View>
      ))}

      <SessionRefActions sessionId={card.sessionId} onOpen={onOpen} />
    </Pressable>
  );
}
