import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { addMachine, removeMachine } from '../../packages/cli/src/machinesFile.js';

// Load-bearing commentary (spec §3): the .local warning and a per-entry note.
// A plain YAML.parse + YAML.stringify round-trip would drop all of this.
const BASE = `# Atlas machine fleet — committed, travels with the repo (docs/multi-machine.md)
machines:
  - name: nasta-mbp            # primary — do not rename once it has data
    address: 192.168.1.20      # NOT *.local — mDNS does not resolve in containers
    user: nasta
    codeRoots: ["/Users/nasta/__CODING NEW"]
    claudeProjects: /Users/nasta/.claude/projects
sync:
  intervalMin: 10
`;

const M4MAX = {
  name: 'm4max',
  address: '192.168.1.30',
  user: 'serge',
  codeRoots: ['/Users/serge/CODING'],
  claudeProjects: '/Users/serge/.claude/projects',
};

describe('addMachine', () => {
  it('appends a machine and preserves every existing comment', () => {
    const out = addMachine(BASE, M4MAX);
    expect(out).toContain('# Atlas machine fleet — committed, travels with the repo (docs/multi-machine.md)');
    expect(out).toContain('# primary — do not rename once it has data');
    expect(out).toContain('# NOT *.local — mDNS does not resolve in containers');

    const machines = parseDocument(out).toJS().machines;
    expect(machines).toHaveLength(2);
    expect(machines[0]).toMatchObject({ name: 'nasta-mbp' });
    expect(machines[1]).toMatchObject({
      name: 'm4max', address: '192.168.1.30', user: 'serge', enabled: true,
      codeRoots: ['/Users/serge/CODING'], claudeProjects: '/Users/serge/.claude/projects',
    });
  });

  it('refuses a duplicate name', () => {
    expect(() => addMachine(BASE, { ...M4MAX, name: 'nasta-mbp' })).toThrow(/duplicate/i);
  });

  it('refuses an invalid entry (schema validation runs before writing)', () => {
    expect(() => addMachine(BASE, { ...M4MAX, address: 'm4max.local' })).toThrow(/\.local/);
    expect(() => addMachine(BASE, { ...M4MAX, name: 'M4 Max' })).toThrow(/name/);
    expect(() => addMachine(BASE, { ...M4MAX, codeRoots: [] })).toThrow();
  });

  it('bootstraps from an empty machines list', () => {
    const out = addMachine('machines: []\n', M4MAX);
    expect(parseDocument(out).toJS().machines).toEqual([
      { name: 'm4max', address: '192.168.1.30', user: 'serge', codeRoots: ['/Users/serge/CODING'], claudeProjects: '/Users/serge/.claude/projects', enabled: true },
    ]);
  });

  it('throws when the document has no "machines" list at all', () => {
    expect(() => addMachine('sync:\n  intervalMin: 10\n', M4MAX)).toThrow(/machines" list/);
  });
});

describe('removeMachine', () => {
  const TWO = addMachine(BASE, M4MAX);

  it('removes a machine and preserves the surviving entry\'s comments', () => {
    const out = removeMachine(TWO, 'm4max');
    expect(out).toContain('# Atlas machine fleet — committed, travels with the repo (docs/multi-machine.md)');
    expect(out).toContain('# primary — do not rename once it has data');
    const machines = parseDocument(out).toJS().machines;
    expect(machines).toHaveLength(1);
    expect(machines[0].name).toBe('nasta-mbp');
  });

  it('throws for an unknown name', () => {
    expect(() => removeMachine(BASE, 'ghost')).toThrow(/no machine named "ghost"/);
  });

  it('refuses to remove the last remaining machine — schema requires at least one', () => {
    expect(() => removeMachine(BASE, 'nasta-mbp')).toThrow();
  });
});
