# Atlas mobile (Expo)

The native iOS/Android app — a 1:1 of the Atlas web UI plus native-only
capabilities. Full documentation, feature-parity table and gotchas live in
[`docs/mobile.md`](../docs/mobile.md).

```bash
make install         # from the repo root — wires workspaces
make mobile-start    # builds @atlas/shared, runs the Expo dev server
```

- Server address defaults to `http://127.0.0.1:8712` (iOS simulator on the
  same Mac); set the Mac's LAN IP for physical devices, in the app's Settings.
- Typecheck: `make mobile-typecheck`.
- Regenerate assets: `make mobile-assets`.

Shared logic with the web lives in `packages/shared` (`@atlas/shared`) —
types, palette, formatting, date ranges, query description, markdown repair,
export serialization and the Ask conversation engine. Only rendering and
transport are platform-specific.

> 2026-08-25 19:00 UTC — initial version.
