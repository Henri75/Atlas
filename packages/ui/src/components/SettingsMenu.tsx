import { useRef, useState } from 'react';
import { VIEWS, type View } from '../nav';
import { useClickAway } from '../useClickAway';

/**
 * Preferences, in the rail's footer rather than as a seventh view: settings are
 * not a way of looking at your projects, and putting them in the nav would say
 * they are.
 *
 * There is exactly one preference so far — which view Atlas opens on — and the
 * menu is shaped for that: a radio group that writes on click, with no Save
 * button to leave in an ambiguous state. It opens *upward* because it is pinned
 * to the bottom of a full-height rail.
 */
export function SettingsMenu({
  startView,
  onStartView,
}: {
  startView: View;
  onStartView: (v: View) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickAway(ref, () => setOpen(false), open);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Settings"
        aria-expanded={open}
        className={`w-full py-1 rounded border border-line hover:border-faint hover:text-ink ${
          open ? 'text-ink' : 'text-muted'
        }`}
      >
        ⚙ Settings
      </button>

      {open && (
        <div
          className="absolute z-20 bottom-full mb-1 left-0 w-[13rem] bg-panel border border-line rounded-md p-1 shadow-lg"
          role="radiogroup"
          aria-label="Open Atlas on"
        >
          <p className="px-2 pt-1 pb-1.5 text-faint">Open Atlas on</p>
          {VIEWS.map((v) => {
            const on = startView === v.key;
            return (
              <button
                key={v.key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  onStartView(v.key);
                  setOpen(false);
                }}
                className={`w-full text-left px-2 py-1.5 rounded hover:bg-panel-2 ${
                  on ? 'text-ink' : 'text-muted'
                }`}
              >
                {on ? '● ' : '○ '}
                {v.label}
              </button>
            );
          })}
          <p className="px-2 pt-1.5 pb-1 text-faint leading-relaxed">
            Applies on the next load — this one stays where you are.
          </p>
        </div>
      )}
    </div>
  );
}
