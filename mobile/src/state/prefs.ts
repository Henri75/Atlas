import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * State that survives a relaunch — the AsyncStorage twin of the web's
 * usePersistentState (same keys, same JSON encoding, same guarded fallbacks).
 * Values are JSON-encoded, so arrays and objects persist as readily as strings.
 */
export function usePersistentState<T>(
  key: string,
  fallback: T,
): [T, (v: T | ((prev: T) => T)) => void, boolean] {
  const [value, setValue] = useState<T>(fallback);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(key)
      .then((raw) => {
        if (!alive || raw === null) return;
        try {
          setValue(JSON.parse(raw) as T);
        } catch {
          // A value written before JSON encoding is treated as the raw text.
          setValue(raw as unknown as T);
        }
      })
      .finally(() => alive && setHydrated(true));
    return () => {
      alive = false;
    };
  }, [key]);

  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        void AsyncStorage.setItem(key, JSON.stringify(next)).catch(() => {
          // Preference simply won't persist; the UI still works.
        });
        return next;
      });
    },
    [key],
  );

  return [value, set, hydrated];
}

/** One-shot read of a persisted pref (used by non-hook callers). */
export async function readPref<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
