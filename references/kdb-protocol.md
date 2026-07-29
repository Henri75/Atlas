Revision history:
- 2026-07-29 18:05 UTC — backlog & index.log formats defined; structured resolution markers (RESOLVED/DROPPED/REOPENED with line refs); canonical-copy note; tightened integrity section.
- 2026-07-26 11:55 UTC — moved out of ~/.claude/CLAUDE.md for on-demand loading; the mandate and workflow summary remain there.

# KDB Protocol — Entry Formats & Write Safety

**This file (`~/.claude/references/kdb-protocol.md`) is the single canonical copy.** Projects reference it; never copy it into a repo — copies drift.

Authoritative append-only logs (the only writable files): `/kdb/index.log`, `/kdb/components/<component>.log`, `/kdb/backlog.log`, `/kdb/changelog.log`, `/kdb/session.log`. The matching `*.md` files are generated views — never edited by hand, only rebuilt from logs.

## Index Log

One line per registered component:

```
- [YYYY-MM-DD] <component> — <one-line role>. Log: kdb/components/<component>.log
```

## Backlog

One **physical line** per item (no multi-line entries — tools parse per line):

```
- [YYYY-MM-DD] [component] <description>
```

`[component]` optional. Never rewrite or delete items — resolve them by appending a marker line:

```
- [YYYY-MM-DD] RESOLVED [L<n>#<hash6>]: <summary restating the item> (evidence: <commit/log ref>)
- [YYYY-MM-DD] DROPPED [L<n>#<hash6>]: <reason no longer relevant>
- [YYYY-MM-DD] REOPENED [L<n>#<hash6>]: <regression/reason>
```

- `L<n>` = absolute line number of the original item (stable — the file is append-only). Find it with `atlas backlog <project>` (preferred; it also emits ready-to-append marker lines) or `grep -n` the file.
- `#<hash6>` = first 6 hex chars of SHA-256 of the original line (trailing whitespace stripped). Optional when hand-writing; always included in Atlas-proposed lines. It lets tools detect a mis-numbered ref instead of trusting it.
- If the same item accrues several markers, the **last one in file order wins**.

## Component Log Entry

On completing work on a component, append to `/kdb/components/<component>.log`:

```
---
### [YYYY-MM-DD] - [Task/Bug ID/Brief Description]

**Objective:**
- <One-sentence goal.>

**Summary of Work:**
- <High-level overview of changes and approach.>

**Key Decisions & Rationale:**
- <Why certain choices were made.>

**Code/Files Modified:**
- path/to/file_1

**Outcomes & Lessons Learned:**
- **What Worked:** <Final solution.>
- **What Failed:** <Attempts that did not work and WHY.>

**Status:**
- Completed | In-Progress | Abandoned
```

## Global Changelog

`/kdb/changelog.log`, one line per entry, exact format:

```
- [STATUS] - [YYYY-MM-DD HH:MM UTC] - [Task Type] - [Component/Service] - [Brief Description]
```

STATUS: `IN-PROGRESS` | `COMPLETED` | `ABANDONED` | `BLOCKED`. Task Type: `Feature`, `Bugfix`, `Refactor`, `Chore`, `Docs`, etc.

## Session Log

Append this exact block to `/kdb/session.log` (delimited by a lone `---` line), just before responding with the final summary:

```
---
### [YYYY-MM-DD HH:MM UTC]

**User Prompt Summary:**
> <One or two sentences.>

**AI Response Summary:**
> <One or two sentences describing work done.>
```

## Write-Safety Protocol

1. **Append-only:** overwrite modes (`w`, `>`), truncation, and read-modify-rewrite are prohibited on `*.log`.
2. **Exclusive lock** (e.g., `flock` on a sidecar `*.lock`) before appending.
3. **Durability check:** after append, re-read the tail and verify the entry is present intact.
4. **No-loss guard:** if pre-write size > 0 and post-write size < pre-write size — ABORT, restore last good version, alert.
5. **Rotation** at 5 MB: rename to `*.log.YYYYMMDDTHHMMSS`, create fresh `*.log`, always under lock; log rotation in the changelog.
6. `*.md` views are never hand-edited — rebuilt only (e.g. `make kdb-rebuild`); rebuilding must never mutate `*.log`.
7. **Blessed helpers only** (e.g., `bin/kdb_append.sh`, `make kdb-append FILE=... LINE=...`, `kdb/utils/append.*`); direct file I/O to KDB is forbidden.

## Integrity Safeguards (recommended per repo)

Pre-commit guard blocking commits that shrink any `*.log`; CI failing on `*.md` changes without a matching `*.log` delta; periodic KDB snapshots or repo backups.
