import {
  ENTRY_KIND_META as KIND,
  MATCH_REASON_COLOR,
  substanceLabel,
  type SessionCard,
} from '@atlas/shared';
import { Highlight, MachineBadge, ProjectTag, Stamp } from '../../components/ui';
import { SessionRefActions, type SessionTab } from '../../components/SessionRefActions';
import { compact, duration, plural } from '../../format';

/**
 * A meter for how much work a session represents.
 *
 * The corpus median is three messages and 96 seconds, so the single most
 * useful thing a result row can say is "this was real work" or "this was
 * ninety seconds". A number would not be read; a short bar is.
 */
function SubstanceMeter({ value }: { value: number }) {
  const pct = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={`${substanceLabel(value)} — ${pct}% of the weight scale`}
    >
      <span className="relative block h-1 w-10 rounded-full bg-line overflow-hidden" aria-hidden>
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct}%`, background: 'var(--color-kdb)' }}
        />
      </span>
      <span className="sr-only">{substanceLabel(value)}</span>
    </span>
  );
}

/**
 * Why this session is in the results, as chips.
 *
 * This is the part that lets a reader pick the right session without spending
 * an LLM call on it — and the part that makes a wrong ranking arguable instead
 * of mysterious. Never hidden behind a disclosure.
 */
function WhyChips({ why }: { why: SessionCard['why'] }) {
  if (!why.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {why.slice(0, 4).map((w, i) => {
        const color = MATCH_REASON_COLOR[w.kind] ?? 'var(--color-muted)';
        return (
          <span
            key={`${w.kind}-${i}`}
            className="font-mono text-[10px] px-1.5 py-0.5 rounded-sm border"
            style={{
              color,
              borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
              background: `color-mix(in srgb, ${color} 10%, transparent)`,
            }}
          >
            {w.detail}
          </span>
        );
      })}
    </div>
  );
}

export function SessionCardRow({
  card,
  needle = '',
  showProject = true,
  showMachine = false,
  onOpen,
}: {
  card: SessionCard;
  needle?: string;
  showProject?: boolean;
  showMachine?: boolean;
  onOpen: (id: string, tab: SessionTab) => void;
}) {
  const took = card.durationMs != null ? duration(card.durationMs / 1000) : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(card.sessionId, 'conversation')}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(card.sessionId, 'conversation')}
      className="rise border-l-[3px] bg-panel hover:bg-panel-2 transition-colors px-3 py-2.5 rounded-r-md cursor-pointer"
      style={{ borderLeftColor: 'var(--color-claude)' }}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-mono text-[11px] text-faint">{card.sessionId.slice(0, 8)}</span>
        {showProject && <ProjectTag slug={card.projectSlug} />}
        {showMachine && <MachineBadge machine={card.machine} />}
        {card.thread && (
          <span
            className="font-mono text-[10px] px-1.5 py-0.5 rounded-sm"
            title={`Part of a run of ${card.thread.size} sessions on the same work`}
            style={{
              color: 'var(--color-report)',
              background: 'color-mix(in srgb, var(--color-report) 12%, transparent)',
            }}
          >
            +{card.thread.size - 1} in thread
          </span>
        )}
        <div className="flex-1 min-w-0" />
        <SubstanceMeter value={card.substance} />
        <Stamp iso={card.startedAt} />
      </div>

      <div className="mt-1 font-medium text-[14px] leading-snug">
        <Highlight text={card.title} needle={needle} />
      </div>

      {/* An LLM headline is an optional garnish on evidence that stands alone,
          and it is marked so a reader always knows which is which. */}
      {card.ai?.headline && (
        <p className="mt-1 text-[13px]" style={{ color: 'var(--color-claude)' }}>
          <span className="font-mono text-[9px] tracking-widest mr-1.5 opacity-70">AI</span>
          {card.ai.headline}
        </p>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-faint">
        <span>{plural(card.entryCount, 'message')}</span>
        <span>· {compact(card.actionCount)} actions</span>
        {card.fileCount > 0 && <span>· {plural(card.fileCount, 'file')}</span>}
        {/* "span", not a bare duration: a resumed session's start and end can
            be days apart, and `232h 52m` on its own reads as time worked. */}
        {took && <span title="Wall-clock time from first to last message">· {took} span</span>}
        {card.cwd && <span className="truncate max-w-[18rem]">· {card.cwd}</span>}
      </div>

      <WhyChips why={card.why} />

      {card.excerpts.length > 0 && (
        <div className="mt-2 space-y-1">
          {card.excerpts.slice(0, 2).map((e) => (
            <div
              key={e.entryId}
              className="border-l-2 pl-2 text-[12px] text-muted line-clamp-2"
              style={{ borderLeftColor: KIND[e.kind].color }}
            >
              <span
                className="font-mono text-[9px] tracking-widest mr-1.5"
                style={{ color: KIND[e.kind].color }}
              >
                {KIND[e.kind].label}
              </span>
              <Highlight text={e.text} needle={needle} />
            </div>
          ))}
        </div>
      )}

      <div className="mt-2">
        <SessionRefActions sessionId={card.sessionId} onOpen={onOpen} />
      </div>
    </div>
  );
}
