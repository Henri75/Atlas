/**
 * Global in-flight request counter.
 *
 * "Data is loading" must always have a visual answer on a phone, where a hung
 * request and a slow one look identical otherwise. Every API call begins/ends
 * here; the shell's TopProgressBar subscribes and sweeps while count > 0.
 *
 * Deliberately a plain emitter rather than React state: it is written from
 * non-React transport code (fetch/SSE) dozens of times a second at most, and
 * no view should re-render per call — only the bar's own listener.
 */

type Listener = (active: boolean) => void;

let depth = 0;
const listeners = new Set<Listener>();

function emit() {
  const active = depth > 0;
  for (const l of listeners) l(active);
}

export const loadingBus = {
  begin() {
    depth += 1;
    if (depth === 1) emit();
  },
  end() {
    depth = Math.max(0, depth - 1);
    if (depth === 0) emit();
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    l(depth > 0);
    return () => listeners.delete(l);
  },
  get active() {
    return depth > 0;
  },
};
