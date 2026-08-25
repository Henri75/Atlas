import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { configureTransport, onUnauthorized, transport } from '../api/client';
import { api } from '../api/endpoints';
import type { ProjectRow } from '@atlas/shared';

/**
 * The server connection: base URL + bearer token + the projects/stats every
 * screen shares (the web's App-level refresh loop, moved into a provider).
 *
 * The token is a secret on a phone — it lives in SecureStore (Keychain /
 * Keystore), not AsyncStorage. A 401 from any call flips `needsToken` and the
 * shell raises the TokenGate, exactly like the web's atlas:unauthorized event.
 */

const BASE_URL_KEY = 'atlas.server.baseUrl';
const TOKEN_KEY = 'atlasToken';

export interface ProjectsStats {
  projects: ProjectRow[];
  stats: import('@atlas/shared').Stats | null;
}

interface ServerState extends ProjectsStats {
  baseUrl: string;
  setBaseUrl: (url: string) => void;
  token: string | null;
  setToken: (t: string | null) => void;
  /** True while the first baseUrl/token read is still in flight. */
  ready: boolean;
  /** Any API call 401'd → raise the gate. */
  needsToken: boolean;
  clearNeedsToken: () => void;
  offline: boolean;
  refresh: () => void;
}

const ServerContext = createContext<ServerState | null>(null);

/** Loopback default: what Expo Go / a simulator can reach on the same Mac. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8712';

export function ServerProvider({ children }: { children: ReactNode }) {
  const [baseUrl, setBaseUrlState] = useState(DEFAULT_BASE_URL);
  const [token, setTokenState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);
  const [offline, setOffline] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [stats, setStats] = useState<import('@atlas/shared').Stats | null>(null);

  // Hydrate once.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [storedUrl, storedToken] = await Promise.all([
        AsyncStorage.getItem(BASE_URL_KEY),
        SecureStore.getItemAsync(TOKEN_KEY).catch(() => null),
      ]);
      if (!alive) return;
      if (storedUrl) setBaseUrlState(storedUrl);
      if (storedToken) setTokenState(storedToken);
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setBaseUrl = useCallback((url: string) => {
    const clean = url.trim().replace(/\/+$/, '');
    setBaseUrlState(clean);
    void AsyncStorage.setItem(BASE_URL_KEY, clean);
    setNeedsToken(false);
    setOffline(false);
  }, []);

  const setToken = useCallback((t: string | null) => {
    setTokenState(t);
    if (t) void SecureStore.setItemAsync(TOKEN_KEY, t).catch(() => {});
    else void SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
  }, []);

  // Wire the transport to this state (called once; reads via getters below).
  useEffect(() => {
    configureTransport({ getBaseUrl: () => baseUrl, getToken: () => token });
  }, [baseUrl, token]);

  useEffect(
    () =>
      onUnauthorized(() => setNeedsToken(true)),
    [],
  );

  /**
   * "No projects" and "cannot reach the API" must not look the same — that
   * ambiguity made a dead backend look like an empty index (web App.tsx).
   */
  const refresh = useCallback(() => {
    void Promise.all([api.projects(), api.stats()])
      .then(([p, s]) => {
        setProjects(p);
        setStats(s);
        setOffline(false);
      })
      .catch(() => setOffline(true));
  }, []);

  useEffect(() => {
    if (!ready) return;
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [ready, refresh]);

  const value = useMemo<ServerState>(
    () => ({
      baseUrl,
      setBaseUrl,
      token,
      setToken,
      ready,
      needsToken,
      clearNeedsToken: () => setNeedsToken(false),
      offline,
      refresh,
      projects,
      stats,
    }),
    [baseUrl, setBaseUrl, token, setToken, ready, needsToken, offline, refresh, projects, stats],
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServer(): ServerState {
  const v = useContext(ServerContext);
  if (!v) throw new Error('useServer outside ServerProvider');
  return v;
}

/** Probe helper for Settings ("Test connection"). */
export async function probe(baseUrl: string, token: string | null): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/stats`, {
      headers: {
        'x-atlas-client': 'mobile',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (res.status === 401) return { ok: false, detail: 'Reached the instance, but the token was rejected.' };
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: 'Connected.' };
  } catch (e) {
    return { ok: false, detail: describe(e) };
  }
}

function describe(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  return /network request failed|failed to fetch/i.test(m)
    ? 'Could not connect. Is the stack running and reachable from this device?'
    : m.slice(0, 160);
}
