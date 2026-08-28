# Session Intelligence — design

> 2026-08-28 19:30 UTC — initial version.

Revision history:

- 2026-08-28 19:30 UTC — created.

Three features over Claude Code session transcripts, on all four Atlas
surfaces (web/PWA, native app, MCP, CLI):

1. **Session search** — type anything, get the session.
2. **Session insights** — a customisable report of what a session did,
   decided, and left unfinished.
3. **Related sessions** — what else worked on this, before and after,
   on a visual timeline.

## 1. Why the corpus shapes the design

Measured on the live index, 2026-08-28 (79 projects, 491,950 entries):

| Fact | Value | Consequence for this design |
|---|---|---|
| Sessions | 8,395 | Session-level ranking is required; a flat list cannot serve this |
| **Median entries per session** | **3** (p90 151, max 1,304) | The corpus is dominated by throwaway sessions. Ranking MUST weight substance or every query drowns |
| Median duration | 1.6 min | same |
| Sessions with >= 20 entries | 2,205 (26%) | the real "work" corpus |
| Sessions with any `files_touched` | 2,322 (28%), avg 3.3, max 265 | file overlap is strong but **sparse** — it cannot be the only relatedness signal |
| Distinct files across sessions | 15,210 | an inverted index over files is tiny and affordable |
| Distinct `cwd` | **71** for 8,395 sessions | `cwd` is a project-level fact, useless as session identity — do not use it for continuation detection |
| Sessions with a `title` | 7,550 (90%) | good labels already exist; the metadata leg is worth a lot |
| Sessions with no entries at all | 366 | insights and search must not assume entries exist |
| Message kinds | response 174,834 · action 163,960 · prompt 15,973 · **insight 6,942 · summary 1,579 · plan 554** | insight/summary/plan are already classified at parse time: high-signal input for free, no LLM needed |
| Top `files_touched` | `/Users/nasta/__CODING NEW/DeepCast/Makefile` (131), `…/MEMORY.md` (183) | **paths come from a previous machine and user.** Un-normalised overlap across eras scores ZERO. Also: high-frequency stop-files exist and must be IDF-damped |

Two facts drive most of what follows: **substance must be a ranking prior**,
and **file paths must be normalised to repo-relative before they are compared**.

## 2. Scope

In scope: three new core services, three new API routes, one new derived
table, shared view-models and timeline layout, web UI, mobile UI, CLI
command group, three MCP tools, docs and ADR.

Out of scope: re-parsing transcripts (nothing here needs a reindex), changing
`EXTRACTION_SCHEME`, any write to an indexed project.

## 3. Architecture

```
packages/core/src/
  sessionFiles.ts      path normalisation + the session_files inverted index
  sessionSearch.ts     query  -> ranked SessionCard[] with why + excerpts
  sessionRelated.ts    anchor -> scored neighbours (before/after) + context events
  sessionInsights.ts   deterministic facts + LLM narrative + cache + single-flight
packages/shared/src/
  sessionView.ts       card/section view-models, section registry, why-formatting
  sessionTimeline.ts   PURE layout math -> nodes/edges/ticks (web + mobile render it)
```

API (all under the existing `/api/*` auth + usage middleware):

```
GET /api/sessions/search?q&projects&machine&since&until&thread&llm&limit
GET /api/sessions/:id/insights?sections&llm&refresh
GET /api/sessions/:id/related?limit&direction&crossProject&context
```

MCP stays a thin REST proxy (existing invariant): all logic is server-side.

### 3.1 Route ordering — a trap, pinned by tests

`/api/sessions/search` has the same segment count as `/api/sessions/:id`.
It MUST be registered before it in `app.ts`, and its pattern MUST precede
`/api/sessions/:id` in `usage.ts`'s ordered `PATTERNS`. Otherwise session
search is served as (and logged as) a session read. Both orderings are pinned
by tests.

`routeClass` additions — without them the new routes fall into `other`, which
that module documents as the signal a route was added unclassified:

| Path | Class |
|---|---|
| `/api/sessions/search` | `query` |
| `/api/sessions/:id/insights` | `query` |
| `/api/sessions/:id/related` | `query` |

`resyncRouteClasses()` already recomputes the whole column from `path`, so no
backfill is needed.

## 4. Data model

One new table. Derived, rebuildable, cascade-deleted — no durable truth lives
here:

```sql
CREATE TABLE IF NOT EXISTS session_files (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,   -- repo-relative, normalised (see 4.1)
  PRIMARY KEY (session_id, path)
);
CREATE INDEX IF NOT EXISTS session_files_path ON session_files (path);
```

Written by `upsertSession` in the same transaction as the session row
(delete-then-insert for that session id, so a re-scan converges). Backfilled
once by a pure-SQL pass over `sessions.files_touched` — **no transcript is
re-read**; the data is already in Postgres. ~7,700 rows.

`sessions.files_touched` keeps the raw absolute paths (it is what the
transcript said, and the UI shows it); `session_files` holds the comparable
form.

### 4.1 Path normalisation

`normalizeSessionPath(abs, roots)`:

1. Strip any known code root or project `root_path` prefix (from `projects`
   and `project_locations`) -> repo-relative.
2. Else strip a `/Users/<any>/` or `/Volumes/<any>/` prefix and any segment
   run up to a recognisable repo name.
3. Else fall back to the last 3 path segments.

Result is lowercased for comparison only. Verified against the three eras
present in this corpus (`/Users/serge/_CODING/…`, `/Volumes/CloudBox/…`,
`/Users/nasta/__CODING NEW/…`), which must collapse onto one key.

### 4.2 Insights cache

```sql
CREATE TABLE IF NOT EXISTS session_insights (
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  cache_key      TEXT NOT NULL,
  payload        JSONB NOT NULL,
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, cache_key)
);
```

`cache_key` = hash of `{sections sorted, llm on/off, requested model,
EXTRACTION_SCHEME, PROMPT_VERSION, entriesCount, endedAt}`. `PROMPT_VERSION`
is a module constant bumped whenever the prompt changes — without it a prompt
fix would silently serve old reports forever. A growing session (more entries,
later `ended_at`) misses the cache by construction, which is correct.

## 5. Session search

### 5.1 Two retrieval legs

**Metadata leg (Postgres, always available).** Session id exact/prefix (>= 8
chars: pasting a UUID is an instant top hit), title and first-prompt match,
`session_files.path` fragment, project slug, `cwd`, `machine`. Contributes an
**additive** boost so a title match can surface a session no message matched.

**Content leg (existing hybrid search).** `sourceTypes: ['claude_session']`,
over-fetch `maxFetch` (default 250) entry hits, group by `sessionId`.

`SearchService.search` currently caps its fetch at `min(limit*2, 100)`. It
gains an optional `{ maxFetch }` option; the default behaviour is unchanged so
no existing caller moves.

### 5.2 Aggregation

For a session with member hits `h1 >= h2 >= … >= hn`:

```
content = h1 + 0.35 * SUM(i>=2) h_i / i
```

A decayed sum: many good matches beat one fluke, without long sessions winning
on length alone. Kind weights are applied to each `h_i` before aggregation
(`insight`/`summary`/`plan` 1.25, `prompt` 1.1, `response` 1.0, `action` 0.6)
— action entries are 164k of the corpus and are mostly filenames.

### 5.3 Priors

```
substance = 0.40*min(entries/60,1) + 0.25*min(actions/40,1)
          + 0.20*min(files/8,1)    + 0.15*min(durationMin/45,1)
score = (content + metadataBoost) * (0.55 + 0.45*substance) * recencyTilt
```

`substance` never zeroes a hit — a genuinely matching 3-message session still
ranks, it just stops flooding. `recencyTilt` is a mild configurable factor
(default: 1.0 at today, 0.9 at one year old), off with `KDB_SESSION_RECENCY_TILT=0`.

### 5.4 Dates in the query

`questionDates.ts` already parses date expressions. A leading/trailing date
phrase in the query ("the qdrant thing last tuesday") is lifted into
`since`/`until` and reported back in the response as `interpreted`, so the user
sees what was applied rather than wondering why results narrowed.

### 5.5 Threads

Sessions in the same project whose windows are within `threadGapMin`
(default 90) of each other **and** share >= 1 normalised file or >= 0.25
semantic similarity form a thread. Computed over the result set plus its
temporal neighbours only, never globally. A thread collapses to its best
session with a `thread: {size, memberIds}` badge; `thread=false` disables it.

### 5.6 Response

```ts
interface SessionCard {
  sessionId; projectSlug; machine?; title; subtitle;   // title | firstPrompt
  startedAt?; endedAt?; durationMs?;
  promptCount; actionCount; entryCount; filesTouched: string[];
  substance: number;                                    // 0..1
  score: number;
  why: MatchReason[];        // {kind:'id'|'title'|'file'|'message'|'project'|'cwd', detail, weight}
  excerpts: { entryId; kind: EntryKind; occurredAt?; text }[];   // <= 3
  thread?: { size: number; memberIds: string[] };
  ai?: { headline: string; gist: string };              // only when llm=true
}
```

`why` is not decoration: it is what lets the user identify the right session
without spending an LLM call, and it is the only thing that makes the ranking
auditable.

### 5.7 Optional LLM enrichment (default OFF)

`llm=true` sends **one** call for the whole page (top 8 cards, compact
evidence only) and returns `{headline, gist}` per card. Never one call per
card. Failure degrades to no `ai` field plus a `llm.status` note — never an
error, never a blank card.

## 6. Session insights

### 6.1 Sections (all enabled by default, each independently selectable)

| Section | Source | Notes |
|---|---|---|
| `overview` | deterministic | project, machine, cwd, window, duration, counts, substance |
| `goals` | deterministic | the user's own prompts, verbatim, in order |
| `did` | deterministic | rollup of `action` entries: tool histogram, files edited with counts, commands by first token, agents/skills |
| `highlights` | deterministic | `insight` / `summary` / `plan` messages verbatim (already classified) |
| `decisions` | **LLM** | decision + why |
| `problems` | **LLM** | what broke, what fixed it |
| `followups` | deterministic markers **+ LLM** | see 6.2 |
| `backlog` | deterministic | project backlog items (existing `backlog.ts` statuses) overlapping this session |
| `trail` | deterministic | git commits and kdb entries written inside the session window — the cross-source join only Atlas can do |
| `related` | §7 | compact top-5 |

### 6.2 Follow-up detection

Deterministic scan over message bodies for `TEMPORARY PATCH`, `TODO`,
`FIXME`, `backlog.log`, `unverified`, `next step`, `follow-up`, `deferred`,
`not done`, `left out` — each captured with its containing sentence and
`entryId`. The LLM layer then distils and de-duplicates them; the raw
evidence list is always returned alongside, so a wrong distillation is
visible rather than authoritative.

### 6.3 LLM layer

One call, strict JSON, and a hard input budget: all prompts (<= 20, 500 chars
each) plus plan/insight/summary bodies (<= 15, 800 chars each) plus the facts
rollup, capped at ~14,000 chars total. Raw `response` and `action` bodies are
never sent — the largest session in the corpus is 1,304 entries and would
otherwise serialise to megabytes.

Requested sections are passed into the prompt so the model produces only what
was asked.

**Trust contract** (consistent with ADR `20260725-ask-answer-trust-contract`):
every LLM-derived field is flagged `derived:'llm'` end to end; the
deterministic report is complete on its own; an unavailable LLM yields
`llm:{status:'unavailable', reason}` with the facts intact, never an error
page. A session with zero entries yields facts only and says why.

### 6.4 Cost control

Insights are generated **on demand** — opening the tab, running the command,
calling the tool. Never prefetched, never on pull-to-refresh (that re-reads
the cache; `refresh=true` is an explicit act). Concurrent requests for the
same `cache_key` share one in-process promise (single-flight), so two clients
opening the same report do not buy two completions.

## 7. Related sessions

### 7.1 Candidate generation (bounded)

- **File** — `session_files` join on shared normalised paths, excluding
  stop-files (`df > 5%` of file-bearing sessions) **from candidate generation
  only**; they still score, at their IDF weight. Cap 150.
- **Semantic** — anchor query text built from title + first prompt + top
  insight/summary bodies; entry search restricted to `claude_session`,
  aggregated to sessions by §5.2. Cap 100.
- **Temporal** — same project, +/- 14 days. Cap 150.

### 7.2 Scoring

```
fileScore  = IDF-weighted cosine over shared normalised paths   (df from SQL, not guessed)
semScore   = normalised aggregate from §5.2
projBonus  = same project
timeScore  = tiebreak only, never a primary reason
score      = weighted sum over the legs that are AVAILABLE, renormalised
           * (0.55 + 0.45*substance)
```

Renormalising over available legs is required because **72% of sessions have
no files**: a fixed denominator would systematically bury them.

Fallback ladder for a thin anchor (median session is 3 entries): title +
first prompt -> files -> temporal only. The response always reports
`basis: ('file'|'semantic'|'temporal')[]` so "we only had timestamps to go on"
is visible, not disguised as similarity.

Each result carries `direction: 'before'|'after'|'overlapping'`, `deltaMs`,
and a `why` breakdown naming the shared files and the contributing legs.

### 7.3 Context events (second request, on by default)

`git_commit` entries already carry `meta.files` (up to 100 paths, verified in
`parsers/gitLog.ts`). Commits and kdb entries in the same project touching the
anchor's normalised files are returned as timeline markers — because "what
other work was done on this thing" is often recorded in a changelog, not in
another session. Bounded by project + time window (served by the existing
`entries_project_time` index), filtered in memory. Loaded as a **separate
request** so it never delays the session list.

## 8. Shared presentation layer

`@atlas/shared/sessionView.ts` — pure view-models: card fields, the section
registry (id, label, description, `derived: 'facts'|'llm'|'mixed'`, default
on/off), `why` phrasing, duration/count formatting. Both clients render from
this, so wording and section semantics cannot drift.

`@atlas/shared/sessionTimeline.ts` — pure layout:

```
layoutTimeline(anchor, events, {span, orientation}) -> {nodes, edges, ticks, axis}
```

Positions come from a **log-compressed cumulative gap** transform: sort by
time, position `i` = normalised cumulative `log1p(gapDays)`. A three-month gap
therefore cannot flatten a busy week. Degenerate cases are defined and tested:
a single event centres; identical timestamps space evenly; a zero-width span
does not divide by zero.

Edges are shared-file ribbons between nodes with >= 1 shared normalised path.

## 9. UI

### 9.1 Reachable from anywhere a session is mentioned (explicit requirement)

A shared `SessionRefActions` affordance ("Open · Insights · Related") is
rendered wherever a `sessionId` appears: search hits, timeline rows, the
entry drawer, session lists — in web **and** mobile. This is a deliverable,
not a side effect.

### 9.2 Web

`Sessions` becomes a workspace: a global composer (project scope becomes an
optional filter, not a gate — the current single-project requirement is what
makes "type something and find it" impossible), ranked cards, and a session
detail with tabs `Conversation | Insights | Related`. The existing per-project
list, filter, kind chips and conversation view keep working unchanged.

URL state: `?view=sessions&session=<id>&tab=<tab>` so a report is a shareable
link and browser back behaves. Keyboard: `f` find, `i` insights, `r` related,
`Esc` back.

### 9.3 The related timeline

Horizontal on desktop, vertical on mobile. Anchor pinned at centre, `before`
one side, `after` the other; node radius from relatedness, colour from
project, shared-file ribbons between nodes, context-event markers on a second
lane. Tap/click a node -> its card -> its insights, so a chain can be walked.

Accessibility and robustness (not optional):

- the ranked list **beneath** the chart is the non-SVG equivalent, always
  present — the chart is an enhancement, never the only path to the data;
- `role="img"` with a summary label; arrow-key navigation between nodes with
  visible focus;
- interaction is tap/focus, never hover-only;
- `prefers-reduced-motion` respected;
- responsive from phone to ultrawide; no layout shift while loading.

### 9.4 Mobile

The same three surfaces, consuming the same shared modules; `react-native-svg`
timeline (vertical), bottom sheets for cards, pull-to-refresh reads cache,
haptics on tab/section toggles, share/export the report as markdown and PDF
via the existing export path, deep link `atlas://session/<id>?tab=insights`.

### 9.5 Empty and failure states

Distinct, never a shared blank: no sessions indexed · session not found (404,
never an empty-looking 200) · session with zero entries · LLM disabled · LLM
unavailable · no related sessions found · search degraded (Qdrant down, the
metadata leg alone answered).

## 10. CLI

`atlas session <id>` (replay) is unchanged. `sessions` becomes a command group
with `list` as the default action, mirroring the existing `machines` group, so
`atlas sessions deepcast` keeps working:

```
atlas sessions [list] <project>
atlas sessions find <query> [-p <slug>] [--since] [--until] [--llm] [-n]
atlas sessions insights <id> [--sections a,b,c] [--no-llm] [--refresh]
atlas sessions related <id> [--direction before|after|both] [--cross-project]
```

All support the existing global `--json`.

## 11. MCP

Three tools, thin proxies as required: `atlas_session_search`,
`atlas_session_insights`, `atlas_session_related`. `SERVER_INSTRUCTIONS` gains
a trigger line — an agent asked "what did we do about X" should reach for
session search before re-deriving it from code.

## 12. Testing

- **core**: aggregation and decay, substance, IDF cosine, path normalisation
  across the three real path eras, stop-file exclusion, marker scan, action
  parsing (`Bash: git commit -m "x: y"` splits on the first `: ` only),
  fallback ladder, cache-key composition including `PROMPT_VERSION`,
  single-flight.
- **shared**: timeline layout incl. all degenerate cases; section registry.
- **api**: the three routes, the `/api/sessions/search` vs `/api/sessions/:id`
  ordering, 404 on unknown session, LLM-off path, `routeClass` for all three.
- **ui**: cards, `why` rendering, tabs, timeline a11y (role/label/keyboard),
  `SessionRefActions` present on search and timeline rows, empty states.
- **mcp**: tool registry pin.
- **parity**: `@atlas/shared/sessionView` imports no React/DOM/RN, and both
  clients import it.

## 13. Phasing

1. `sessionFiles` + schema + backfill + `SearchService.maxFetch` + `routeClass`
2. `sessionSearch` + `sessionRelated` + API routes (no LLM)
3. `sessionInsights` facts layer + cache + API
4. LLM layers (insights narrative, optional search enrichment)
5. shared view-models + timeline layout
6. web UI
7. mobile UI
8. CLI + MCP + docs + ADR + KDB

Each phase lands with its tests. Nothing here requires a reindex or a restart
of the indexer beyond the normal deploy.
