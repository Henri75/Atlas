/**
 * Number formatting for a dense, scannable UI.
 *
 * Compact forms (81.6k) make a column scannable and stop it jittering row to
 * row; they also destroy precision, so every caller pairs them with
 * `exact()` in a `title` attribute. Both, not either.
 */

/** 81633 → "81.6k". Below 1000 the exact number already reads fine. */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  const units = [
    { at: 1e12, suffix: 'T' },
    { at: 1e9, suffix: 'B' },
    { at: 1e6, suffix: 'M' },
    { at: 1e3, suffix: 'k' },
  ];
  for (const { at, suffix } of units) {
    if (abs < at) continue;
    const v = n / at;
    // 1.2k but 12k — a decimal is noise once the integer part carries the size.
    return `${Math.abs(v) < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}${suffix}`;
  }
  return String(n);
}

/** Thousands-separated, for tooltips and anywhere precision matters. */
export function exact(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : '—';
}

/**
 * Binary units, because this measures disk and memory. 2515421157 → "2.34 GB".
 * Named GB/MB rather than GiB/MiB to match what `du -h` and Docker report.
 */
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

/** Seconds → "3m 20s" / "1h 05m". For ETAs and durations. */
export function duration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Milliseconds → "12ms" / "2.2s" / "1m 36s". For latencies, which span four
 * orders of magnitude here: an entry read is ~19ms and an ask can pass 95s.
 *
 * Separate from `duration()` (which takes seconds) rather than a unit flag,
 * because the sub-second range is the whole point — "0s" for a 19ms read would
 * be the same lie as rounding a disk size to zero.
 */
export function millis(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  return duration(s);
}

/** "2026-07-09T23:20:04Z" → "3 minutes ago". Empty for a missing stamp. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'never';
  const secs = Math.round((now - then) / 1000);
  if (secs < 0) return 'just now';
  if (secs < 45) return 'just now';
  if (secs < 90) return 'a minute ago';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Pluralise without the "1 prompts" bug. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${exact(n)} ${n === 1 ? one : many}`;
}
