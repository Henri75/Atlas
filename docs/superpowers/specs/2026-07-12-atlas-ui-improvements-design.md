# Atlas UI improvements — design

Created: 2026-07-12 19:57 UTC

## Revision History

- **2026-07-12 19:57 UTC** — Initial design. Ten UI improvements plus an LLM
  telemetry path in core. Supersedes nothing.

## Context

Ten requested improvements to the Atlas UI, gathered from real use. Two are
bug fixes with confirmed root causes, one is a correctness fix that was
requested as a display feature, and the rest are additive.

Everything lands in `packages/ui` except the LLM telemetry, which needs a
small, contained change in `packages/core`. **No datastore identifiers, schemas
or embeddings are touched, so no reindex is required.**

### What the live probe established

A streaming request against the real G2P gateway (`localhost:8181/v1`) on
2026-07-12 returned:

```
X-G2p-Reply-Attempts: 1
X-G2p-Reply-Model: google/gemma-4-31b-it
X-Request-Id: e77bdf6b-bae3-4114-8232-c78f3ddd1914
...
data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":19,"total_tokens":30}}
data: [DONE]
```

Three facts follow, and they drive the design:

1. **The UI currently reports the wrong model.** Config requested
   `gemini-2.5-flash`; G2P served `google/gemma-4-31b-it`. `ask.ts` reports
   `this.llmConfig.model` — what was *asked for*, not what *answered*. This is a
   correctness defect, not merely a missing feature.
2. **Model substitution is expected.** G2P routes by policy and will usually
   substitute. It is valid behaviour, so the served model is reported as plain
   fact — no warning styling, no requested-vs-served diff. A warning that fires
   on every reply is noise.
3. **Real token counts are available**, but only when the request sends
   `stream_options: {include_usage: true}`, which `llm.ts` does not currently
   send. The usage frame carries `choices: []`, so today's parser — which reads
   `choices[0].delta.content` — silently drops it.

Header names are matched **case-insensitively** (`X-G2p-` as sent, not `X-G2P-`);
`Headers.get()` is case-insensitive by spec, so this is free, but it must not be
"fixed" into a case-sensitive lookup later.

## Decisions

### 1. Bullet glyphs missing in rendered answers (bug)

**Root cause, confirmed.** `node_modules/tailwindcss/preflight.css:200` sets
`list-style: none`. `styles.css:77` restores `padding-left: 1.4em` on
`.kdb-md ul, .kdb-md ol` but never restores `list-style`, so list items indent
with no marker and read as plain paragraphs.

**Fix.** Restore markers in `styles.css`: `disc` for `ul`, `decimal` for `ol`,
`circle` for nested `ul`. CSS only; `marked` already emits correct `<ul><li>`.

**Note on verification.** `test/ui/markdown.test.tsx` already asserts
`querySelectorAll('li')` has length 2, and it **passes today** — proving the
`<li>` elements are present and that only the glyph is suppressed. Consequently
**this fix cannot be unit-tested**: jsdom does not apply external stylesheets, so
`getComputedStyle(ul).listStyleType` would report `none` even when the fix is
correct. Verification is a real-browser check against the running UI, recorded in
the component log. Do not add a jsdom test that appears to cover this — it would
be testing nothing.

### 2. Retry still shows "LLM unavailable", with no loading state (bug)

**Root cause, confirmed — and there are two independent sources of the message.**

- **The banner.** `run()` (`AskConversation.tsx:74`) resets `content`, `sources`,
  `streaming` and `error`, but **not `degraded`**. The render guard is
  `t.degraded && !t.error` (line 216). Clearing `error` while leaving
  `degraded: true` therefore *flips the banner on*.
- **The prose.** On LLM failure `ask.ts` yields the failure text as a `delta`,
  so `"_LLM unavailable (…)_"` is baked into `content` itself. `run()` does
  reset `content: ''`, so this one already clears — but it explains why the
  message felt "stuck" and must not be reintroduced.

**Fix.** Reset the full per-attempt result in `run()`: `degraded: false`,
`scopeFallback: undefined`, `metrics: undefined`. Object spread (`{...t, ...up}`)
overwrites a key set to `undefined`, so this clears correctly.

**Loading state.** Separate defect: the placeholder is static text
(`'reading sources…'`). Replace with an animated indicator, and disable the
retry button while *that turn* is streaming.

### 3. LLM telemetry — always on, no Settings view

The user chose always-on metrics, which **removes the need for a Settings view
entirely** — it was the only requested item needing a new navigation surface.

Rendered under every reply as plain fact:

```
gemma-4-31b-it · 30 tok · 412ms to first token · 18.3 tok/s
```

with `X-Request-Id` and `X-G2p-Reply-Attempts` on hover (attempts > 1 means the
gateway silently retried — worth surfacing, unlike substitution).

- **Model** — `X-G2p-Reply-Model`, falling back to the requested model if absent.
- **Tokens** — the `usage` frame; requires sending `stream_options:
  {include_usage: true}`.
- **TTFT** — measured server-side at the first content delta, so it excludes
  browser-to-API latency and measures the model, not the network.
- **tok/s** — `completion_tokens / (total_elapsed − ttft)`. Guarded against a
  zero/negative denominator (a sub-millisecond reply); omitted rather than shown
  as `Infinity`.

**Metrics are optional throughout.** `chatStream` throws *before* yielding when
the LLM is unreachable, so on the degraded path there are no headers and no
usage. `done.metrics` is therefore optional and the UI renders nothing when it
is absent.

#### Implementation shape (revised — see Alternatives)

`createSseParser` keeps its `string[]` return type and gains an **optional usage
sink**. `chatStream` keeps yielding bare `string` deltas and gains an **optional
`onMeta` callback**. Both are additive:

- six existing `createSseParser` tests keep passing untouched;
- `ask.ts:296`'s `for await (const delta of chatStream(...))` loop is unchanged;
- `chatComplete` is not touched at all.

The API route needs **no change**: it does `JSON.stringify(value)` over the whole
event, so a new `metrics` field on `done` passes through as-is.

### 4. Ask composer under the reply

Top bar keeps its job (search, `/` hotkey, Enter = search, ⌘Enter = ask). A new
composer sits under the conversation, auto-focused after each reply so a
follow-up needs no scrolling.

**Both inputs share one text state.** Two inputs with independent state let
stale text hide in the off-screen one and get sent by accident.

### 5. Sidebar: filter + favourites

- **Filter** reuses the existing `FilterInput`, `matches` and `Highlight` from
  `components/ui.tsx` — already built for exactly this and used elsewhere.
- **Favourites** pin to a `★ FAVORITES` group while idle. **While the filter is
  active the grouping flattens** to one ranked list, so the thing typed is
  always the top hit; favourites are merely starred, never hoisted above a
  better match.
- Persisted in `localStorage`. `usePersistentState` is currently
  `<T extends string>`; it is generalised to JSON-serialisable values. Its one
  existing caller (`TimelineView`, a string union) stays source-compatible.

### 6. Clickable, hoverable footnotes

`citationize()` already rewrites `[n]` → `<sup class="kdb-cite">`. Those become
real anchors that scroll the matching source row into view and flash it, plus a
hover card showing the source's title, project and path.

**The security model is preserved.** The transform continues to run on
*already-sanitised* HTML (parse → sanitise → citationize), so it cannot
reintroduce markup. Answers are model output synthesised from arbitrary indexed
content and stay untrusted. The `n` captured from the regex is matched against
the known `sources` array and is never interpolated into HTML — an unmatched
`[99]` renders as inert text, not a dangling anchor.

### 7. Export: markdown + PDF + copy

One renderer over `t.content` (markdown) and `t.sources` (structured), serialised
two ways. Copy already exists (`CopyButton`).

- **Markdown** — reply plus a `## Sources` section. Zero dependencies.
- **PDF** — **jsPDF v4 standalone, without `html2canvas`.** Selectable vector
  text, live footnote links, light printable page. Measured cost: **242 KB
  gzipped**.

Generating from the *source data* rather than screenshotting the DOM also avoids
exporting the app's dark theme into a document meant for paper.

### 8. Loading animation

A shared animated indicator replaces the static `'querying…'` (`Spinner`) and
`'reading sources…'` strings, used by search, ask, and retry. Honours
`prefers-reduced-motion`, which `styles.css:47` already establishes as the house
rule.

## Consequences

**Positive.** Two real bugs fixed at the root. The model attribution becomes
truthful. Long replies stop forcing a scroll to ask a follow-up. A 90-project
sidebar becomes navigable.

**Negative.** +242 KB gzipped for jsPDF — the only meaningful cost, accepted for
one-click export. `llm.ts` grows two optional parameters.

**Blast radius.**

| Area | Risk | Verification |
|---|---|---|
| `llm.ts` (parser + stream) | Low — additive params, no signature break | 6 existing parser tests must stay green **unmodified** |
| `ask.ts` | Low — one call site, loop unchanged | `askStream` tests; `toMatchObject` tolerates the new field |
| API route | **None** — generic `JSON.stringify` | existing route tests |
| `usePersistentState` | Low — generalised; `TimelineView` is the only caller | existing timeline test |
| `Markdown.tsx` | **Security-sensitive** — must not weaken sanitisation | XSS test must stay green; add anchor tests |
| Datastores | **None touched** | no reindex |

## Alternatives Considered

**Tagged-union `chatStream` (rejected).** The first draft changed `chatStream`
to yield `{type:'delta'|'meta'|'usage'}` and `createSseParser` to return a union.
Reading the tests killed it: six `createSseParser` tests pin `string[]`, and the
rewrite would have churned all of them plus the `ask.ts` loop for zero
user-visible gain. Optional out-params deliver the same feature with a strictly
smaller diff. (Project guidelines §3.3: "Modify & Reuse" over a signature
rewrite.)

**jsPDF + html2canvas (rejected).** The popular pairing, and the user's initial
choice — revisited once measured. `html2canvas` rasterises the DOM: text is not
selectable, footnote links become dead pixels, and it cannot parse `color-mix()`
or `oklch()`, which this theme is built on end to end — badges and citations
would render as black boxes. It is also pinned at v1.4.1 (no feature release
since 2022). **jsPDF standalone has none of these problems**; the two libraries
were conflated, and separating them removed the entire quality-vs-convenience
tradeoff.

**`window.print()` (rejected, viable).** Genuinely good: 0 KB, vector text, live
links. Costs one extra click through the browser print dialog. Rejected only
because the user explicitly wanted a true one-click download.

**pdfmake (rejected).** Maintained and vector-text, but 355 KB gzipped (~50%
more than jsPDF) for a richer layout engine this export would not use.

**pdf-lib (rejected).** Last published 2022-05-12, still v1.17.1. Unmaintained.

**Settings view for the metrics toggle (obsoleted).** The original request
specified a Settings option. Choosing always-on metrics removed the need for the
view altogether — the simpler outcome, and one fewer navigation surface.

**Favourites always pinned, even while filtering (rejected).** Consistent
grouping, but a filter match can then sit *below* a worse-matching favourite,
which breaks the filter's basic promise.

## Testing

New tests, alongside the existing 336:

| Area | Test |
|---|---|
| Retry (regression) | `run()` clears `degraded`, `scopeFallback` and `metrics` — the exact reported bug |
| Markdown (security) | existing XSS tests stay green; citation anchors do not reintroduce markup; unmatched `[99]` stays inert |
| Telemetry | parser captures `usage` from a `choices: []` frame; headers map to metrics; missing usage yields no metrics |
| Telemetry | tok/s guarded when elapsed ≈ ttft (no `Infinity`) |
| Degraded path | LLM failure produces `done` with **no** metrics, and the UI renders none |
| Sidebar | filter flattens the favourites grouping; favourites persist and re-order |
| Export | markdown export contains the reply and every source |
| Composer | top bar and bottom composer share one text value |

## References

- Component log: `kdb/components/atlas.log`
- Prior specs: `docs/superpowers/specs/2026-07-10-docs-staleness-design.md`
- No ADR: no cross-component architectural change (§6). The `llm.ts` change is
  additive and contained to one consumer.
