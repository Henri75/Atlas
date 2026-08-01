import { useEffect, useRef, type RefObject } from 'react';

/**
 * Close a popover when the user goes somewhere else: a click outside it, or
 * Escape. A popover left open on scroll or navigation is noise.
 *
 * `mousedown` rather than `click`, deliberately — by the time a `click`
 * completes the element under the pointer may already have moved or re-rendered,
 * and the popover visibly lingers for the length of the press.
 *
 * Escape is consumed here (`stopPropagation`) so it closes exactly one thing.
 * App keeps a window-level Escape handler that backs out of an open session;
 * document listeners run before window ones on the way up, so an open popover
 * takes the key first and the view underneath stays put.
 */
export function useClickAway(
  ref: RefObject<HTMLElement | null>,
  close: () => void,
  active: boolean,
) {
  // Held in a ref so an inline `() => setOpen(false)` does not re-subscribe both
  // listeners on every render of the host component.
  const latest = useRef(close);
  latest.current = close;

  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) latest.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      latest.current();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, active]);
}
