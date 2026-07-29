import { rangeLabel, type DateRange, type RangeUnit } from '../../dateRange';
import type { UsageFacet } from '../../types';
import { clientColor } from '../../components/charts';
import { compact } from '../../format';

/**
 * The filter bar. Extracted from MonitorView because it is the one piece both
 * the Calls and Stats tabs read from, and because a control panel that grows a
 * new input per feature is exactly the file that should not also hold a table,
 * a drawer and three charts.
 *
 * Every control is driven by a facet count from the server, so an option that
 * would return nothing is visibly empty rather than a dead end you discover by
 * clicking it.
 */

const PRESETS: { label: string; n: number; unit: RangeUnit }[] = [
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
    <button
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className={`px-2 py-0.5 rounded-full border font-mono text-[10px] whitespace-nowrap ${
        on ? 'text-ink' : 'text-faint hover:text-muted'
      }`}
      style={{
        borderColor: on ? (color ?? 'var(--color-kdb)') : 'var(--color-line)',
        background: on ? `color-mix(in srgb, ${color ?? 'var(--color-kdb)'} 14%, transparent)` : 'transparent',
      }}
    >
      {children}
    </button>
  );
}

/**
 * The time window, in the shell header rather than the Calls tab: every tab is
 * scoped by it, so a control that lived on one tab would silently govern the
 * other two.
 */
export function RangePicker({
  range,
  onChange,
}: {
  range: DateRange;
  onChange: (r: DateRange) => void;
}) {
  const absolute = range.mode === 'absolute';
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex rounded-md border border-line overflow-hidden">
        {PRESETS.map((p) => {
          const on = range.mode === 'relative' && range.n === p.n && range.unit === p.unit;
          return (
            <button
              key={p.label}
              onClick={() => onChange({ mode: 'relative', n: p.n, unit: p.unit })}
              aria-pressed={on}
              className={`px-2.5 py-1 font-mono text-[11px] ${
                on ? 'bg-panel-2 text-ink' : 'text-muted hover:bg-panel'
              }`}
            >
              {p.label}
            </button>
          );
        })}
        <button
          onClick={() =>
            onChange(
              absolute
                ? { mode: 'relative', n: 7, unit: 'days' }
                : { mode: 'absolute', from: today, to: today },
            )
          }
          aria-pressed={absolute}
          title="Pick exact dates"
          className={`px-2.5 py-1 font-mono text-[11px] border-l border-line ${
            absolute ? 'bg-panel-2 text-ink' : 'text-muted hover:bg-panel'
          }`}
        >
          dates
        </button>
      </div>

      {absolute && range.mode === 'absolute' && (
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
          <input
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => onChange({ ...range, from: e.target.value })}
            className="bg-panel border border-line rounded px-2 py-1"
          />
          <span aria-hidden>→</span>
          <input
            type="date"
            value={range.to}
            min={range.from}
            max={today}
            onChange={(e) => onChange({ ...range, to: e.target.value })}
            className="bg-panel border border-line rounded px-2 py-1"
          />
        </span>
      )}
    </div>
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
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={state.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="Search what was asked…"
          className="flex-1 min-w-56 bg-panel border border-line rounded-md px-3 py-1.5 text-[13px] placeholder:text-faint"
        />

        <span className="font-mono text-[10px] text-faint whitespace-nowrap">
          {rangeLabel(state.range)}
        </span>

        <Chip
          on={state.hideNoise}
          onClick={() => set({ hideNoise: !state.hideNoise })}
          title="Hide /api/projects and any call with no query — traffic rather than intent. On by default."
        >
          hide noise
        </Chip>
        <Chip
          on={state.status === 'error'}
          onClick={() => set({ status: state.status === 'error' ? undefined : 'error' })}
          color="var(--color-report)"
        >
          errors only
        </Chip>
        {(state.client || state.tool || state.q || state.status) && (
          <button
            onClick={() => set({ client: undefined, tool: undefined, status: undefined, q: '' })}
            className="font-mono text-[10px] text-faint underline hover:text-ink"
          >
            clear
          </button>
        )}
      </div>

      {facets && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <FacetRow
            label="client"
            facets={facets.byClient}
            selected={state.client}
            onSelect={(k) => set({ client: k })}
            colorOf={clientColor}
          />
          <FacetRow
            label="tool"
            facets={facets.byTool.slice(0, 10)}
            selected={state.tool}
            onSelect={(k) => set({ tool: k })}
          />
        </div>
      )}
    </div>
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
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-[9px] uppercase tracking-wider text-faint">{label}</span>
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
    </div>
  );
}
