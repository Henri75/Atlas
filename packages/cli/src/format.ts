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

export function hr(): string {
  return dim('─'.repeat(Math.min(process.stdout.columns ?? 80, 100)));
}
