import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  exact,
  millis,
  plural,
  relativeTime,
  type CachedAdoption,
  type ToolAdoption,
} from '@atlas/shared';
import { Empty, Eyebrow, Spinner } from '../../components/atoms';
import { api } from '../../api/endpoints';
import { colors, fonts, tint } from '../../theme';

/**
 * Whether agents call Atlas when a documented trigger fires. A different
 * question from usage: usage says what was called, this says what *should*
 * have been. The misses are heuristic candidates, never verdicts.
 */
export function AdoptionTab({ nonce }: { nonce: number }) {
  const [data, setData] = useState<CachedAdoption | null>(null);
  const [error, setError] = useState('');
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .adoption()
      .then((d) => {
        if (live) {
          setData(d);
          setError('');
        }
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  const refresh = async () => {
    setAsked(true);
    try {
      await api.refreshAdoption();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error) return <Empty title="Cannot load adoption." hint={error} />;
  if (!data) return <Spinner label="loading adoption" />;

  if (!data.report) {
    return (
      <ScrollView scrollEnabled={false}>
        <Empty
          title="No adoption report yet."
          hint="The indexer computes this by scanning every Claude transcript on the machine. It runs daily; you can ask for it now."
        />
        <Pressable
          onPress={() => void refresh()}
          disabled={asked}
          style={{ alignSelf: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 7, paddingHorizontal: 12, paddingVertical: 8, opacity: asked ? 0.5 : 1 }}
        >
          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted }}>
            {asked ? 'queued — check back in a few minutes' : 'compute now'}
          </Text>
        </Pressable>
      </ScrollView>
    );
  }

  const r = data.report;

  return (
    <ScrollView scrollEnabled={false} contentContainerStyle={{ gap: 22 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <Text style={{ fontSize: 12, color: colors.muted, lineHeight: 17, flex: 1 }}>
          Did agents call the tool when a documented trigger fired? Counted from{' '}
          {plural(r.sessionsScanned, 'transcript')}; the misses are heuristic candidates.
        </Text>
        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>
          computed {relativeTime(data.computedAt ?? undefined)}
          {data.tookMs ? ` in ${millis(data.tookMs)}` : ''}
        </Text>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <AdoptionCard name="atlas" a={r.atlas} />
        <AdoptionCard name="assessor" a={r.assessor} />
      </View>

      {r.sessions.length > 0 ? (
        <View>
          <Eyebrow>Sessions with candidate misses</Eyebrow>
          <View style={{ gap: 9 }}>
            {r.sessions.slice(0, 25).map((s) => (
              <View key={s.sessionId} style={{ borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.panel, paddingHorizontal: 13, paddingVertical: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                  <Text style={{ fontFamily: fonts.mono, fontSize: 11.5 }}>{s.project}</Text>
                  <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>
                    {plural(s.turns, 'turn')} · atlas {s.atlasCalls} · assessor {s.assessorCalls}
                    {s.startedAt ? ` · ${relativeTime(s.startedAt)}` : ''}
                  </Text>
                </View>
                {s.admittedNotThoughtOf ? (
                  <Text style={{ marginTop: 4, fontSize: 11.5, color: colors.kdb }}>
                    The agent volunteered that it simply did not think of it.
                  </Text>
                ) : null}
                <View style={{ marginTop: 6, gap: 4 }}>
                  {[...s.missedAtlas, ...s.missedAssessor].slice(0, 4).map((t, i) => (
                    <Text key={`${t.rule}-${i}`} style={{ fontSize: 12 }} numberOfLines={2}>
                      <Text style={{ fontFamily: fonts.mono, fontSize: 10, marginRight: 6, color: t.tool === 'atlas' ? colors.claude : colors.doc }}>
                        {t.tool}/{t.rule}{' '}
                      </Text>
                      <Text style={{ color: colors.muted }}>“{t.excerpt}”</Text>
                    </Text>
                  ))}
                </View>
              </View>
            ))}
          </View>
          {r.sessions.length > 25 ? (
            <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint, marginTop: 6 }}>
              showing 25 of {exact(r.sessions.length)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

function AdoptionCard({ name, a }: { name: string; a: ToolAdoption }) {
  const denom = a.sessionsUsed + a.sessionsMissed;
  const rateColor = a.fireRate != null && a.fireRate >= 0.7 ? colors.git : colors.report;
  return (
    <View
      style={{
        flexGrow: 1,
        minWidth: '47%' as unknown as number,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        backgroundColor: colors.panel,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Text style={{ fontFamily: fonts.display, fontSize: 15, fontWeight: '600' }}>{name}</Text>
        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>{plural(a.totalCalls, 'call')}</Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
        {/* null, not 0: "no opportunity arose" and "never fired" differ. */}
        <Text style={{ fontFamily: fonts.display, fontSize: 26, fontWeight: '600' }}>
          {a.fireRate == null ? '—' : `${Math.round(a.fireRate * 100)}%`}
        </Text>
        <Text style={{ fontSize: 11.5, color: colors.muted }}>
          {a.fireRate == null ? 'no qualifying sessions' : `fire rate over ${denom} sessions`}
        </Text>
      </View>

      <View style={{ height: 5, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.line, marginTop: 8 }}>
        {a.fireRate != null ? <View style={{ height: '100%', backgroundColor: rateColor, width: `${a.fireRate * 100}%` }} /> : null}
      </View>

      <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint, marginTop: 8 }}>
        used in {a.sessionsUsed} · missed in {a.sessionsMissed}
        {denom < 10 && denom > 0 ? ' · sample too small to read a rate into' : ''}
      </Text>

      {a.topMissedRules.length > 0 ? (
        <View style={{ marginTop: 8, gap: 3 }}>
          {a.topMissedRules.slice(0, 4).map((m) => (
            <View key={m.rule} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.muted, flex: 1, paddingRight: 8 }}>
                {m.rule}
              </Text>
              <Text style={{ fontFamily: fonts.mono, fontSize: 10.5 }}>{m.count}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
