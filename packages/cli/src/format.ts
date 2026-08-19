/** Tiny ANSI helpers — no dependency, honors NO_COLOR. */

const on = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = wrap(1);
export const dim = wrap(2);
export const cyan = wrap(36);
export const green = wrap(32);
export const yellow = wrap(33);
export const red = wrap(31);
export const magenta = wrap(35);

export const SOURCE_BADGE: Record<string, string> = {
  kdb_changelog: 'CHANGELOG',
  kdb_session: 'KDB-SESSION',
  kdb_component: 'COMPONENT',
  kdb_backlog: 'BACKLOG',
  kdb_report: 'REPORT',
  claude_session: 'CLAUDE',
  git_commit: 'COMMIT',
  doc: 'DOC',
};

export function date(iso?: string): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '';
}

/**
 * Thousands-separated, not compact. A terminal line has room, and precision is
 * worth more here than the two characters a "142k" would save.
 */
export function num(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '—';
}

/** Binary units, matching `du -h`. A null size is unknown, never zero. */
export function bytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Seconds → "3m 20s" / "1h 05m". */
export function duration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function hr(): string {
  return dim('─'.repeat(Math.min(process.stdout.columns ?? 80, 100)));
}

/** machine_sync.status values → color. Anything else (or absent) reads as 'never'. */
const SYNC_STATUS_COLOR: Record<string, (s: string) => string> = {
  ok: green,
  running: cyan,
  unreachable: yellow,
  error: red,
};

/** Colored sync-status badge for `atlas machines`; unknown/absent renders dim 'never'. */
export function syncBadge(status?: string | null): string {
  const s = status ?? 'never';
  return (SYNC_STATUS_COLOR[s] ?? dim)(s);
}
