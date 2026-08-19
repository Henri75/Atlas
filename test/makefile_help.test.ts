import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard for CLAUDE.md §3's "commands document themselves, and `help` is
 * GENERATED" rule: a runnable Make target that lacks a `## description` can
 * silently vanish from `make help` (the target itself just does not print),
 * with no error anywhere. `help:` already generates its listing by parsing
 * `## ` comments rather than a hand-maintained `@echo` block, so a described
 * target cannot drift out of sync — but nothing previously *forced* every
 * target to carry one. This test is that force; `make help-audit` runs it
 * standalone (§3, controller ruling, Task 27).
 *
 * A target that is deliberately not user-facing (an accessor other scripts
 * use, e.g. `print-compose`) is declared via `## @internal` rather than
 * omitted — `help:`'s grep filters `@internal` lines back out, so it still
 * never appears in `make help`, but the guard here treats it as documented.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAKEFILE_PATH = join(ROOT, 'Makefile');

// A target-defining line: one or more space-separated names at column 0
// (recipe lines are tab-indented and never match `^`), followed by `:` NOT
// `:=` (the latter is a variable assignment, e.g. `DOTENV := ...`). Special
// targets (`.PHONY`, `.DEFAULT`, …) start with `.` and are filtered out
// below — they configure make itself, not a runnable entry point that
// belongs in `help`.
const TARGET_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*(?:[ \t]+[A-Za-z0-9_][A-Za-z0-9_.-]*)*)[ \t]*:(?!=)(.*)$/;

export interface ParsedTarget {
  name: string;
  /** 1-based line number in the Makefile, for error messages. */
  line: number;
  hasDescription: boolean;
  internal: boolean;
}

/** Exported so the mutation-verification evidence can call it directly too. */
export function parseMakeTargets(makefileText: string): ParsedTarget[] {
  const targets: ParsedTarget[] = [];
  makefileText.split('\n').forEach((raw, idx) => {
    const m = TARGET_LINE.exec(raw);
    if (!m) return;
    const rest = m[2];
    const internal = /##\s*@internal\b/.test(rest);
    const hasDescription = !internal && /##\s*\S/.test(rest);
    for (const name of m[1].trim().split(/\s+/)) {
      if (name.startsWith('.')) continue; // .PHONY, .DEFAULT, … — not a real target
      targets.push({ name, line: idx + 1, hasDescription, internal });
    }
  });
  return targets;
}

describe('make help-audit', () => {
  const text = readFileSync(MAKEFILE_PATH, 'utf8');
  const targets = parseMakeTargets(text);

  it('parses the Makefile and finds real targets (parser sanity check)', () => {
    // If this fails, the regex stopped matching this Makefile's actual
    // syntax and the audit below would be vacuously green.
    const names = targets.map((t) => t.name);
    expect(names).toContain('help');
    expect(names).toContain('restart-build');
    expect(names.length).toBeGreaterThan(10);
  });

  it('every Make target has a `## description` or is marked `## @internal`', () => {
    const undocumented = targets.filter((t) => !t.hasDescription && !t.internal);
    expect(
      undocumented,
      `undocumented targets (add "## <description>" or "## @internal"): ` +
        undocumented.map((t) => `${t.name} (Makefile:${t.line})`).join(', '),
    ).toEqual([]);
  });
});
