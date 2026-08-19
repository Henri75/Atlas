import { isMap, isSeq, parseDocument } from 'yaml';
import { machinesFileSchema } from '@atlas/core';

/**
 * Pure, testable mutators for config/machines.yaml — the CLI's own checkout
 * edits (spec §3: "the CLI runs on the host and owns the checkout, so it may
 * edit the file"). Both go through the `yaml` package's Document API rather
 * than a plain parse/stringify round-trip: machines.yaml ships with
 * load-bearing commentary (the .local warning, defaults, slugOverrides
 * example) that a plain re-serialize would silently drop.
 *
 * Both validate the resulting document against machinesFileSchema before
 * returning — an invalid, duplicate-name (add), or would-be-empty (remove,
 * via the schema's `machines.min(1)`) result never reaches the caller's
 * write path. Neither function touches disk or the network: the thin
 * commander handlers in main.ts own I/O and the /api/machines frozen-name
 * check (remove is refused there when the API reports sync history for the
 * name, before removeMachine is ever called).
 */

export interface NewMachine {
  name: string;
  address: string;
  user: string;
  codeRoots: string[];
  claudeProjects: string;
}

function machinesSeq(docText: string) {
  const doc = parseDocument(docText);
  const seq = doc.get('machines', true);
  if (!isSeq(seq)) throw new Error('machines.yaml has no top-level "machines" list');
  return { doc, seq };
}

/** Throws (a ZodError) on any schema violation — same failure mode as loadMachinesFile. */
function validate(doc: ReturnType<typeof parseDocument>): void {
  machinesFileSchema.parse(doc.toJS());
}

export function addMachine(docText: string, machine: NewMachine): string {
  const { doc, seq } = machinesSeq(docText);
  seq.add({
    name: machine.name,
    address: machine.address,
    user: machine.user,
    codeRoots: machine.codeRoots,
    claudeProjects: machine.claudeProjects,
    enabled: true,
  });
  validate(doc);
  return doc.toString();
}

export function removeMachine(docText: string, name: string): string {
  const { doc, seq } = machinesSeq(docText);
  const idx = seq.items.findIndex((item) => isMap(item) && item.get('name') === name);
  if (idx === -1) throw new Error(`no machine named "${name}" in machines.yaml`);
  seq.delete(idx);
  validate(doc);
  return doc.toString();
}
