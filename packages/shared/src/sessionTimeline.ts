/**
 * Timeline layout for the related-sessions view. Pure math, no rendering:
 * the web app draws the result as SVG and the native app as react-native-svg,
 * from the same numbers, so the two cannot drift.
 *
 * The one real problem here is scale. Real sessions cluster: six in one
 * afternoon, then nothing for three months, then four more. Laid out on a
 * linear time axis that whole afternoon collapses into a single unreadable
 * blob at one end while the middle of the chart is empty. So position is not
 * time — it is CUMULATIVE COMPRESSED GAP: sort by time, and advance by
 * log1p(days) between neighbours. Order is preserved exactly, adjacent events
 * stay adjacent, and a three-month silence costs a few times what an hour
 * costs rather than a thousand times.
 *
 * The axis is therefore not linear and must never be labelled as though it
 * were. `ticks` carry real dates at real positions for exactly that reason.
 */

export type TimelineKind = 'anchor' | 'session' | 'event';

export interface TimelineInput {
  id: string;
  at?: string;
  kind: TimelineKind;
  label: string;
  /** Drives node size. 0-1; the anchor is always drawn largest. */
  weight?: number;
  /** Drives node colour; the caller maps it to a palette entry. */
  group?: string;
  /** Normalised paths, used to draw shared-file links between nodes. */
  files?: string[];
}

export interface TimelineNode extends TimelineInput {
  /** 0-1 along the axis. */
  pos: number;
  /** 0-1 radius factor; multiply by the renderer's own scale. */
  size: number;
  /** Lane index; separates sessions from context events. */
  lane: number;
  ms: number;
}

export interface TimelineEdge {
  from: string;
  to: string;
  /** Count of shared files — drives stroke weight. */
  shared: number;
}

export interface TimelineTick {
  pos: number;
  at: string;
  label: string;
}

export interface TimelineLayout {
  nodes: TimelineNode[];
  edges: TimelineEdge[];
  ticks: TimelineTick[];
  /** True when positions are compressed — the axis is not linear time. */
  compressed: boolean;
  span?: { from: string; to: string };
}

export interface TimelineOptions {
  /** Max edges drawn; the densest links win. */
  maxEdges?: number;
  /** Node size floor, so a weightless node is still clickable. */
  minSize?: number;
}

const DAY_MS = 24 * 3600_000;

/**
 * Minimum axis distance between adjacent events, in the same log-units the
 * gaps are measured in. ~0.35 is a third of a day's worth of gap: enough that
 * two sessions an hour apart do not overlap, small enough that a real month of
 * silence still looks like a real month of silence.
 */
const MIN_STEP = 0.35;

function labelFor(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
}

/**
 * Lay out an anchor plus its neighbours.
 *
 * Every degenerate case has a defined answer rather than a division by zero:
 * no dated events at all spaces everything evenly; one dated event centres it;
 * events that all share a timestamp space evenly too (their order is arbitrary
 * but their positions must still be distinct enough to click).
 */
export function layoutTimeline(items: TimelineInput[], opts: TimelineOptions = {}): TimelineLayout {
  const minSize = opts.minSize ?? 0.35;
  const dated = items
    .map((i) => ({ item: i, ms: i.at ? Date.parse(i.at) : NaN }))
    .filter((x) => Number.isFinite(x.ms))
    .sort((a, b) => a.ms - b.ms);
  const undatedItems = items.filter((i) => !i.at || !Number.isFinite(Date.parse(i.at)));

  const sizeOf = (i: TimelineInput) =>
    i.kind === 'anchor' ? 1 : Math.max(minSize, Math.min(i.weight ?? minSize, 1));
  const laneOf = (i: TimelineInput) => (i.kind === 'event' ? 1 : 0);

  const nodes: TimelineNode[] = [];
  let ticks: TimelineTick[] = [];
  let compressed = false;
  let span: TimelineLayout['span'];

  if (dated.length === 0) {
    // Nothing has a usable timestamp. Even spacing is the only honest layout,
    // and no ticks are drawn because there is no time to label.
    items.forEach((item, idx) => {
      nodes.push({
        ...item,
        pos: items.length === 1 ? 0.5 : idx / (items.length - 1),
        size: sizeOf(item),
        lane: laneOf(item),
        ms: NaN,
      });
    });
    return { nodes, edges: edgesFor(nodes, opts.maxEdges), ticks, compressed: false };
  }

  // Cumulative compressed gap. `log1p` of the gap in days: 0 for simultaneous,
  // ~0.7 for a day, ~3.4 for a month, ~4.5 for three months — so a quarter-year
  // silence is worth about six days, not ninety.
  //
  // The floor is not decoration. log1p alone still gave three sessions in one
  // afternoon only 4.9% of an axis spanning three months (measured), which is
  // narrower than the nodes themselves — they would overlap into one blob, the
  // exact failure compression exists to prevent. MIN_STEP guarantees adjacent
  // events are always separated enough to be individually clickable, while a
  // month-long gap still reads about ten times wider than a same-day one.
  const offsets: number[] = [0];
  for (let i = 1; i < dated.length; i++) {
    const gapDays = Math.max(0, (dated[i]!.ms - dated[i - 1]!.ms) / DAY_MS);
    offsets.push(offsets[i - 1]! + Math.max(Math.log1p(gapDays), MIN_STEP));
  }
  const total = offsets[offsets.length - 1]!;
  compressed = dated.length > 1 && total > 0;

  dated.forEach((d, idx) => {
    // A zero total means every event shares a timestamp: spread them evenly so
    // they remain individually reachable instead of stacking into one dot.
    const pos = total > 0 ? offsets[idx]! / total : dated.length === 1 ? 0.5 : idx / (dated.length - 1);
    nodes.push({ ...d.item, pos, size: sizeOf(d.item), lane: laneOf(d.item), ms: d.ms });
  });

  // Undated items are real results and must not vanish. They go to the far
  // left — before everything datable — rather than being silently dropped.
  undatedItems.forEach((item) => {
    nodes.push({ ...item, pos: 0, size: sizeOf(item), lane: laneOf(item), ms: NaN });
  });

  const first = dated[0]!;
  const last = dated[dated.length - 1]!;
  span = { from: new Date(first.ms).toISOString(), to: new Date(last.ms).toISOString() };
  ticks = tickPositions(dated.map((d) => ({ ms: d.ms, pos: nodes.find((n) => n.id === d.item.id)!.pos })));

  return { nodes, edges: edgesFor(nodes, opts.maxEdges), ticks, compressed, span };
}

/**
 * Date labels at the positions events actually occupy.
 *
 * Derived from the nodes rather than from evenly-spaced time, because the axis
 * is compressed: a tick placed at "half way along" would name a date that is
 * nowhere near the middle of the span, which is worse than no tick at all.
 */
function tickPositions(points: { ms: number; pos: number }[], max = 5): TimelineTick[] {
  if (!points.length) return [];
  const unique: { ms: number; pos: number }[] = [];
  for (const p of points) {
    if (!unique.some((u) => Math.abs(u.pos - p.pos) < 0.12)) unique.push(p);
  }
  const step = Math.max(1, Math.ceil(unique.length / max));
  return unique
    .filter((_, i) => i % step === 0)
    .slice(0, max)
    .map((p) => ({ pos: p.pos, at: new Date(p.ms).toISOString(), label: labelFor(p.ms) }));
}

/**
 * Links between nodes that touched the same files.
 *
 * These are the visual claim that two sessions are the same piece of work, so
 * they are drawn only from real shared paths — never from proximity, which is
 * what the axis already shows.
 */
function edgesFor(nodes: TimelineNode[], maxEdges = 24): TimelineEdge[] {
  const withFiles = nodes.filter((n) => n.files?.length);
  const edges: TimelineEdge[] = [];
  for (let i = 0; i < withFiles.length; i++) {
    for (let j = i + 1; j < withFiles.length; j++) {
      const a = withFiles[i]!;
      const b = withFiles[j]!;
      const bs = new Set(b.files);
      const shared = a.files!.filter((f) => bs.has(f)).length;
      if (shared > 0) edges.push({ from: a.id, to: b.id, shared });
    }
  }
  return edges.sort((x, y) => y.shared - x.shared).slice(0, maxEdges);
}

/**
 * A one-line description of the whole chart, for screen readers.
 *
 * The chart is an enhancement over the ranked list beneath it, never the only
 * way to the data — this is what makes that true rather than merely claimed.
 */
export function describeTimeline(layout: TimelineLayout): string {
  const sessions = layout.nodes.filter((n) => n.kind !== 'event').length;
  const events = layout.nodes.filter((n) => n.kind === 'event').length;
  const parts = [`Timeline of ${sessions} session${sessions === 1 ? '' : 's'}`];
  if (events) parts.push(`and ${events} related record${events === 1 ? '' : 's'}`);
  if (layout.span) {
    parts.push(`from ${labelFor(Date.parse(layout.span.from))} to ${labelFor(Date.parse(layout.span.to))}`);
  }
  if (layout.compressed) parts.push('(gaps are compressed, so the axis is not linear time)');
  return `${parts.join(' ')}.`;
}
