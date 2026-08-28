import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import {
  DIRECTION_LABEL,
  ENTRY_KIND_META as KIND,
  PALETTE,
  SESSION_SECTIONS,
  compact,
  describeBasis,
  describeDid,
  describeTimeline,
  layoutTimeline,
  plural,
  relatedStrength,
  sectionMeta,
  type RelatedResponse,
  type SessionInsightResponse,
  type SessionSearchResponse,
  type TimelineInput,
} from '@atlas/shared';
import { api } from '../../api/endpoints';
import { Badge, Empty, Eyebrow, Pulse, Spinner, Stamp } from '../../components/atoms';
import { Markdown } from '../../components/MarkdownNative';
import { colors, fonts, tint } from '../../theme';
import { SessionCardRow, type SessionTab } from './SessionPieces';

/* ---------------------------------------------------------------------- */
/* Find                                                                    */
/* ---------------------------------------------------------------------- */

/**
 * Session search on a phone. Unscoped by default, exactly as on the web: the
 * premise is that you remember the work, not which project it lived in.
 */
export function SessionFinder({
  scopeProjects,
  onOpen,
}: {
  scopeProjects: string[];
  onOpen: (id: string, tab: SessionTab) => void;
}) {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [result, setResult] = useState<SessionSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const run = () => {
    const query = q.trim();
    if (!query) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSubmitted(query);
    setLoading(true);
    setError('');
    api
      .findSessions({
        q: query,
        ...(scopeProjects.length ? { projects: scopeProjects.join(',') } : {}),
        limit: 25,
      })
      .then(setResult)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  return (
    <View>
      <TextInput
        value={q}
        onChangeText={setQ}
        onSubmitEditing={run}
        returnKeyType="search"
        placeholder="Describe the work, paste a session id, or name a file…"
        placeholderTextColor={colors.faint}
        multiline
        style={{
          backgroundColor: colors.panel,
          borderWidth: 1,
          borderColor: colors.line,
          borderRadius: 8,
          color: colors.ink,
          fontFamily: fonts.sans,
          fontSize: 14,
          minHeight: 56,
          paddingHorizontal: 12,
          paddingVertical: 10,
        }}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <Pressable
          onPress={run}
          disabled={!q.trim()}
          style={{
            backgroundColor: colors.kdb,
            opacity: q.trim() ? 1 : 0.4,
            borderRadius: 6,
            paddingHorizontal: 14,
            paddingVertical: 7,
          }}
        >
          <Text style={{ color: colors.bg, fontFamily: fonts.sansMedium, fontSize: 13 }}>Find</Text>
        </Pressable>
        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint, flex: 1 }}>
          searches every project unless the scope narrows it
        </Text>
        {loading ? <Pulse label="searching" /> : null}
      </View>

      {error ? <Empty title="Search failed." hint={error} /> : null}

      {result && !error ? (
        <View style={{ marginTop: 16, gap: 6 }}>
          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint }}>
            {result.sessions.length} session{result.sessions.length === 1 ? '' : 's'} ·{' '}
            {result.tookMs} ms
            {result.interpreted?.since
              ? ` · narrowed to ${result.interpreted.since.slice(0, 10)}`
              : ''}
          </Text>
          {result.sessions.map((s) => (
            <SessionCardRow key={s.sessionId} card={s} needle={submitted} onOpen={onOpen} />
          ))}
          {result.sessions.length === 0 ? (
            <Empty
              title="No session matches that."
              hint="Try fewer words, a file name, or widen the scope."
            />
          ) : null}
        </View>
      ) : null}

      {!result && !loading && !error ? (
        <View style={{ marginTop: 24 }}>
          <Empty
            title="Find a session by what you remember about it."
            hint="A phrase from the conversation, a file it touched, a project name, or an id."
          />
        </View>
      ) : null}
    </View>
  );
}

/* ---------------------------------------------------------------------- */
/* Insights                                                                */
/* ---------------------------------------------------------------------- */

function AiMark() {
  return (
    <Text
      style={{
        fontFamily: fonts.mono,
        fontSize: 9,
        color: colors.claude,
        backgroundColor: tint(colors.claude, 12),
      }}
    >
      {' AI '}
    </Text>
  );
}

function Section({ id, children }: { id: string; children: React.ReactNode }) {
  const meta = sectionMeta(id);
  return (
    <View style={{ marginTop: 20 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Eyebrow>{meta.label}</Eyebrow>
        {meta.source !== 'facts' ? <AiMark /> : null}
      </View>
      {children}
    </View>
  );
}

export function SessionInsightsPanel({ sessionId }: { sessionId: string }) {
  const [sections, setSections] = useState<string[]>(SESSION_SECTIONS.map((s) => s.id));
  const [useLlm, setUseLlm] = useState(true);
  const [report, setReport] = useState<SessionInsightResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api
      .sessionInsights(sessionId, {
        sections: sections.join(','),
        llm: useLlm ? undefined : 'false',
      })
      .then((r) => alive && setReport(r))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [sessionId, sections.join(','), useLlm]);

  const toggle = (id: string) => {
    void Haptics.selectionAsync();
    setSections((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  };

  if (error) return <Empty title="Could not build the report." hint={error} />;
  if (loading && !report) return <Spinner label="reading the session" />;
  if (!report) return null;

  const f = report.facts;
  const n = report.narrative;
  const show = (id: string) => sections.includes(id);

  return (
    <View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {SESSION_SECTIONS.map((s) => {
          const on = sections.includes(s.id);
          const color = s.source === 'facts' ? colors.kdb : colors.claude;
          return (
            <Pressable
              key={s.id}
              onPress={() => toggle(s.id)}
              style={{
                borderWidth: 1,
                borderColor: on ? color : colors.line,
                backgroundColor: on ? tint(color, 12) : 'transparent',
                borderRadius: 3,
                paddingHorizontal: 8,
                paddingVertical: 4,
              }}
            >
              <Text
                style={{ fontFamily: fonts.mono, fontSize: 10, color: on ? color : colors.faint }}
              >
                {s.label}
              </Text>
            </Pressable>
          );
        })}
        <Pressable onPress={() => setUseLlm((v) => !v)}>
          <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: useLlm ? colors.claude : colors.faint }}>
            AI layer {useLlm ? 'on' : 'off'}
          </Text>
        </Pressable>
      </View>

      {/* Provenance is never implicit: which half a model wrote is stated. */}
      <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint, marginTop: 8 }}>
        {report.llm.status === 'ok'
          ? `AI layer by ${report.llm.model ?? 'the configured model'}${report.cached ? ' · cached' : ''}`
          : report.llm.status === 'off'
            ? 'Recorded facts only — AI layer off.'
            : `AI layer unavailable (${report.llm.reason ?? 'no reason given'}) — recorded facts only.`}
      </Text>

      {n?.headline ? (
        <Text style={{ fontSize: 15, color: colors.ink, marginTop: 14 }}>
          <AiMark /> {n.headline}
        </Text>
      ) : null}
      {(n?.summary ?? []).map((line, i) => (
        <Text key={i} style={{ fontSize: 13, color: colors.muted, marginTop: 4 }}>
          {line}
        </Text>
      ))}

      {show('overview') ? (
        <Section id="overview">
          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted }}>
            {f.overview.projectSlug} · {plural(f.overview.entryCount, 'message')} ·{' '}
            {compact(f.overview.actionCount)} actions · {plural(f.overview.fileCount, 'file')}
          </Text>
          <Stamp iso={f.overview.startedAt} />
        </Section>
      ) : null}

      {show('goals') && f.goals?.length ? (
        <Section id="goals">
          {f.goals.map((g) => (
            <View
              key={g.entryId}
              style={{ borderLeftWidth: 2, borderLeftColor: KIND.prompt.color, paddingLeft: 8, marginTop: 6 }}
            >
              <Markdown text={g.text} />
            </View>
          ))}
        </Section>
      ) : null}

      {show('did') && f.did ? (
        <Section id="did">
          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted }}>
            {describeDid(f.did) || 'No recorded tool activity.'}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {f.did.commands.map((c) => (
              <View
                key={c.name}
                style={{ backgroundColor: colors.panel2, borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2 }}
              >
                <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>
                  {c.name} ×{c.count}
                </Text>
              </View>
            ))}
          </View>
          {f.did.files.map((x) => (
            <Text
              key={x.path}
              numberOfLines={1}
              style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted, marginTop: 2 }}
            >
              {x.path}
            </Text>
          ))}
        </Section>
      ) : null}

      {show('highlights') && f.highlights?.length ? (
        <Section id="highlights">
          {f.highlights.map((h) => (
            <View
              key={h.entryId}
              style={{ borderLeftWidth: 2, borderLeftColor: KIND[h.kind].color, paddingLeft: 8, marginTop: 8 }}
            >
              <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: KIND[h.kind].color }}>
                {KIND[h.kind].label}
              </Text>
              <Markdown text={h.text} />
            </View>
          ))}
        </Section>
      ) : null}

      {show('decisions') && n?.decisions?.length ? (
        <Section id="decisions">
          {n.decisions.map((d, i) => (
            <Text key={i} style={{ fontSize: 13, color: colors.ink, marginTop: 4 }}>
              {d.text}
              {d.why ? <Text style={{ color: colors.muted }}> — {d.why}</Text> : null}
            </Text>
          ))}
        </Section>
      ) : null}

      {show('problems') && n?.problems?.length ? (
        <Section id="problems">
          {n.problems.map((x, i) => (
            <Text key={i} style={{ fontSize: 13, color: colors.ink, marginTop: 4 }}>
              {x.text}
              {x.resolution ? <Text style={{ color: colors.muted }}> → {x.resolution}</Text> : null}
            </Text>
          ))}
        </Section>
      ) : null}

      {show('followups') && (n?.followups?.length || f.followupMarkers?.length) ? (
        <Section id="followups">
          {(n?.followups ?? []).map((x, i) => (
            <Text key={i} style={{ fontSize: 13, color: colors.ink, marginTop: 4 }}>
              {x.text}
              {x.confidence ? (
                <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>
                  {' '}
                  ({x.confidence})
                </Text>
              ) : null}
            </Text>
          ))}
          {/* The raw markers stay visible beside the distilled list. */}
          {(f.followupMarkers ?? []).map((m, i) => (
            <Text key={`m${i}`} style={{ fontSize: 12, color: colors.muted, marginTop: 4 }}>
              <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.faint }}>
                {m.marker}{' '}
              </Text>
              {m.sentence}
            </Text>
          ))}
        </Section>
      ) : null}

      {show('backlog') && f.backlog?.length ? (
        <Section id="backlog">
          {f.backlog.map((b) => (
            <Text key={`${b.sourcePath}:${b.line}`} style={{ fontSize: 12, color: colors.muted, marginTop: 3 }}>
              <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>
                L{b.line}{' '}
              </Text>
              {b.text}
            </Text>
          ))}
        </Section>
      ) : null}

      {show('trail') && f.trail?.length ? (
        <Section id="trail">
          {f.trail.map((t) => (
            <View
              key={t.entryId}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}
            >
              <Badge source={t.sourceType} />
              <Text numberOfLines={1} style={{ fontSize: 12, color: colors.ink, flex: 1 }}>
                {t.title}
              </Text>
              {t.sharedFiles?.length ? (
                <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.git }}>
                  {t.sharedFiles.length} shared
                </Text>
              ) : null}
            </View>
          ))}
        </Section>
      ) : null}
    </View>
  );
}

/* ---------------------------------------------------------------------- */
/* Related                                                                 */
/* ---------------------------------------------------------------------- */

const CHART_W = 320;
const LANE_X = [70, 118];

/**
 * The timeline, vertical.
 *
 * Same layout function as the web — only the axis is rotated, because a phone
 * has height to spend and no width. The ranked list below it is, as on the web,
 * the equal of the chart rather than its caption.
 */
function VerticalTimeline({
  data,
  onOpenSession,
}: {
  data: RelatedResponse;
  onOpenSession: (id: string) => void;
}) {
  const items: TimelineInput[] = [
    {
      id: data.anchor.sessionId,
      at: data.anchor.startedAt,
      kind: 'anchor',
      label: data.anchor.title,
      group: data.anchor.projectSlug,
      files: data.anchor.filesTouched,
    },
    ...data.related.map(
      (r): TimelineInput => ({
        id: r.sessionId,
        at: r.startedAt,
        kind: 'session',
        label: r.title,
        weight: r.score,
        group: r.projectSlug,
        files: r.sharedFiles,
      }),
    ),
    ...(data.contextEvents ?? []).map(
      (e): TimelineInput => ({
        id: `event:${e.entryId}`,
        at: e.occurredAt,
        kind: 'event',
        label: e.title,
        weight: 0.3,
        group: e.projectSlug,
        files: e.sharedFiles,
      }),
    ),
  ];
  const layout = layoutTimeline(items);
  if (!layout.nodes.length) return null;

  const height = Math.max(180, layout.nodes.length * 26);
  const y = (pos: number) => 16 + pos * (height - 32);
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));

  return (
    <View>
      <Svg width={CHART_W} height={height} accessibilityLabel={describeTimeline(layout)}>
        <Line x1={LANE_X[0]} y1={12} x2={LANE_X[0]} y2={height - 12} stroke={colors.line} />
        {layout.ticks.map((t) => (
          <SvgText
            key={t.at}
            x={LANE_X[0]! - 10}
            y={y(t.pos) + 3}
            fontSize={9}
            fill={colors.faint}
            textAnchor="end"
            fontFamily={fonts.mono}
          >
            {t.label}
          </SvgText>
        ))}
        {layout.edges.map((e) => {
          const a = byId.get(e.from);
          const b = byId.get(e.to);
          if (!a || !b) return null;
          const ax = LANE_X[a.lane] ?? LANE_X[0]!;
          const bx = LANE_X[b.lane] ?? LANE_X[0]!;
          const ay = y(a.pos);
          const by = y(b.pos);
          const out = Math.min(40, 14 + Math.abs(by - ay) * 0.12);
          return (
            <Path
              key={`${e.from}-${e.to}`}
              d={`M ${ax} ${ay} C ${ax + out} ${ay}, ${bx + out} ${by}, ${bx} ${by}`}
              fill="none"
              stroke={PALETTE.git}
              strokeOpacity={Math.min(0.15 + e.shared * 0.12, 0.6)}
              strokeWidth={Math.min(1 + e.shared * 0.5, 3)}
            />
          );
        })}
        {layout.nodes.map((n) => {
          const cx = LANE_X[n.lane] ?? LANE_X[0]!;
          const cy = y(n.pos);
          const r = n.kind === 'anchor' ? 8 : 3 + n.size * 5;
          const color =
            n.kind === 'anchor'
              ? PALETTE.kdb
              : n.kind === 'event'
                ? PALETTE.git
                : n.group === data.anchor.projectSlug
                  ? PALETTE.claude
                  : PALETTE.doc;
          return (
            <Circle
              key={n.id}
              cx={cx}
              cy={cy}
              r={r}
              fill={n.kind === 'event' ? colors.bg : color}
              stroke={color}
              strokeWidth={n.kind === 'event' ? 1.5 : 0}
              onPress={() => {
                if (n.kind !== 'event') onOpenSession(n.id);
              }}
            />
          );
        })}
      </Svg>
      <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint, marginTop: 4 }}>
        {describeBasis(data.basis)}
        {layout.compressed ? ' Gaps are compressed — the axis is not linear time.' : ''}
      </Text>
    </View>
  );
}

export function SessionRelatedPanel({
  sessionId,
  onOpenSession,
}: {
  sessionId: string;
  onOpenSession: (id: string) => void;
}) {
  const [data, setData] = useState<RelatedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api
      .sessionRelated(sessionId)
      .then((r) => alive && setData(r))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  if (error) return <Empty title="Could not look for related sessions." hint={error} />;
  if (loading) return <Spinner label="tracing this work" />;
  if (!data) return null;

  return (
    <View>
      {data.related.length > 0 ? (
        <VerticalTimeline data={data} onOpenSession={onOpenSession} />
      ) : null}

      <View style={{ marginTop: 16, gap: 6 }}>
        {data.related.length > 0 ? <Eyebrow>Related sessions</Eyebrow> : null}
        {data.related.map((r) => {
          const strength = relatedStrength(r.score);
          return (
            <Pressable
              key={r.sessionId}
              onPress={() => onOpenSession(r.sessionId)}
              style={({ pressed }) => ({
                borderLeftWidth: 3,
                borderLeftColor:
                  r.projectSlug === data.anchor.projectSlug ? colors.claude : colors.doc,
                backgroundColor: pressed ? colors.panel2 : colors.panel,
                borderTopRightRadius: 8,
                borderBottomRightRadius: 8,
                paddingHorizontal: 12,
                paddingVertical: 8,
              })}
            >
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Text
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 10,
                    color:
                      strength === 'strong'
                        ? colors.git
                        : strength === 'likely'
                          ? colors.kdb
                          : colors.faint,
                  }}
                >
                  {strength}
                </Text>
                <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint }}>
                  {DIRECTION_LABEL[r.direction]}
                </Text>
                <View style={{ flex: 1 }} />
                <Stamp iso={r.startedAt} />
              </View>
              <Text style={{ fontSize: 13, color: colors.ink, marginTop: 2 }} numberOfLines={2}>
                {r.title}
              </Text>
              <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint, marginTop: 2 }}>
                {r.why.map((w) => w.detail).join(' · ')}
              </Text>
            </Pressable>
          );
        })}
        {data.related.length === 0 ? (
          <Empty title="Nothing else worked on this." hint={data.note} />
        ) : null}
      </View>

      {data.contextEvents?.length ? (
        <View style={{ marginTop: 20 }}>
          <Eyebrow>Other records touching the same files</Eyebrow>
          {data.contextEvents.map((e) => (
            <View
              key={e.entryId}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}
            >
              <Badge source={e.sourceType} />
              <Text numberOfLines={1} style={{ fontSize: 12, color: colors.ink, flex: 1 }}>
                {e.title}
              </Text>
              <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.git }}>
                {e.sharedFiles.length} shared
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
