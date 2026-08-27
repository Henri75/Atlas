import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTE, isView } from '@atlas/shared';
import { atlasManifest } from '../../packages/ui/vite.config.js';

/**
 * The manifest is the installed app's identity, and every one of its failure
 * modes is silent: a missing icon just shows a blank tile, a shortcut pointing
 * at a view that no longer exists just opens the default one. Nothing throws,
 * so nothing catches it except a check like this.
 */

const PUBLIC = new URL('../../packages/ui/public/', import.meta.url);

// Partial<ManifestOptions> makes every field optional, which is honest — the
// plugin does not require any of them. Atlas does, so absence is a failure
// here rather than something to thread `?.` through every assertion.
const icons = atlasManifest.icons ?? [];
const shortcuts = atlasManifest.shortcuts ?? [];

describe('web app manifest', () => {
  it('declares what a browser needs to accept an install', () => {
    expect(atlasManifest.name).toBeTruthy();
    expect(atlasManifest.short_name ?? '').not.toBe('');
    expect((atlasManifest.short_name ?? '').length).toBeLessThanOrEqual(12);
    expect(atlasManifest.start_url).toBe('/');
    expect(atlasManifest.scope).toBe('/');
    expect(atlasManifest.display).toBe('standalone');
  });

  /** Drift here is how the splash ends up a different colour from the app. */
  it('takes its colours from the shared palette', () => {
    expect(atlasManifest.background_color).toBe(PALETTE.bg);
    expect(atlasManifest.theme_color).toBe(PALETTE.bg);
  });

  it('ships the icon sizes an installable PWA is required to have', () => {
    const sizes = icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    // Android crops icons to the launcher's shape; without a maskable variant
    // it letterboxes the square one inside a white circle.
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it.each([
    ...new Set([
      ...icons.map((i) => i.src),
      ...shortcuts.flatMap((s) => (s.icons ?? []).map((i) => i.src as string)),
    ]),
  ])('has %s on disk', (src) => {
    expect(existsSync(new URL(`.${src}`, PUBLIC))).toBe(true);
  });

  it('only offers shortcuts to views that exist', () => {
    expect(shortcuts.length).toBeGreaterThan(0);
    for (const s of shortcuts) {
      const view = new URLSearchParams(s.url.split('?')[1]).get('view');
      expect(isView(view), `${s.url} is not a real view`).toBe(true);
    }
  });
});
