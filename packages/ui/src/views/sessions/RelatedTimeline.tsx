import { useMemo, useRef, useState } from 'react';
import {
  DIRECTION_LABEL,
  PALETTE,
  describeBasis,
  describeTimeline,
  layoutTimeline,
  relatedStrength,
  type RelatedResponse,
  type TimelineInput,
  type TimelineNode,
} from '@atlas/shared';

/**
 * The related-sessions timeline.
 *
 * A chart, and never the only path to the data: the ranked list beneath it
 * carries everything this draws, so the SVG is an enhancement. That is what
 * makes it safe to be a chart at all — it can be ignored, magnified, or
 * unreachable, and nothing is lost.
 *
 * The axis is a COMPRESSED gap scale, not linear time (see
 * `@atlas/shared/sessionTimeline`). It says so on screen, because a compressed
 * axis read as a linear one is a chart that lies.
 */

const WIDTH = 900;
const HEIGHT = 150;
const LANE_Y = [86, 126];
const AXIS_Y = 106;

function colorFor(node: TimelineNode, anchorProject: string): string {
  if (node.kind === 'anchor') return PALETTE.kdb;
  if (node.kind === 'event') return PALETTE.git;
  return node.group === anchorProject ? PALETTE.claude : PALETTE.doc;
}

export function RelatedTimeline({
  data,
  onOpenSession,
  selectedId,
  onSelect,
}: {
  data: RelatedResponse;
  onOpenSession: (id: string) => void;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);

  const layout = useMemo(() => {
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
    return layoutTimeline(items);
  }, [data]);

  const nodes = layout.nodes;
  const x = (pos: number) => 24 + pos * (WIDTH - 48);
  const posById = new Map(nodes.map((n) => [n.id, n]));

  // Arrow keys walk the nodes. A chart whose only interaction is a mouse is
  // unusable to a keyboard reader, and the list below is a fallback for
  // reading, not for navigating between related sessions.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Enter') return;
    e.preventDefault();
    if (e.key === 'Enter') {
      const n = nodes[focusIdx];
      if (n && n.kind !== 'event') onOpenSession(n.id);
      return;
    }
    const next = Math.min(
      Math.max(focusIdx + (e.key === 'ArrowRight' ? 1 : -1), 0),
      nodes.length - 1,
    );
    setFocusIdx(next);
    onSelect(nodes[next]?.id);
  };

  if (!nodes.length) return null;

  return (
    <div>
      {/* Horizontal scroll is contained here; the page itself never scrolls
          sideways, at any width. */}
      <div className="overflow-x-auto -mx-1 px-1">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full min-w-[560px] select-none"
          style={{ height: HEIGHT }}
          role="img"
          aria-label={describeTimeline(layout)}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => onSelect(undefined)}
        >
          <title>{describeTimeline(layout)}</title>

          <line x1={24} y1={AXIS_Y} x2={WIDTH - 24} y2={AXIS_Y} stroke="var(--color-line)" strokeWidth={1} />

          {layout.ticks.map((t) => (
            <g key={t.at}>
              <line
                x1={x(t.pos)}
                y1={AXIS_Y - 4}
                x2={x(t.pos)}
                y2={AXIS_Y + 4}
                stroke="var(--color-line)"
              />
              <text
                x={x(t.pos)}
                y={AXIS_Y + 18}
                textAnchor="middle"
                className="font-mono"
                fontSize={9}
                fill="var(--color-faint)"
              >
                {t.label}
              </text>
            </g>
          ))}

          {/* Shared-file ribbons: the visual claim that two nodes are the same
              piece of work. Drawn only from real shared paths. */}
          {layout.edges.map((e) => {
            const a = posById.get(e.from);
            const b = posById.get(e.to);
            if (!a || !b) return null;
            const ax = x(a.pos);
            const bx = x(b.pos);
            const ay = LANE_Y[a.lane] ?? LANE_Y[0]!;
            const by = LANE_Y[b.lane] ?? LANE_Y[0]!;
            const lift = Math.min(48, 12 + Math.abs(bx - ax) * 0.12);
            return (
              <path
                key={`${e.from}-${e.to}`}
                d={`M ${ax} ${ay} C ${ax} ${ay - lift}, ${bx} ${by - lift}, ${bx} ${by}`}
                fill="none"
                stroke={PALETTE.git}
                strokeOpacity={Math.min(0.15 + e.shared * 0.12, 0.6)}
                strokeWidth={Math.min(1 + e.shared * 0.5, 3)}
              />
            );
          })}

          {nodes.map((n, i) => {
            const cx = x(n.pos);
            const cy = LANE_Y[n.lane] ?? LANE_Y[0]!;
            const r = n.kind === 'anchor' ? 9 : 3 + n.size * 6;
            const color = colorFor(n, data.anchor.projectSlug);
            const active = selectedId === n.id || focusIdx === i;
            return (
              <g
                key={n.id}
                onMouseEnter={() => onSelect(n.id)}
                onMouseLeave={() => onSelect(undefined)}
                onClick={() => {
                  setFocusIdx(i);
                  if (n.kind !== 'event') onOpenSession(n.id);
                }}
                style={{ cursor: n.kind === 'event' ? 'default' : 'pointer' }}
              >
                <line x1={cx} y1={AXIS_Y} x2={cx} y2={cy} stroke={color} strokeOpacity={0.3} />
                {active && (
                  <circle cx={cx} cy={cy} r={r + 4} fill="none" stroke={color} strokeOpacity={0.5} />
                )}
                <circle
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill={n.kind === 'event' ? 'var(--color-bg)' : color}
                  stroke={color}
                  strokeWidth={n.kind === 'event' ? 1.5 : 0}
                  fillOpacity={n.kind === 'event' ? 1 : 0.85}
                />
                {n.kind === 'anchor' && (
                  <text
                    x={cx}
                    y={cy - 16}
                    textAnchor="middle"
                    className="font-mono"
                    fontSize={9}
                    fill={PALETTE.kdb}
                  >
                    this session
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <p className="mt-1 font-mono text-[10px] text-faint">
        {describeBasis(data.basis)}
        {layout.compressed && ' Gaps are compressed — the axis is not linear time.'}
      </p>
    </div>
  );
}

/** The ranked list. Always present: it is the timeline's equal, not its caption. */
export function RelatedList({
  data,
  onOpen,
  hoveredId,
  onHover,
}: {
  data: RelatedResponse;
  onOpen: (id: string) => void;
  hoveredId?: string;
  onHover: (id: string | undefined) => void;
}) {
  return (
    <div className="space-y-1.5">
      {data.related.map((r) => {
        const strength = relatedStrength(r.score);
        return (
          <div
            key={r.sessionId}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(r.sessionId)}
            onKeyDown={(e) => e.key === 'Enter' && onOpen(r.sessionId)}
            onMouseEnter={() => onHover(r.sessionId)}
            onMouseLeave={() => onHover(undefined)}
            className="rise border-l-[3px] bg-panel hover:bg-panel-2 transition-colors px-3 py-2 rounded-r-md cursor-pointer"
            style={{
              borderLeftColor:
                r.projectSlug === data.anchor.projectSlug ? PALETTE.claude : PALETTE.doc,
              outline: hoveredId === r.sessionId ? `1px solid ${PALETTE.line}` : undefined,
            }}
          >
            <div className="flex items-baseline gap-2 flex-wrap">
              <span
                className="font-mono text-[10px] tracking-widest"
                style={{
                  color:
                    strength === 'strong'
                      ? PALETTE.git
                      : strength === 'likely'
                        ? PALETTE.kdb
                        : PALETTE.faint,
                }}
              >
                {strength}
              </span>
              <span className="font-mono text-[10px] text-faint">
                {DIRECTION_LABEL[r.direction]}
              </span>
              {r.projectSlug !== data.anchor.projectSlug && (
                <span className="font-mono text-[10px] text-muted">{r.projectSlug}</span>
              )}
              <div className="flex-1" />
              <span className="font-mono text-[10px] text-faint">
                {r.entryCount} msg · {r.actionCount} actions
              </span>
            </div>
            <div className="mt-0.5 text-[13px] leading-snug">{r.title}</div>
            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px] text-faint">
              {r.why.map((w, i) => (
                <span key={i}>· {w.detail}</span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
