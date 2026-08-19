import { useEffect, useState } from 'react';
import { api } from './api';
import type { MachineRow, MachinesResponse } from './types';

/**
 * The fleet, fetched once and shared by every surface that needs to know
 * "is this a multi-machine install?" — the search dropdown, hit-row badges,
 * the entry drawer, the dashboard cards and the Machines view itself.
 *
 * `multiMachine` is the one flag all of those actually branch on: a
 * single-machine install (`machines.length < 2`, which covers both legacy
 * mode's empty array and a freshly-configured one-machine fleet) must look
 * exactly as it did before the fleet feature existed — no dropdown, no
 * badges, no dashboard cards. Fleet size is the gate, not `fleet !== null`,
 * because a fleet of one has nothing to disambiguate either.
 */
export interface UseMachines {
  self: string;
  machines: MachineRow[];
  multiMachine: boolean;
  loading: boolean;
  error: string;
  /** Absent in legacy mode; callers fall back to their own default. */
  syncIntervalMin: number | undefined;
}

export function useMachines(pollMs = 0): UseMachines {
  const [data, setData] = useState<MachinesResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .machines()
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError('');
        })
        .catch((e: Error) => {
          if (alive) setError(e.message);
        });
    void load();
    if (!pollMs) return () => { alive = false; };
    const t = setInterval(load, pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pollMs]);

  const machines = data?.machines ?? [];
  return {
    self: data?.self ?? '',
    machines,
    multiMachine: machines.length >= 2,
    loading: data === null && !error,
    error,
    syncIntervalMin: data?.syncIntervalMin,
  };
}
