/**
 * The affordance that appears wherever a session is mentioned.
 *
 * Search hits, timeline rows, the entry drawer, session lists — anywhere a
 * `sessionId` is on screen, these three actions are reachable. That is a
 * requirement, not a convenience: a session id you can see but cannot act on
 * is a dead end, and the whole point of insights and related-sessions is that
 * you reach them from wherever you noticed the session.
 *
 * Rendered as real buttons inside rows that are themselves clickable, so every
 * one stops propagation — otherwise "Insights" would also trigger the row's own
 * open action and you would land somewhere you did not ask for.
 */
export type SessionTab = 'conversation' | 'insights' | 'related';

export function SessionRefActions({
  sessionId,
  onOpen,
  compact = false,
}: {
  sessionId: string;
  onOpen: (id: string, tab: SessionTab) => void;
  /** Icon-width labels for dense rows; full words elsewhere. */
  compact?: boolean;
}) {
  const act = (tab: SessionTab) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpen(sessionId, tab);
  };

  const items: { tab: SessionTab; label: string; short: string; title: string }[] = [
    { tab: 'conversation', label: 'open session', short: 'open', title: 'Replay this conversation' },
    { tab: 'insights', label: 'insights', short: 'insights', title: 'What this session did, decided and left open' },
    { tab: 'related', label: 'related', short: 'related', title: 'What else worked on this, before and after' },
  ];

  return (
    <span className="inline-flex items-center gap-2">
      {items.map((i) => (
        <button
          key={i.tab}
          type="button"
          onClick={act(i.tab)}
          title={i.title}
          className="font-mono text-[10px] text-muted hover:text-ink underline underline-offset-2 decoration-dotted"
        >
          {compact ? i.short : i.label}
        </button>
      ))}
    </span>
  );
}
