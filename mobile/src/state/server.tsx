import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import {
  ACCESS_REJECTED,
  atlasHeaders,
  configureTransport,
  isAccessRejection,
  onUnauthorized,
  type AccessCredentials,
} from '../api/client';
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
/** Cloudflare Access service token — a secret, so Keychain like the bearer. */
const ACCESS_ID_KEY = 'atlasAccessClientId';
const ACCESS_SECRET_KEY = 'atlasAccessClientSecret';

export interface ProjectsStats {
  projects: ProjectRow[];
  stats: import('@atlas/shared').Stats | null;
}

interface ServerState extends ProjectsStats {
  baseUrl: string;
  setBaseUrl: (url: string) => void;
  token: string | null;
  setToken: (t: string | null) => void;
  /** Cloudflare Access service token, when this instance sits behind Access. */
  access: AccessCredentials | null;
  setAccess: (a: AccessCredentials | null) => void;
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
  const [access, setAccessState] = useState<AccessCredentials | null>(null);
  const [ready, setReady] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);
  const [offline, setOffline] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [stats, setStats] = useState<import('@atlas/shared').Stats | null>(null);

  // Hydrate once.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [storedUrl, storedToken, accessId, accessSecret] = await Promise.all([
        AsyncStorage.getItem(BASE_URL_KEY),
        SecureStore.getItemAsync(TOKEN_KEY).catch(() => null),
        SecureStore.getItemAsync(ACCESS_ID_KEY).catch(() => null),
        SecureStore.getItemAsync(ACCESS_SECRET_KEY).catch(() => null),
      ]);
      if (!alive) return;
      if (storedUrl) setBaseUrlState(storedUrl);
      if (storedToken) setTokenState(storedToken);
      // Half a service token is not a service token — send neither.
      if (accessId && accessSecret) setAccessState({ clientId: accessId, clientSecret: accessSecret });
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

  const setAccess = useCallback((a: AccessCredentials | null) => {
    setAccessState(a);
    if (a) {
      void SecureStore.setItemAsync(ACCESS_ID_KEY, a.clientId).catch(() => {});
      void SecureStore.setItemAsync(ACCESS_SECRET_KEY, a.clientSecret).catch(() => {});
    } else {
      void SecureStore.deleteItemAsync(ACCESS_ID_KEY).catch(() => {});
      void SecureStore.deleteItemAsync(ACCESS_SECRET_KEY).catch(() => {});
    }
  }, []);

  /**
   * Wire the transport to this state.
   *
   * The getters close over a ref rather than the render's values so the
   * transport is correct from the first call: a child screen's effect runs
   * BEFORE its parent's, so a screen that fetches on mount would otherwise
   * fire against whatever this effect had last written — on the very first
   * mount, nothing at all.
   */
  const live = useRef({ baseUrl, token, access });
  live.current = { baseUrl, token, access };
  configureTransport({
    getBaseUrl: () => live.current.baseUrl,
    getToken: () => live.current.token,
    getAccess: () => live.current.access,
  });

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
      access,
      setAccess,
      ready,
      needsToken,
      clearNeedsToken: () => setNeedsToken(false),
      offline,
      refresh,
      projects,
      stats,
    }),
    [baseUrl, setBaseUrl, token, setToken, access, setAccess, ready, needsToken, offline, refresh, projects, stats],
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServer(): ServerState {
  const v = useContext(ServerContext);
  if (!v) throw new Error('useServer outside ServerProvider');
  return v;
}

/** Probe helper for Settings ("Test connection"). */
export async function probe(
  baseUrl: string,
  token: string | null,
  access: AccessCredentials | null = null,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/stats`, {
      headers: atlasHeaders(token, access),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Naming which layer said no is the whole value of a connection test:
      // "401" alone sends people to re-enter a bearer token that was correct.
      if (isAccessRejection(res.status, res.headers, body)) {
        return { ok: false, detail: ACCESS_REJECTED };
      }
      if (res.status === 401) {
        return { ok: false, detail: 'Reached the instance, but the bearer token was rejected.' };
      }
      return { ok: false, detail: `HTTP ${res.status}` };
    }
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
