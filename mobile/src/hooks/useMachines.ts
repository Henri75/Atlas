import { useEffect, useState } from 'react';
import type { MachineRow, MachinesResponse } from '@atlas/shared';
import { api } from '../api/endpoints';

/**
 * The fleet, fetched once and shared by every surface that needs to know
 * "is this a multi-machine install?" — the search machine filter, hit-row
 * badges, the entry sheet, the dashboard cards and the Machines view.
 * (`multiMachine` gates on fleet size ≥ 2, exactly like the web.)
 */
export interface UseMachines {
  self: string;
  machines: MachineRow[];
  multiMachine: boolean;
  loading: boolean;
  error: string;
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
          if (!alive) return;
          setError(e.message);
        });
    void load();
    if (!pollMs) return () => {
      alive = false;
    };
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
