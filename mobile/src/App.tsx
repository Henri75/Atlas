import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, StatusBar, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import * as SplashScreen from 'expo-splash-screen';
import * as Font from 'expo-font';
import {
  IBMPlexSans_400Regular,
  IBMPlexSans_500Medium,
  IBMPlexSans_600SemiBold,
} from '@expo-google-fonts/ibm-plex-sans';
import {
  IBMPlexSansCondensed_600SemiBold,
  IBMPlexSansCondensed_700Bold,
} from '@expo-google-fonts/ibm-plex-sans-condensed';
import { IBMPlexMono_400Regular, IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono';
import { isView, type View as ViewKey } from '@atlas/shared';

/**
 * The Atlas app shell. Boot order matters and is deliberate:
 *
 *   static expo splash (native, instant) → fonts hydrate → animated
 *   SplashOverlay (the amber orbit) fades → the tab shell underneath.
 *
 * The overlay holds only while fonts load; connection state is a thing the UI
 * shows, never a reason to keep hiding it.
 */
import { ServerProvider, useServer } from './state/server';
import { usePersistentState } from './state/prefs';
import { useScope } from './hooks/useScope';
import { RootNavigator } from './navigation/RootNavigator';
import { navigationRef } from './navigation/navigationRef';
import { TopProgressBar } from './components/TopProgressBar';
import { ToastHost } from './components/Toast';
import { TokenGate } from './components/TokenGate';
import { SplashOverlay } from './components/Splash';
import { EntryHostProvider, useEntryHost } from './components/EntryHost';
import { colors } from './theme';

// Hold the native splash until fonts are ready so its handoff to the animated
// overlay is seamless rather than a flash of unstyled content.
SplashScreen.preventAutoHideAsync().catch(() => {});

const linking = {
  prefixes: ['atlas://'],
  config: {
    screens: {
      sessions: {
        screens: {
          sessionDetail: 'session/:id',
        },
      },
    },
  },
};

export default function App() {
  const [fontsLoaded] = Font.useFonts({
    IBMPlexSans_400Regular,
    IBMPlexSans_500Medium,
    IBMPlexSans_600SemiBold,
    IBMPlexSansCondensed_600SemiBold,
    IBMPlexSansCondensed_700Bold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
  });

  useEffect(() => {
    if (fontsLoaded) void SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded]);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <ServerProvider>
        <EntryHostProvider>
          <Shell fontsLoaded={fontsLoaded} />
          <TopProgressBar />
          <ToastHost />
        </EntryHostProvider>
      </ServerProvider>
    </SafeAreaProvider>
  );
}

function Shell({ fontsLoaded }: { fontsLoaded: boolean }) {
  const server = useServer();
  const scope = useScope();
  const [favorites, setFavorites] = usePersistentState<string[]>('atlas.projects.favorites', []);
  // Read once at mount: rewriting `startView` on change would teleport you out
  // of whatever you were reading when you set it (web App.tsx's rule).
  const [storedStartView] = usePersistentState<ViewKey>('atlas.startView', 'search');
  const startView = useRef<ViewKey>(isView(storedStartView) ? storedStartView : 'search');

  const toggleFavorite = useCallback(
    (slug: string) =>
      setFavorites((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug])),
    [setFavorites],
  );

  // Honor the persisted start view once, after boot. Views living under More
  // land on their screen inside that stack, not just the menu.
  const navigatedForStartView = useRef(false);
  useEffect(() => {
    if (!fontsLoaded || !navigationRef.isReady() || navigatedForStartView.current) return;
    navigatedForStartView.current = true;
    const target = TAB_FOR_VIEW[startView.current];
    if (!target || target === 'search') return;
    const sub = MORE_SUBVIEW[startView.current];
    const nav = navigationRef as unknown as { navigate: (...args: unknown[]) => void };
    if (sub && target === 'more') {
      nav.navigate('more', { screen: sub });
    } else {
      nav.navigate(target);
    }
  }, [fontsLoaded]);

  // Deep links: atlas://entry/<id> opens the shared record sheet.
  const entryHost = useEntryHost();
  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url) return;
      const m = /^atlas:\/\/entry\/(\d+)/.exec(url);
      if (m) entryHost.openEntry(Number(m[1]));
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => sub.remove();
  }, [entryHost]);

  const content = useMemo(
    () => (
      <RootNavigator
        scope={scope}
        projects={server.projects}
        favorites={favorites}
        onToggleFavorite={toggleFavorite}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope.projects, server.projects, favorites],
  );

  return (
    <NavigationContainer ref={navigationRef} linking={linking}>
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {!server.needsToken ? content : <TokenGate />}
        <SplashOverlay done={fontsLoaded} />
      </View>
    </NavigationContainer>
  );
}

const TAB_FOR_VIEW: Partial<Record<ViewKey, string>> = {
  search: 'search',
  dashboard: 'overview',
  timeline: 'timeline',
  sessions: 'sessions',
  components: 'more',
  monitor: 'more',
  machines: 'more',
};

const MORE_SUBVIEW: Partial<Record<ViewKey, string>> = {
  components: 'components',
  monitor: 'monitor',
  machines: 'machines',
};
