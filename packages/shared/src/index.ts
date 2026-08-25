/**
 * @atlas/shared — platform-neutral Atlas logic.
 *
 * One source of truth for everything that is pure TypeScript, consumed by the
 * web UI (packages/ui) and the native app (mobile/): API payload types and the
 * color palette, number/date formatting, date ranges, recorded-query
 * description, the navigation model, markdown repair for truncated snippets,
 * reply export serialization, and the multi-turn Ask engine (transport
 * injected per platform).
 */

export * from './types.js';
export * from './format.js';
export * from './dateRange.js';
export * from './describeQuery.js';
export * from './nav.js';
export * from './scope.js';
export * from './markdownRepair.js';
export * from './exportText.js';
export * from './askTurns.js';
