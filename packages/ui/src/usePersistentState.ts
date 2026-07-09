import { useCallback, useState } from 'react';

/**
 * State that survives a reload. Guarded because localStorage throws in a
 * sandboxed iframe and in private-mode Safari — a preference is never worth
 * taking the page down for.
 */
export function usePersistentState<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T | null) ?? fallback;
    } catch {
      return fallback;
    }
  });

  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        // Preference simply won't persist; the UI still works.
      }
    },
    [key],
  );

  return [value, set];
}
