<!-- GENERATED VIEW — do not edit. Rebuilt from atlas-shared.log by bin/kdb_rebuild.mjs -->

---
### [2026-08-25] - [mobile-1: shared core extraction]

**Objective:**
- One source of truth for everything platform-neutral, consumed by the web UI and the new Expo app, so the two clients cannot drift.

**Summary of Work:**
- New workspace package packages/shared (@atlas/shared, tsc→dist, ESM): API payload types + PALETTE (hex as the single color source), SOURCE_META/ROUTE_CLASS_META/ACTIVITY_FAMILIES/ENTRY_KIND_META/CLIENT_COLORS, format.ts, dateRange.ts, describeQuery.ts, nav.ts (VIEWS), scope semantics (scopeOf/toggle/remove/scopeParam), markdownRepair (repairTruncated), exportText (toMarkdown/exportFilename/sourceRef), askTurns (useAskConversation with the transport injected as 5th arg + describeError/ms/questionFor/Turn/AskEvent).
- packages/ui refactored onto it via thin barrels (types/format/dateRange/describeQuery/nav re-export from @atlas/shared); Markdown/ExportReply/charts/Sessions/Dashboard import shared constants (hex renders identically to the old var() strings); SearchView injects api.askStream; useScope keeps persistence, imports pure semantics.

**Key Decisions & Rationale:**
- Colors as raw hex in shared (not var() strings): valid CSS anywhere they were interpolated, directly usable in RN — one table, zero drift.
- Ask transport injected rather than imported: web passes fetch/SSE, mobile passes expo/fetch streaming; the sequencing (retry-without-self-context, delete-cascades, abort, stale-run guards) is shared verbatim.
- Vitest aliases @atlas/shared to SOURCE (tests never need a build); vite build chains shared first; tsconfig.lint includes shared sources.

**Code/Files Modified:**
- packages/shared/** (new), packages/ui/src/{types,format,dateRange,describeQuery,nav,useScope}.ts, components/{Markdown,ExportReply,charts,ui}.tsx, views/{AskConversation,SearchView,SessionsView,DashboardView}.tsx, package.json/vitest.config.ts/tsconfig.lint.json (root).

**Outcomes & Lessons Learned:**
- **What Worked:** barrels kept every ui import path stable — 195/195 UI tests green untouched apart from the askConversation test now passing the transport explicitly.
- **What Failed:** first shared tsconfig used base lib ES2024 only → AbortController/URLSearchParams missing; added DOM lib. NodeNext demanded .js relative extensions.

**Status:**
- Completed
