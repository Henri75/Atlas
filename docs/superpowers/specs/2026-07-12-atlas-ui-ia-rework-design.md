# Atlas UI — information architecture rework

Created: 2026-07-12 23:40 UTC

## Revision History

- **2026-07-12 23:40 UTC** — Initial design. Scope bar, multi-project selection,
  search/ask mode control, sidebar IA.

## Context

Five complaints, one root cause.

> 1. A selected project isn't visible enough in the left pane.
> 2. Allow selecting multiple projects, with all features still working.
> 3. The `scope: +project` line on the right is too subtle.
> 4. `Search` and `Ask` sitting side by side as twin buttons is confusing.
> 5. The left panel puts features on top and projects underneath — that's confusing.

**Root cause.** The UI mixes two orthogonal axes and gives them the same visual
treatment in the same column:

- **Mode** — *how* you are looking: Search, Ask, Timeline, Components, Sessions.
- **Object** — *what* you are looking at: which project(s).

They are stacked in one rail with no distinction of kind, so the eye cannot tell
them apart, and the ordering reads as arbitrary. The same collision appears in
the query bar: `Search` and `Ask` look like peer actions on one input, but they
produce different *surfaces* — a browsable list versus a threaded conversation —
and the only thing distinguishing them today is a modifier key (`⌘Enter`) the
user has to already know.

Fixing the axis confusion fixes all five complaints at once. Three of them (1, 3,
5) are the same bug seen from different seats.

## Decisions

### 1. Layout: scope becomes a bar, the rail becomes views only

**Placement encodes authority.** A filter that sits *above* its results says "I
govern everything below me." A filter in a side rail says "I am a peer of the
navigation." Since the complaint is literally "I can't tell what's selected," the
fix is not to make the sidebar louder — it is to move scope to where its
authority is structurally obvious.

```
┌────────┬──────────────────────────────────┐
│ VIEWS  │ SCOPE  (deepcast ✕)(atlas ✕) +add│  ← persistent, above the content
│ ◎ Ask  ├──────────────────────────────────┤
│ ▤ Ovr  │ [⌕ Search │ ✦ Ask]                │  ← mode is a state of the input
│ ⋮ Tml  │ ┌──────────────────────────────┐ │
│ ◧ Cmp  │ │ query…                       │ │
│ ✳ Ses  │ └──────────────────────────────┘ │
│        │ ▐ results…                       │
└────────┴──────────────────────────────────┘
```

The chips solve a problem checkboxes cannot: with ~50 projects, a checked box
scrolled out of the rail is **invisible**. A chip in the scope bar is always on
screen regardless of how far the project list scrolls.

**Selected state** reuses the product's existing signature — the source-coloured
spine — as an inset accent bar on the active row. "Selected" then reads
identically in the rail, in the scope bar and on a record. No new visual device is
invented.

### 2. Multi-project selection

Project usage in this codebase has **two shapes**, and only one of them can
honestly go multi:

| Shape | Endpoints | Multi? |
|---|---|---|
| **Filter** — project narrows a result set | `/api/search`, `/api/ask`, `/api/ask/stream`, timeline | **Yes** — "any of these" |
| **Resource** — project identifies the thing being browsed | `/api/projects/:slug/components`, `/sessions` | **No** |

A component named `ui` in project A and `ui` in project B are *different things*.
Merging them under one heading would be a lie. Components and Sessions therefore
stay **single-project browsers**: with 0 or 2+ projects selected they show the
existing `PickProject` chooser instead of pretending.

#### The core change follows a pattern the codebase already proved

`sourceTypes` solved exactly this problem for source filtering, and both search
paths already implement it:

- **Qdrant** (`qdrant.ts:58–64`) — plural wins over singular; `match: {any: [...]}`
  is the multi-value OR.
- **Postgres FTS** (`catalog.ts:482–493`) — `= ANY($n)` for several, `=` for one.

Multi-project is the *same idiom applied to a second field*, on both paths:

```ts
// SearchFilters
project?: string;      // kept for back-compat (CLI, MCP, existing callers)
projects?: string[];   // a subset; wins over `project` when non-empty
```

Qdrant gains `match: {any: projects}`; FTS gains `p.slug = ANY($n)`. This is not a
new architecture — it is a one-line generalisation on each path, mirroring code
that is already under test.

**No datastore change. No reindex.** The `project` payload key and the `slug`
column are untouched.

#### Timeline: a collection route, not a merged path

Timeline is a *filter* shape, but its route is *resource*-shaped
(`/api/projects/:slug/timeline`). Cramming `a,b` into a path segment that means
"one project" would commit the very sin this design is correcting — and it would
**break the CLI (`cli/src/main.ts:149`) and the MCP server (`mcp/src/tools.ts:98`)**,
which both call that route.

So: **keep the per-project route exactly as it is**, and add a collection route
beside it.

```
GET /api/projects/:slug/timeline   (unchanged — CLI + MCP keep working)
GET /api/timeline?projects=a,b     (new — the UI uses this)
```

`Catalog.timeline` accepts **either shape** — `timeline(slug: string | string[],
opts)` — normalising internally to `p.slug = ANY($1)`. It is *widened*, not
changed: every existing caller keeps compiling and behaving identically.

This matters more than it looks. Auditing the tests revealed the back-compat net
is thinner than assumed:

- `test/mcp/tools.test.ts` only asserts `atlas_timeline` appears in the tools
  *list*. It never exercises the route, so it would **not** catch a broken path.
- `test/api/routes.test.ts` stubs `timeline` on a fake catalog, so it covers route
  wiring but **not** the real query or its signature.
- The **CLI's timeline command has no test at all.**

So a signature change would have been guarded by almost nothing. Widening rather
than replacing removes the risk at the source, and the plan **adds** the missing
coverage rather than trusting a tripwire that was not there.

### 3. Search vs Ask: a mode, not a second button

They stop being twin submit buttons. A **segmented control attached to the input**
selects the mode, and the input restyles (amber border in Ask) so the mode is
legible *before* typing. `Enter` submits in both — the `⌘Enter` secret handshake
goes away.

This is honest about what they are: not two actions on one box, but two states of
one instrument producing two different surfaces. The segmented control keeps the
fast toggle (re-ask the same query, or browse the records behind an answer)
that two separate rail destinations would lose.

### 4. Ask scope fallback under multi-select

Ask already widens to all projects when a scoped question matches nothing
(`ask.ts:235`, `scopeFallback`). That rule was written for a single project and
must be generalised, not merely passed a list:

- **Any selected project has hits** → answer from those. **No fallback, no
  warning.** The scope worked; the other projects simply had nothing to say.
- **None of the selected projects match** → widen to all, flag `scopeFallback`
  with the full requested set.

Getting this wrong in the obvious way (fall back unless *every* project matched)
would make the fallback fire on almost every multi-project ask.

`ScopeFallback.requested` becomes `string[]`. It is a UI-facing marker, and both
producers (`/api/ask`, `/api/ask/stream`) and its one consumer (the UI banner) are
changed together.

### 5. UI state: one `useScope()` hook, not 39 edited call sites

`project: string` is threaded through ~39 places in the UI. Widening every one of
them to `string[]` would churn views that do not want multi (Components,
Sessions) and invite mistakes in code this change has no business touching.

Instead a single hook owns the selection and exposes **both shapes**:

```ts
const scope = useScope();          // persisted; the single source of truth
scope.projects   // string[]        → Search, Ask, Timeline (multi-capable)
scope.project    // string | null   → exactly one selected, else null
```

The per-project browsers keep their existing `project` prop contract **unchanged**
— they simply receive `null` when the selection is not exactly one, which is
already the case they handle today via `PickProject`. The refactor collapses from
"39 sites" to "one hook plus three views."

Selection persists in `localStorage` (`atlas.scope.projects`) via the existing
`usePersistentState`, which was generalised to JSON values in the previous batch.

### 6. Result provenance

Once a result set can span projects, every row must say where it came from. Search
hits, timeline items and Ask sources gain a project tag — shown **only when the
scope spans more than one project**, so a single-project view gains no noise.

## Consequences

**Positive.** Selection is unmissable and always on screen. Multi-project search
and ask — the actual reason someone indexes 50 projects — becomes possible.
Search/Ask stops being a guessing game. The rail has one job.

**Negative.** The scope bar costs ~44px of vertical height on every view. Two
views (Components, Sessions) deliberately do not honour a multi-selection, which
must be *shown*, not silently ignored.

**Blast radius.**

| Area | Risk | Verification |
|---|---|---|
| `qdrant.ts` filter | Low — mirrors the proven `sourceTypes` idiom | existing filter tests + new multi-project test |
| `catalog.ts` FTS | Low — same idiom, `= ANY($n)` | existing FTS tests + new test |
| `catalog.ts` timeline | Low — signature *widened*, not changed; old calls keep compiling | **new** test asserting `timeline('slug')` still behaves as before |
| **CLI + MCP** | **Low — the old route is untouched** | ⚠ existing coverage is weak (MCP only lists the tool; CLI has none). The plan **adds** a test that the per-project route and its emitted URL still work — do not treat the current tests as a guard |
| `ask.ts` fallback | **Medium** — semantics change | new tests: partial match, total miss, single project |
| Components / Sessions | None — unchanged contract | existing tests pass untouched |
| Datastores | **None** | no reindex |

## Alternatives Considered

**Scope rail with checkboxes (rejected).** Smallest change; keeps muscle memory.
Rejected because scope would still sit in a column *beside* the results rather
than above them — it governs the content without looking like it — and because a
checked box scrolled out of a 50-item rail is invisible, which is the original
complaint. It also forced nav to icon-only, losing labels.

**Command-first / ⌘K bar (rejected).** Maximum content area, very current.
Rejected because it hides a 50-project list behind a keystroke when browsing that
list is routine, and because it overloads one control with three jobs — the same
sin the current UI commits, only prettier.

**Search and Ask as separate rail destinations (rejected).** Most explicit about
them being different surfaces. Rejected because it loses the cheap toggle between
"answer me" and "show me the records" on the same query, which is the common
motion.

**Multi-project everywhere, union in Components/Sessions (rejected).** More
uniform, but turns two per-project browsers into grouped-list features — a
materially bigger change — and component *history* still needs a single
(project, name) pair, so the drill-down would remain single-project anyway.

**Replacing `/api/projects/:slug/timeline` with a multi-slug path (rejected).**
Would break the CLI and MCP server, and would put a filter into a resource path.

## Testing

| Area | Test |
|---|---|
| Qdrant filter | one project → `match.value`; several → `match.any`; `projects` wins over `project` |
| FTS filter | one → `p.slug = $n`; several → `p.slug = ANY($n)` |
| Timeline | merges N projects, newest first; each item carries its project |
| **Back-compat (new)** | `Catalog.timeline('slug')` — the single-string form — still returns that project's items; `/api/projects/:slug/timeline` still serves them. These tests **do not exist today** and are part of this change, not a pre-existing guard |
| Ask fallback | partial match → answer, **no** fallback; total miss → widen + `scopeFallback` listing all requested; single project → today's behaviour unchanged |
| `useScope` | `project` is null at 0 and at 2+ selected; non-null at exactly 1; persists across reload |
| Components/Sessions | show `PickProject` when the selection is not exactly one |
| Scope bar | chips add/remove; removing the last chip means "all projects" |
| Mode control | Enter submits in both modes; switching mode restyles the input |
| Provenance | project tag appears only when scope spans > 1 project |

## References

- Component log: `kdb/components/atlas.log`
- Previous spec: `docs/superpowers/specs/2026-07-12-atlas-ui-improvements-design.md`
- Mockups (3 layouts, real theme): published artifact, 2026-07-12
- No ADR: no cross-component architectural change. The filter widening follows an
  established in-repo pattern (§3.3 "Modify & Reuse") and adds no dependency.
