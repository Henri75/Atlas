import { useMachines } from '../useMachines';
import type { MachineRow, MachineSync } from '../types';
import { Empty, Eyebrow, Spinner } from '../components/ui';
import { bytes, millis, relativeTime } from '../format';

/**
 * Read-only fleet table (v1 per spec): config/machines.yaml is the source of
 * truth, and edits happen there or via `atlas machines add/remove` — never
 * on this page. It exists so "is my fleet syncing?" has an answer without a
 * terminal.
 */

export type SyncState = 'never' | 'running' | 'ok' | 'unreachable' | 'error';

/** `sync: null` (no machine_sync row yet) reads as 'never', same as the CLI. */
export function syncStateOf(sync: MachineSync | null | undefined): SyncState {
  const s = sync?.status;
  return s === 'running' || s === 'ok' || s === 'unreachable' || s === 'error' ? s : 'never';
}

/**
 * Mirrors the CLI's syncBadge palette (green/cyan/yellow/red/dim) onto the
 * app's fixed five-color set: no separate yellow exists here, so
 * 'unreachable' borrows the amber already used for "warning, not broken"
 * elsewhere (the dashboard's stale-vector notice).
 */
export const SYNC_STATE_COLOR: Record<SyncState, string> = {
  never: 'var(--color-faint)',
  running: 'var(--color-claude)',
  ok: 'var(--color-git)',
  unreachable: 'var(--color-kdb)',
  error: 'var(--color-report)',
};

export function SyncPill({ sync }: { sync: MachineSync | null | undefined }) {
  const state = syncStateOf(sync);
  const color = SYNC_STATE_COLOR[state];
  return (
    <span
      className="font-mono text-[10px] tracking-widest px-1.5 py-0.5 rounded-sm whitespace-nowrap"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {state}
    </span>
  );
}

export function MachinesView() {
  const { self, machines, loading, error } = useMachines(15_000);

  if (error && machines.length === 0) {
    return (
      <Empty
        title="Cannot reach the API."
        hint="The stack may still be starting. Check `make ps` and `make logs`."
      />
    );
  }
  if (loading) return <Spinner />;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-xl font-semibold">Machines</h1>
      </div>
      <p className="mt-1 font-mono text-[11px] text-faint">
        Configured in <code className="font-mono">config/machines.yaml</code>. Edit the file or
        run <code className="font-mono">atlas machines add</code> /{' '}
        <code className="font-mono">remove</code> — this page is read-only.
      </p>

      {machines.length === 0 ? (
        <div className="mt-8">
          <Empty
            title="Single-machine mode."
            hint="No config/machines.yaml is configured — everything indexes as one machine named 'local'. See docs/multi-machine.md to add a fleet."
          />
        </div>
      ) : (
        <div className="mt-6">
          <Eyebrow>Fleet</Eyebrow>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px] border-collapse">
              <thead>
                <tr className="text-left font-mono text-[10px] tracking-widest text-faint border-b border-line">
                  <th className="pb-2 pr-3 font-normal">Name</th>
                  <th className="pb-2 pr-3 font-normal">Address</th>
                  <th className="pb-2 pr-3 font-normal">User</th>
                  <th className="pb-2 pr-3 font-normal">Code roots</th>
                  <th className="pb-2 pr-3 font-normal">Enabled</th>
                  <th className="pb-2 pr-3 font-normal">Sync</th>
                  <th className="pb-2 pr-3 font-normal">Last success</th>
                  <th className="pb-2 pr-3 font-normal">Bytes</th>
                  <th className="pb-2 pr-3 font-normal">Duration</th>
                  <th className="pb-2 font-normal">Error</th>
                </tr>
              </thead>
              <tbody>
                {machines.map((m) => (
                  <MachineTableRow key={m.name} m={m} isSelf={m.name === self} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function MachineTableRow({ m, isSelf }: { m: MachineRow; isSelf: boolean }) {
  return (
    <tr className="border-b border-line/60 align-top">
      <td className="py-2 pr-3 font-medium whitespace-nowrap">
        {m.name}
        {isSelf && <span className="ml-1.5 font-mono text-[10px] text-faint">(self)</span>}
      </td>
      <td className="py-2 pr-3 font-mono text-[12px] text-muted whitespace-nowrap">{m.address}</td>
      <td className="py-2 pr-3 text-muted whitespace-nowrap">{m.user}</td>
      <td className="py-2 pr-3 font-mono text-[11px] text-muted">{m.codeRoots.join(', ')}</td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {m.enabled ? (
          <span style={{ color: 'var(--color-git)' }}>enabled</span>
        ) : (
          <span className="text-faint">disabled</span>
        )}
      </td>
      <td className="py-2 pr-3">
        <SyncPill sync={m.sync} />
      </td>
      <td
        className="py-2 pr-3 text-muted whitespace-nowrap"
        title={m.sync?.lastSuccessAt ?? undefined}
      >
        {relativeTime(m.sync?.lastSuccessAt ?? undefined)}
      </td>
      <td className="py-2 pr-3 tabular-nums text-muted whitespace-nowrap">
        {bytes(m.sync?.bytes ?? null)}
      </td>
      <td className="py-2 pr-3 tabular-nums text-muted whitespace-nowrap">
        {millis(m.sync?.durationMs ?? null)}
      </td>
      <td className="py-2 text-[12px]" style={m.sync?.error ? { color: 'var(--color-report)' } : undefined}>
        {m.sync?.error ?? ''}
      </td>
    </tr>
  );
}
