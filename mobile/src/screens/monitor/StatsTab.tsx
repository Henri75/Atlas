import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  LATENCY_BUCKETS,
  compact,
  exact,
  millis,
  plural,
  relativeTime,
  summarizeQuery,
  type UsageInsights,
} from '@atlas/shared';
import { Histogram, Rate, StatTile } from '../../components/charts';
import { Empty, Eyebrow, Spinner } from '../../components/atoms';
import { api } from '../../api/endpoints';
import { colors, fonts } from '../../theme';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Stats: whether Atlas is *working*, as opposed to how much it is called.
 * Leads with the two rates that can actually be bad (searches returning
 * nothing, asks retrieving nothing to cite) and puts throughput underneath.
 */
export function StatsTab({ days, nonce }: { days: number; nonce: number }) {
  const [data, setData] = useState<UsageInsights | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setData(null);
    api
      .usageInsights(days)
      .then((d) => {
        if (live) {
          setData(d);
          setError('');
        }
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [days, nonce]);

  if (error) return <Empty title="Cannot load insights." hint={error} />;
  if (!data) return <Spinner label="computing insights" />;

  const { ask, search } = data;
  const totalTokens = ask.promptTokens + ask.completionTokens;
  if (ask.calls === 0 && search.calls === 0) {
    return (
      <Empty
        title="No searches or asks in this window."
        hint="Widen the range, or use Atlas from an agent or the app and come back."
      />
    );
  }

  return (
    <ScrollView scrollEnabled={false} contentContainerStyle={{ gap: 26 }}>
      <View>
        <Eyebrow>Did it work?</Eyebrow>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Rate
            label="Searches with no hits"
            value={search.zeroResult}
            of={search.calls}
            hint="retrieval found nothing at all"
            tone={search.zeroResult > 0 ? colors.report : colors.git}
          />
          <Rate
            label="Asks with no sources"
            value={ask.zeroSource}
            of={ask.calls}
            hint="answered with no evidence to cite"
            tone={ask.zeroSource > 0 ? colors.report : colors.git}
          />
          <Rate
            label="Asks abandoned"
            value={ask.aborted}
            of={ask.calls}
            hint="you gave up before the answer landed"
            tone={ask.aborted > 0 ? colors.kdb : colors.git}
          />
          <Rate
            label="Asks degraded or failed"
            value={ask.degraded + ask.failed}
            of={ask.calls}
            hint="LLM unreachable, or the stream broke"
            tone={ask.degraded + ask.failed > 0 ? colors.report : colors.git}
          />
        </View>
      </View>

      <View>
        <Eyebrow>Search</Eyebrow>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <StatTile label="Searches" value={compact(search.calls)} hint={`last ${data.days}d`} />
          <StatTile label="Median" value={millis(search.p50Ms)} hint="half are faster" />
          <StatTile label="p95" value={millis(search.p95Ms)} hint="the slow tail" />
          <StatTile label="Median hits" value={exact(search.medianResults)} hint="results per search" />
        </View>
      </View>

      <View>
        <Eyebrow>Ask</Eyebrow>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <StatTile label="Asks" value={compact(ask.calls)} hint={`last ${data.days}d`} />
          <StatTile label="Median" value={millis(ask.p50Ms)} hint="end to end" />
          <StatTile label="First token" value={millis(ask.avgTtftMs)} hint="average wait before prose" />
          <StatTile
            label="Tokens"
            value={compact(totalTokens)}
            hint={
              totalTokens > 0
                ? `${compact(ask.promptTokens)} in · ${compact(ask.completionTokens)} out`
                : 'none reported'
            }
          />
        </View>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 24 }}>
        <View style={{ minWidth: '100%' }}>
          <Eyebrow>Latency distribution</Eyebrow>
          {/* Reordered here: SQL returns buckets unordered. */}
          <Histogram
            buckets={LATENCY_BUCKETS.map((bucket) => ({
              bucket,
              calls: data.latency.find((l) => l.bucket === bucket)?.calls ?? 0,
            }))}
          />
        </View>
        <View style={{ minWidth: '100%' }}>
          <Eyebrow>By weekday</Eyebrow>
          <BarListNative items={DOW.map((label, i) => ({
            key: label,
            calls: data.byDow.find((d) => d.dow === i + 1)?.calls ?? 0,
            color: colors.claude,
          }))} emptyLabel="no calls in this window" />
        </View>
      </View>

      {data.models.length > 0 ? (
        <View>
          <Eyebrow>Models that answered</Eyebrow>
          <BarListNative
            items={data.models.map((m) => ({
              key: m.model,
              calls: m.calls,
              color: colors.doc,
            }))}
          />
          {data.models.length > 1 ? (
            <Text style={{ fontSize: 11, color: colors.faint, marginTop: 6, lineHeight: 16 }}>
              More than one model served answers in this window — gateways substitute by routing
              policy, and this is the record of what actually ran.
            </Text>
          ) : null}
        </View>
      ) : null}

      <View>
        <Eyebrow>Most repeated questions</Eyebrow>
        {data.topQueries.length === 0 ? (
          <Text style={{ fontSize: 12, color: colors.faint }}>nothing asked more than once</Text>
        ) : (
          <View style={{ gap: 4 }}>
            {data.topQueries.map((q) => (
              <View key={q.query} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: 5 }}>
                <Text numberOfLines={1} style={{ fontSize: 12.5, flex: 1 }}>
                  {summarizeQuery(q.query) || '—'}
                </Text>
                <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>
                  {relativeTime(q.lastAt)}
                </Text>
                <Text style={{ fontFamily: fonts.mono, fontSize: 10.5, width: 28, textAlign: 'right' }}>
                  ×{q.calls}
                </Text>
              </View>
            ))}
          </View>
        )}
        <Text style={{ fontSize: 11, color: colors.faint, marginTop: 8, lineHeight: 16 }}>
          A question asked repeatedly is either important or unanswered. Open it in Calls to see
          what came back each time.
        </Text>
      </View>

      <Text style={{ fontSize: 11, color: colors.faint, lineHeight: 16 }}>
        Counts cover {plural(data.days, 'day')}. Search and ask only — navigation and polling are
        excluded here.
      </Text>
    </ScrollView>
  );
}

function BarListNative({
  items,
  emptyLabel = 'nothing recorded',
}: {
  items: { key: string; calls: number; color?: string }[];
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return <Text style={{ fontSize: 12, color: colors.faint }}>{emptyLabel}</Text>;
  }
  const top = Math.max(...items.map((i) => i.calls), 1);
  return (
    <View style={{ gap: 5 }}>
      {items.map((i) => (
        <View key={i.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.muted, width: 96 }}>
            {i.key}
          </Text>
          <View style={{ flex: 1, height: 11, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.line }}>
            <View
              style={{
                height: '100%',
                minWidth: 2,
                width: `${(i.calls / top) * 100}%`,
                backgroundColor: i.color ?? colors.kdb,
                borderRadius: 3,
              }}
            />
          </View>
          <Text style={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.muted, width: 40, textAlign: 'right' }}>
            {compact(i.calls)}
          </Text>
        </View>
      ))}
    </View>
  );
}
