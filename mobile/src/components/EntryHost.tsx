import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { EntrySheet } from './EntrySheet';
import { useMachines } from '../hooks/useMachines';

/**
 * One shared full-record sheet for the whole app (the web renders one drawer
 * per search view; mobile centralizes it so every surface — hits, timeline
 * rows, ask sources — opens the same overlay, and deep links can drive it).
 */
interface EntryHost {
  openEntryId: number | null;
  openEntry: (id: number) => void;
  closeEntry: () => void;
}

const Ctx = createContext<EntryHost | null>(null);

export function EntryHostProvider({ children }: { children: ReactNode }) {
  const [openEntryId, setOpenEntryId] = useState<number | null>(null);
  const openEntry = useCallback((id: number) => setOpenEntryId(id), []);
  const closeEntry = useCallback(() => setOpenEntryId(null), []);
  const value = useMemo(() => ({ openEntryId, openEntry, closeEntry }), [openEntryId, openEntry, closeEntry]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <HostedSheet />
    </Ctx.Provider>
  );
}

function HostedSheet() {
  const { openEntryId, closeEntry } = useContext(Ctx)!;
  // Same fleet-size gate as the hit-row badge: a single-machine install shows
  // nothing new in the record view.
  const { multiMachine } = useMachines();
  return <EntrySheet entryId={openEntryId} onClose={closeEntry} multiMachine={multiMachine} />;
}

export function useEntryHost(): EntryHost {
  const v = useContext(Ctx);
  if (!v) throw new Error('useEntryHost outside EntryHostProvider');
  return v;
}
