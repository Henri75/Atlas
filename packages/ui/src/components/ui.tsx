import type { ReactNode } from 'react';
import { SOURCE_META, type SourceType } from '../types';

/** Small shared pieces: source badge, spine row, date stamp, empty state. */

export function Badge({ source }: { source: SourceType }) {
  const m = SOURCE_META[source] ?? { label: source, color: 'var(--color-muted)' };
  return (
    <span
      className="font-mono text-[10px] tracking-widest px-1.5 py-0.5 rounded-sm"
      style={{ color: m.color, background: `color-mix(in srgb, ${m.color} 12%, transparent)` }}
    >
      {m.label}
    </span>
  );
}

/** The signature element: every record carries a spine in its source color. */
export function SpineRow({
  source,
  children,
  onClick,
}: {
  source: SourceType;
  children: ReactNode;
  onClick?: () => void;
}) {
  const color = SOURCE_META[source]?.color ?? 'var(--color-muted)';
  return (
    <div
      className={`rise border-l-[3px] bg-panel hover:bg-panel-2 transition-colors px-3 py-2.5 rounded-r-md ${onClick ? 'cursor-pointer' : ''}`}
      style={{ borderLeftColor: color }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick() : undefined}
    >
      {children}
    </div>
  );
}

export function Stamp({ iso }: { iso?: string }) {
  if (!iso) return null;
  return (
    <time className="font-mono text-[11px] text-faint whitespace-nowrap">
      {iso.slice(0, 16).replace('T', ' ')}
    </time>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="font-display uppercase tracking-[0.18em] text-[11px] text-muted mb-2">
      {children}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="text-center py-16">
      <p className="text-muted">{title}</p>
      {hint && <p className="text-faint text-sm mt-1">{hint}</p>}
    </div>
  );
}

export function Spinner() {
  return <div className="text-faint font-mono text-sm py-8 text-center">querying…</div>;
}
