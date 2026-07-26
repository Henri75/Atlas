/**
 * Pull an explicit date or range out of a natural-language question.
 *
 * Used only to attach a *measured* entry count to an Ask answer — never to
 * filter retrieval. That asymmetry drives every judgement call here: a missed
 * date costs nothing (the answer is exactly what it is today), while an invented
 * one puts a confident, irrelevant number in front of the model. So this is
 * deliberately conservative and matches only unambiguous date forms, rejecting
 * anything that merely looks numeric — version strings, entry ids, clock times.
 */

export interface DateWindow {
  /** Inclusive start, ISO. */
  since: string;
  /** Inclusive end, ISO (end of day). */
  until: string;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** `jan`…`dec` and the full names, mapped to a 0-based month index. */
const MONTH_INDEX = new Map<string, number>();
for (const [i, name] of MONTHS.entries()) {
  MONTH_INDEX.set(name, i);
  MONTH_INDEX.set(name.slice(0, 3), i);
}

const MONTH_ALT = [...MONTH_INDEX.keys()].sort((a, b) => b.length - a.length).join('|');

/** ISO `YYYY-MM-DD`, not preceded/followed by other digits or a dash. */
const ISO_RE = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g;
/** `21 July 2026` / `21 Jul 2026`, with an optional ordinal suffix. */
const DMY_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALT})\\b[,\\s]+(\\d{4})\\b`, 'gi');
/** `July 21, 2026` / `Jul 21 2026`. */
const MDY_RE = new RegExp(`\\b(${MONTH_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b[,\\s]+(\\d{4})\\b`, 'gi');
/** `July 2026` — a bare month, meaning the whole month. */
const MY_RE = new RegExp(`\\b(${MONTH_ALT})\\s+(\\d{4})\\b`, 'gi');

/**
 * Build a UTC day only if the calendar actually has it.
 *
 * `new Date(2026, 12, 1)` silently becomes January 2027 and `2026-02-30` becomes
 * March 2nd. Rolling over would turn a typo into a confident answer about the
 * wrong month, so round-trip the components and reject any mismatch.
 */
function utcDay(year: number, month0: number, day: number): Date | null {
  if (month0 < 0 || month0 > 11 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month0, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month0 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

/** Last day of a month, via the day-0-of-next-month trick. */
function endOfMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function startOf(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function endOf(d: Date): string {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999),
  ).toISOString();
}

export function extractDateWindow(question: string): DateWindow | null {
  const starts: Date[] = [];
  const ends: Date[] = [];

  const add = (start: Date | null, end?: Date | null) => {
    if (!start) return;
    starts.push(start);
    ends.push(end ?? start);
  };

  for (const m of question.matchAll(ISO_RE)) {
    add(utcDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  for (const m of question.matchAll(DMY_RE)) {
    add(utcDay(Number(m[3]), MONTH_INDEX.get(m[2]!.toLowerCase())!, Number(m[1])));
  }
  for (const m of question.matchAll(MDY_RE)) {
    add(utcDay(Number(m[3]), MONTH_INDEX.get(m[1]!.toLowerCase())!, Number(m[2])));
  }

  // Only fall back to a whole month when no specific day was found: "21 July
  // 2026" also matches the bare-month pattern, and widening it to all of July
  // would silently answer a different question than the one asked.
  if (!starts.length) {
    for (const m of question.matchAll(MY_RE)) {
      const month0 = MONTH_INDEX.get(m[1]!.toLowerCase())!;
      const year = Number(m[2]);
      const first = utcDay(year, month0, 1);
      add(first, utcDay(year, month0, endOfMonth(year, month0)));
    }
  }

  if (!starts.length) return null;
  const since = new Date(Math.min(...starts.map((d) => d.getTime())));
  const until = new Date(Math.max(...ends.map((d) => d.getTime())));
  return { since: startOf(since), until: endOf(until) };
}

/**
 * Widen a window by `days` on each side.
 *
 * People record events after they happen: a 2026-07-21 incident is typically
 * written up on the 22nd or later. Counting only the named day would report a
 * truthful "0 entries" that reads as "nothing happened" — the exact dead end
 * this work exists to remove.
 */
export function paddedWindow(w: DateWindow, days: number): DateWindow {
  const since = new Date(w.since);
  const until = new Date(w.until);
  since.setUTCDate(since.getUTCDate() - days);
  until.setUTCDate(until.getUTCDate() + days);
  return { since: startOf(since), until: endOf(until) };
}
