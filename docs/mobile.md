# Atlas mobile — the native Expo app

> 2026-08-25 19:00 UTC — initial version (v1.0, Expo SDK 57 / RN 0.86).

Revision history:

- 2026-08-25 19:00 UTC — created; feature parity with the web UI at the
  multi-machine merge (1325-test baseline), plus native-only capabilities.

Atlas ships a native iOS/Android app in [`mobile/`](../mobile/), built with
Expo. It is a **1:1 of the web/PWA** — same seven views, same visual identity —
plus capabilities only a native app can offer. Both clients share one logic
core, [`@atlas/shared`](../packages/shared/), so behaviour cannot drift.

## Run it

```bash
make install        # npm workspaces, wires mobile + @atlas/shared
make mobile-start   # builds @atlas/shared, starts the Metro dev server
# press i (iOS simulator), a (Android emulator), or scan the QR with Expo Go
```

Prerequisites: the Atlas stack running (`make start`), and Xcode/Android
Studio for simulators (or the Expo Go app on a physical device).

**Point the app at your stack.** First launch opens Settings; the default
server is `http://127.0.0.1:8712` (right for iOS simulators on the same Mac).
On a physical device use the Mac's LAN IP, e.g. `http://192.168.1.20:8712`.
"Test connection" probes `/api/stats`; if the instance is LAN-exposed
(`ATLAS_BIND=0.0.0.0` + `ATLAS_TOKEN`), paste the token from `atlas connect` —
it is stored in Keychain/Keystore, and any 401 anywhere raises the token gate.

## What is implemented (1:1 with web/PWA)

| Web view | Mobile screen | Notes |
|---|---|---|
| Search & Ask | Search tab | One composer, two modes (segmented Search/Ask with the amber armed state); all filters: sources, kind, doc status, machine (fleet only); streaming multi-turn Ask with retry/delete per turn, citations, scope-fallback notices, degraded banners, metrics line |
| Overview | Overview tab | Stats, fleet cards, services + embedder health incl. fallback/searchDegraded warnings, storage + collections + stale-vector notice, 30-day activity chart, source breakdown with files/bytes, recent runs, reindex CTA |
| Timeline | Timeline tab | Feed and table layouts (persisted), day rulers, filter with N-of-M, load older, merged multi-project feed with project tags |
| Components | More → Components | One project at a time (pick-project empty state), filterable list, full markdown history per component |
| Sessions | Sessions tab | One project at a time, filter by title/id/folder, detail as a pushed native screen: kind filter chips (YOU/PLAN/INSIGHT/SUMMARY/DID/CLAUDE), conversation filter with in-markdown highlight, files touched |
| Monitor | More → Monitor | All four tabs: Overview (stat tiles, route-class share + filter, daily stacked bars, hour strip, per-tool table with sparklines), Calls (server-faceted filters, hide-noise, errors-only, infinite scroll with cursor + stale-response guard, call detail sheet with reply/tokens/model), Stats (did-it-work rates, search/ask tiles, latency histogram, weekday, models, repeated questions), Adoption (fire-rate cards, candidate misses, compute-now) |
| Machines | More → Machines | Read-only fleet cards: address/user/roots, enabled, sync state pill, last success/bytes/duration/error |
| Token gate | full-screen gate | Any 401 swaps the shell for the token prompt (spec §7) |
| Scope bar | chip row + modal picker | Multi-select scope, favourites (persisted), counts, single-project note |
| Settings | More → Settings | Start-view radio (all seven views), server address, token, reindex now |

Everything renders in the Atlas identity: the exact palette from the web's CSS
custom properties (`--color-bg #0e1116`, `--color-kdb #e3b341`, …), IBM Plex
Sans / Sans Condensed / Mono loaded at launch, the spine-row signature element,
source badges, eyebrow labels, and the same `rise`/dots/caret motion language.

## Native-only

- **Animated boot**: static splash hands off seamlessly to an in-app splash —
  the amber lens-and-orbit mark with an orbiting satellite — until fonts land.
- **Global loading bar**: a thin amber sweep at the top of the screen whenever
  *any* API request is in flight (subscribes to the transport, zero per-screen
  wiring), plus the web's pulse-dots in place.
- **Server address + secure token storage** (Keychain/Keystore), connection
  tester, diagnostics copy — a phone cannot assume same-origin localhost.
- **Pull-to-refresh** on data views; **haptics** on mode/filter/tab/send
  actions and copy confirmations.
- **Bottom sheets** (drag-to-dismiss, back-button aware) replace the entry and
  call drawers, keeping the list as context.
- **Share/export**: reply markdown via the native share sheet; PDF via
  `expo-print` + share (the web's jsPDF path, native form); copy paths and
  source references with the system clipboard.
- **Deep links**: `atlas://session/<id>` opens a session; `atlas://entry/<id>`
  opens the full record.
- **Native navigation**: real stack push/back-swipe for session detail;
  hardware-back correctness on Android; edge-to-edge, dark-only chrome.

## Architecture

```
mobile/
  app.json               Expo config (scheme atlas://, dark, splash, icons)
  metro.config.js        monorepo: watches repo root, resolves both node_modules
  src/
    theme.ts             palette from @atlas/shared PALETTE + tint() (color-mix twin)
    api/                 client (baseURL+token+loading bus), endpoints (1:1 with ui/api.ts),
                         stream.ts (SSE over expo/fetch, incremental UTF-8)
    state/               server store (baseUrl/token/projects/stats/401), AsyncStorage prefs
    hooks/               useScope / useMachines / debounce (web twins)
    components/          atoms, charts (no library), MarkdownNative, Sheet, ScopeBar,
                         EntrySheet, CallSheet, TokenGate, Splash, TopProgressBar, Toast
    screens/             SearchAsk, Dashboard, Timeline, Sessions(+detail), Components,
                         Machines, Settings, monitor/{MonitorScreen,Overview,Calls,Stats,Adoption}
    navigation/          bottom tabs (5) + native stacks; More stack holds Components/
                         Monitor/Machines/Settings
```

**Shared core** — `packages/shared` (`@atlas/shared`), consumed by BOTH the
web UI and mobile: API payload types, the palette (hex as single source of
truth), number/byte/duration/relative-time formatting, date ranges,
recorded-query description, the view registry, markdown truncation repair,
reply→markdown export serialization, and the entire Ask conversation engine
(turn sequencing, retry-without-self-context, delete-cascades, abort handling)
with the transport injected per platform (web: fetch/SSE; native:
`expo/fetch` streaming). `packages/ui` re-exports these through its old module
paths, so the web build and its 195 tests are unchanged consumers.

**Streaming on native**: RN's plain fetch has no readable response body, so
Ask uses `expo/fetch` (WinterCG, real ReadableStream) with a hand-rolled
incremental UTF-8 decoder (Hermes ships no TextDecoder) — the same
split-on-`\n\n` SSE parser as the web, byte-for-byte.

## Conventions & gotchas

- **`@atlas/shared` must be built** (`npm run build -w packages/shared`)
  before Metro or the ui production bundle resolves it — `make mobile-start`
  chains it; CI should too.
- Metro watches the whole repo root (Expo's documented monorepo setup);
  expect the first bundle to be slow.
- Preferences use the SAME storage keys as the web (`atlas.scope.projects`,
  `atlas.startView`, `atlas.monitor.filters`, …) so the semantics stay
  comparable, though the stores are obviously per-device.
- The app reports itself to the usage monitor as client **`mobile`** — it will
  appear in Monitor's client charts alongside `ui`, `cli`, `mcp`.
- Assets are generated, not hand-drawn: `make app-assets` re-renders the native
  icon/adaptive-icon/splash *and* the web PWA icons and iOS startup images from
  `scripts/app_assets.py`, all from the same palette, so the two surfaces cannot
  drift apart.
- Native builds for distribution: `npx expo prebuild` + Xcode/Studio, or
  `eas build` (no eas config is committed).

## Testing / verification status

- `make lint` — green (includes `packages/shared` sources).
- `make test` — 1325/1325 green (195 UI tests unchanged; the shared extraction
  is covered by the existing suites plus the shared modules they import).
- `npm run typecheck -w mobile` (or `make mobile-typecheck`) — strict, clean.
- Manual smoke: run the stack, `make mobile-start`, search, ask (watch the
  stream), timeline, session detail, monitor tabs, machines, settings probe.
