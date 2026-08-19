import { describe, expect, it } from 'vitest';
import { formatWhichRows, whichOutcomeLabel, type WhichRow } from '../../packages/cli/src/format.js';

describe('whichOutcomeLabel', () => {
  it('active/conflicted pass through the probe state directly', () => {
    expect(whichOutcomeLabel({ ok: true, machine: 'm', bootId: 'b', state: 'active', entries: 1 })).toBe('active');
    expect(whichOutcomeLabel({ ok: true, machine: 'm', bootId: 'b', state: 'conflicted', entries: 1 })).toBe(
      'conflicted',
    );
  });

  it('bad-proof and no-proof both fold to token-mismatch', () => {
    expect(whichOutcomeLabel({ ok: false, reason: 'bad-proof' })).toBe('token-mismatch');
    expect(whichOutcomeLabel({ ok: false, reason: 'no-proof' })).toBe('token-mismatch');
  });

  it('unreachable stays unreachable', () => {
    expect(whichOutcomeLabel({ ok: false, reason: 'unreachable' })).toBe('unreachable');
  });
});

describe('formatWhichRows', () => {
  const rows: WhichRow[] = [
    { name: 'nasta-mbp', address: '192.168.1.20', outcome: { ok: true, machine: 'nasta-mbp', bootId: 'b1', state: 'active', entries: 42 } },
    { name: 'm4max', address: '192.168.1.30', outcome: { ok: false, reason: 'unreachable' } },
  ];

  it('marks the resolved winner and renders every row', () => {
    const lines = formatWhichRows(rows, 'nasta-mbp');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('nasta-mbp');
    expect(lines[0]).toContain('192.168.1.20');
    expect(lines[0]).toContain('active');
    expect(lines[0]).toContain('entries=42');
    expect(lines[0]?.startsWith('→')).toBe(true); // → marks the winner
    expect(lines[1]).toContain('m4max');
    expect(lines[1]).toContain('unreachable');
    expect(lines[1]?.startsWith('→')).toBe(false);
  });

  it('marks no winner when resolution failed for everyone', () => {
    const lines = formatWhichRows(rows, undefined);
    expect(lines.every((l) => !l.startsWith('→'))).toBe(true);
  });

  it('renders a token-mismatch row with a dash for machine/entries', () => {
    const lines = formatWhichRows(
      [{ name: 'x', address: '10.0.0.1', outcome: { ok: false, reason: 'bad-proof' } }],
      undefined,
    );
    expect(lines[0]).toContain('token-mismatch');
    expect(lines[0]).toContain('machine=—');
    expect(lines[0]).toContain('entries=—');
  });
});
