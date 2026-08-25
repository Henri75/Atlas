import { PALETTE } from '@atlas/shared';

/**
 * The Atlas design system for native.
 *
 * Every color derives from the shared PALETTE — the same hex values the web's
 * CSS custom properties hold — so the two surfaces render one identity. The
 * web expresses tints with `color-mix(in srgb, X n%, transparent)`; native has
 * no color-mix, so `tint()` computes the identical rgba.
 */

export const colors = {
  bg: PALETTE.bg,
  panel: PALETTE.panel,
  panel2: PALETTE.panel2,
  line: PALETTE.line,
  ink: PALETTE.ink,
  muted: PALETTE.muted,
  faint: PALETTE.faint,

  kdb: PALETTE.kdb,
  claude: PALETTE.claude,
  git: PALETTE.git,
  doc: PALETTE.doc,
  report: PALETTE.report,

  // Derived chrome colors (same values the CSS variables resolve to).
  overlay: 'rgba(0,0,0,0.55)',
} as const;

/** `color-mix(in srgb, ${hex} ${pct}%, transparent)` for RN. */
export function tint(hex: string, pct: number): string {
  const a = Math.max(0, Math.min(100, pct)) / 100;
  return hexToRgba(hex, a);
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Font family names as registered by @expo-google-fonts (loaded in App). */
export const fonts = {
  sans: 'IBMPlexSans_400Regular',
  sansMedium: 'IBMPlexSans_500Medium',
  sansSemiBold: 'IBMPlexSans_600SemiBold',
  display: 'IBMPlexSansCondensed_600SemiBold',
  displayBold: 'IBMPlexSansCondensed_700Bold',
  mono: 'IBMPlexMono_400Regular',
  monoMedium: 'IBMPlexMono_500Medium',
} as const;

export const metrics = {
  screenPad: 16,
  cardRadius: 10,
  chipRadius: 999,
  spineWidth: 3,
} as const;
