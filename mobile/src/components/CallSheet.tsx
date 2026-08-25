import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ROUTE_CLASS_META, describeQuery, millis, plural, relativeTime, compact, exact, type UsageCallDetail } from '@atlas/shared';
import { EmptyRule, Swatch } from './charts';
import { Eyebrow, Pulse } from './atoms';
import { Sheet } from './Sheet';
import { StatusBadgeNative } from './StatusBadge';
import { api } from '../api/endpoints';
import { colors, fonts, tint } from '../theme';

/**
 * One call in full: what was asked, what came back, what it cost. The native
 * form of the web CallDrawer — an aggregate can say ask is slow; only this can
 * say whether the answer was worth the wait.
 */
export function CallSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const [call, setCall] = useState<UsageCallDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setCall(null);
    setError('');
    if (id == null) return;
    api
      .usageCall(id)
      .then((c) => alive && setCall(c))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id]);

  const asked = useMemo(() => describeQuery(call?.query), [call?.query]);
  const reply = call?.reply;

  return (
    <Sheet open={id != null} onClose={onClose}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32 }}
      >
        <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint }}>
          {id != null ? `call #${id}` : ''}
        </Text>
        <Text style={{ fontFamily: fonts.display, fontSize: 15, fontWeight: '600', marginTop: 2 }} numberOfLines={1}>
          {call?.tool ?? call?.path ?? '…'}
        </Text>

        <View style={{ marginTop: 16, gap: 18 }}>
          {error ? <Text style={{ color: colors.report, fontSize: 13 }}>{error}</Text> : null}
          {!call && !error ? <Pulse label="loading call" /> : null}

          {call ? (
            <>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
                <Field label="When">
                  <Text style={fieldValue}>{relativeTime(call.at)}</Text>
                </Field>
                <Field label="Client">
                  <Swatch color={clientColorOf(call.client)}>{call.client}</Swatch>
                </Field>
                <Field label="Route">
                  <Text style={[fieldValue, { fontFamily: fonts.mono, fontSize: 11.5 }]}>
                    {call.method} {call.path}
                  </Text>
                </Field>
                <Field label="Class">
                  <Text style={[fieldValue, { fontFamily: fonts.mono, fontSize: 11.5 }]}>
                    {call.routeClass}
                  </Text>
                </Field>
                <Field label="Took">
                  <Text style={fieldValue}>{millis(call.durationMs)}</Text>
                </Field>
                <Field label="Outcome">
                  <StatusBadgeNative status={call.status} />
                </Field>
                {reply?.model ? (
                  <Field label="Model served">
                    <Text style={fieldValue}>
                      {reply.model}
                      {reply.attempts != null && reply.attempts > 1 ? ` · ${reply.attempts} attempts` : ''}
                    </Text>
                  </Field>
                ) : null}
                {reply?.requestId ? (
                  <Field label="Gateway request">
                    <Text selectable style={[fieldValue, { fontFamily: fonts.mono, fontSize: 11 }]}>
                      {reply.requestId}
                    </Text>
                  </Field>
                ) : null}
                {reply?.ttftMs != null ? (
                  <Field label="First token">
                    <Text style={fieldValue}>{millis(reply.ttftMs)}</Text>
                  </Field>
                ) : null}
                {reply?.promptTokens != null ? (
                  <Field label="Tokens">
                    <Text style={fieldValue}>
                      {compact(reply.promptTokens)} in
                      {reply.completionTokens != null ? ` · ${compact(reply.completionTokens)} out` : ''}
                    </Text>
                  </Field>
                ) : null}
                {reply?.resultCount != null ? (
                  <Field label="Results">
                    <Text style={fieldValue}>{plural(reply.resultCount, 'result')}</Text>
                  </Field>
                ) : null}
              </View>

              {asked ? (
                <View>
                  <Eyebrow>Asked</Eyebrow>
                  {asked.text ? (
                    <Text style={{ fontSize: 13.5, lineHeight: 19, color: colors.ink }}>{asked.text}</Text>
                  ) : (
                    <Text style={{ fontSize: 12, color: colors.faint }}>no search text — filters only</Text>
                  )}
                  {asked.filters.length > 0 ? (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                      {asked.filters.map((f) => (
                        <Text
                          key={`${f.key}-${f.value}`}
                          style={{
                            fontFamily: fonts.mono,
                            fontSize: 10,
                            backgroundColor: colors.panel2,
                            color: colors.muted,
                            paddingHorizontal: 6,
                            paddingVertical: 3,
                            borderRadius: 4,
                            overflow: 'hidden',
                          }}
                        >
                          {f.key}: {f.value}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                </View>
              ) : null}

              {reply?.degraded ? (
                <Text
                  style={{
                    fontSize: 12,
                    lineHeight: 17,
                    color: colors.report,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: tint(colors.report, 45),
                    borderRadius: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 9,
                  }}
                >
                  Degraded answer — the LLM was unreachable, so Atlas returned the retrieved sources
                  with an explanation instead of a synthesis.
                </Text>
              ) : null}

              {reply?.error ? (
                <View>
                  <Eyebrow>Failed with</Eyebrow>
                  <Text
                    selectable
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 11.5,
                      color: colors.report,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: tint(colors.report, 40),
                      borderRadius: 8,
                      paddingHorizontal: 12,
                      paddingVertical: 9,
                    }}
                  >
                    {reply.error}
                  </Text>
                </View>
              ) : null}

              {reply?.answer ? (
                <View>
                  <Eyebrow>Atlas answered</Eyebrow>
                  <Text selectable style={{ fontSize: 13.5, lineHeight: 20, color: colors.ink }}>
                    {reply.answer}
                  </Text>
                </View>
              ) : null}

              {reply?.topHits && reply.topHits.length > 0 ? (
                <View>
                  <Eyebrow>Top sources</Eyebrow>
                  <View style={{ gap: 7 }}>
                    {reply.topHits.map((h, i) => (
                      <View key={`${h.entryId}-${i}`} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint, width: 16 }}>
                          {i + 1}
                        </Text>
                        <Text numberOfLines={1} style={{ flex: 1, fontSize: 12.5, color: colors.ink }}>
                          {h.title}
                        </Text>
                        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>
                          {h.projectSlug}
                        </Text>
                        {h.score != null ? (
                          <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.kdb }}>
                            {h.score.toFixed(3)}
                          </Text>
                        ) : null}
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              {!call.hasReply ? (
                <>
                  <EmptyRule />
                  <Text style={{ fontSize: 12, color: colors.faint, lineHeight: 17 }}>
                    No reply was recorded for this call. Replies are kept for search and ask only.
                  </Text>
                </>
              ) : null}
            </>
          ) : null}
        </View>
      </ScrollView>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ minWidth: '30%' }}>
      <Text style={{ fontFamily: fonts.mono, fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 1.2, color: colors.faint }}>
        {label}
      </Text>
      <View style={{ marginTop: 2 }}>{children}</View>
    </View>
  );
}

const fieldValue = { fontSize: 12.5, color: colors.ink };

import { clientColor as clientColorOf } from '@atlas/shared';
