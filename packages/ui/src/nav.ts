/**
 * The view axis, in one place.
 *
 * This list used to live inside the Sidebar, which was fine while the rail was
 * its only consumer. It no longer is: the settings menu offers the same six
 * views as start-up choices, and App validates a persisted preference against
 * them. A second hardcoded copy would drift the moment a view is added, so the
 * rail, the menu and the validator all read this one.
 */
export type View = 'dashboard' | 'search' | 'timeline' | 'components' | 'sessions' | 'monitor';

/**
 * The glyphs are deliberately geometric rather than pictorial: this is an
 * instrument, and a cute magnifying-glass icon would be the one templated note
 * in an otherwise typographic interface.
 *
 * Order is the rail's order, and the hotkeys follow it.
 */
export const VIEWS: { key: View; label: string; hotkey: string; icon: string }[] = [
  { key: 'search', label: 'Search & Ask', hotkey: '1', icon: '◎' },
  { key: 'dashboard', label: 'Overview', hotkey: '2', icon: '▤' },
  { key: 'timeline', label: 'Timeline', hotkey: '3', icon: '⋮' },
  { key: 'components', label: 'Components', hotkey: '4', icon: '◧' },
  { key: 'sessions', label: 'Sessions', hotkey: '5', icon: '✳' },
  // Last in the rail because it is about Atlas rather than about your projects —
  // the only view whose subject is the tool itself.
  { key: 'monitor', label: 'Monitor', hotkey: '6', icon: '◔' },
];

/**
 * Guard for anything that reaches us from outside the type system — in practice
 * the persisted start-view preference. App renders views as six independent
 * `view === '…'` checks with no fallback arm, so an unrecognised value would
 * render a blank page rather than an error. Coerce instead.
 */
export function isView(v: unknown): v is View {
  return typeof v === 'string' && VIEWS.some((x) => x.key === v);
}
