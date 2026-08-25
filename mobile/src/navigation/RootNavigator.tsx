import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { VIEWS } from '@atlas/shared';
import { jumpToTab } from './navigationRef';

/**
 * The native shell.
 *
 * The web's seven-item left rail becomes a five-tab bar: Search & Ask,
 * Overview, Timeline, Sessions, then More holding Components, Monitor and
 * Machines (plus Settings). All seven views are reachable 1:1 — the grouping
 * is the only change, made for thumb reach rather than information loss:
 * the three browse surfaces people live in stay one tap away, and the ops
 * views that answer "is it healthy?" sit one More tap away.
 */
import type { ProjectRow } from '@atlas/shared';
import type { ScopeHandle } from '../hooks/useScope';
import { colors, fonts } from '../theme';
import { SearchAskScreen } from '../screens/SearchAskScreen';
import { DashboardScreen } from '../screens/DashboardScreen';
import { TimelineScreen } from '../screens/TimelineScreen';
import { SessionsScreen, SessionDetailScreen } from '../screens/SessionsScreen';
import { ComponentsScreen } from '../screens/ComponentsScreen';
import { MonitorScreen } from '../screens/monitor/MonitorScreen';
import { MachinesScreen } from '../screens/MachinesScreen';
import { SettingsScreen } from '../screens/SettingsScreen';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const GLYPHS = Object.fromEntries(VIEWS.map((v) => [v.key, v.icon]));

function TabIcon({ glyph, color }: { glyph: string; color: string }) {
  return (
    <Text style={{ fontSize: 17, lineHeight: 20, color }} accessibilityElementsHidden>
      {glyph}
    </Text>
  );
}

function BackRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={{ paddingHorizontal: 16, paddingTop: 10 }}>
      <Text style={{ fontSize: 13, color: colors.muted }}>← {label}</Text>
    </Pressable>
  );
}

export interface RootNavigatorProps {
  scope: ScopeHandle;
  projects: ProjectRow[];
  favorites: string[];
  onToggleFavorite: (slug: string) => void;
}

export function RootNavigator({ scope, projects, favorites, onToggleFavorite }: RootNavigatorProps) {
  return (
    <Tab.Navigator initialRouteName="search" screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: colors.kdb,
      tabBarInactiveTintColor: colors.faint,
      tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.line },
      tabBarLabelStyle: { fontSize: 9.5 },
    }}>
      <Tab.Screen
        name="search"
        options={{
          tabBarLabel: 'Search & Ask',
          tabBarActiveTintColor: colors.kdb,
          tabBarInactiveTintColor: colors.faint,
          tabBarIcon: ({ color }) => <TabIcon glyph={GLYPHS.search ?? '◎'} color={color} />,
        }}
      >
        {() => <SearchStack scope={scope} />}
      </Tab.Screen>
      <Tab.Screen
        name="overview"
        options={{
          tabBarLabel: 'Overview',
          tabBarIcon: ({ color }) => <TabIcon glyph={GLYPHS.dashboard ?? '▤'} color={color} />,
        }}
      >
        {() => <DashboardScreen onGoToSearch={() => jumpToTab('search')} />}
      </Tab.Screen>
      <Tab.Screen
        name="timeline"
        options={{ tabBarLabel: 'Timeline', tabBarIcon: ({ color }) => <TabIcon glyph={GLYPHS.timeline ?? '⋮'} color={color} /> }}
      >
        {() => <TimelineScreen scope={scope} projects={projects} />}
      </Tab.Screen>
      <Tab.Screen
        name="sessions"
        options={{ tabBarLabel: 'Sessions', tabBarIcon: ({ color }) => <TabIcon glyph={GLYPHS.sessions ?? '✳'} color={color} /> }}
      >
        {() => <SessionsStack scope={scope} projects={projects} />}
      </Tab.Screen>
      <Tab.Screen
        name="more"
        options={{ tabBarLabel: 'More', tabBarIcon: ({ color }) => <TabIcon glyph="☰" color={color} /> }}
      >
        {() => (
          <MoreStack scope={scope} projects={projects} favorites={favorites} onToggleFavorite={onToggleFavorite} />
        )}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

/* ------------------------------------------------------------------------ */
/* Per-tab stacks                                                            */
/* ------------------------------------------------------------------------ */

function SearchStack({ scope }: { scope: ScopeHandle }) {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="searchHome">{() => <SearchAskScreen scope={scope} />}</Stack.Screen>
    </Stack.Navigator>
  );
}

function SessionsStack({ scope, projects }: { scope: ScopeHandle; projects: ProjectRow[] }) {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="sessionsHome">
        {({ navigation }) => (
          <SessionsScreen
            scope={scope}
            projects={projects}
            onProject={(slug) => scope.set([slug])}
            onOpenSession={(id) => navigation.navigate('sessionDetail' as never, { id } as never)}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="sessionDetail">
        {({ navigation, route }) => {
          const params = route.params as { id?: string } | undefined;
          return (
            <View style={{ flex: 1 }}>
              <BackRow label="back to sessions" onPress={() => navigation.goBack()} />
              {params?.id ? <SessionDetailScreen sessionId={params.id} /> : null}
            </View>
          );
        }}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

/* ------------------------------------------------------------------------ */
/* More stack: Components · Monitor · Machines · Settings                    */
/* ------------------------------------------------------------------------ */

const MORE_ITEMS = [
  { key: 'components', label: 'Components', icon: GLYPHS.components ?? '◧', hint: 'per-project component histories' },
  { key: 'monitor', label: 'Monitor', icon: GLYPHS.monitor ?? '◔', hint: "Atlas's own traffic and answer quality" },
  { key: 'machines', label: 'Machines', icon: GLYPHS.machines ?? '▣', hint: 'the indexing fleet and sync health' },
  { key: 'settings', label: 'Settings', icon: '⚙', hint: 'server, token, start view, reindex' },
] as const;

function MoreStack({
  scope,
  projects,
  favorites,
  onToggleFavorite,
}: {
  scope: ScopeHandle;
  projects: ProjectRow[];
  favorites: string[];
  onToggleFavorite: (slug: string) => void;
}) {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="moreHome">
        {({ navigation }) => <MoreHome onOpen={(k) => navigation.navigate(k as never)} />}
      </Stack.Screen>
      <Stack.Screen name="components">
        {({ navigation }) => (
          <View style={{ flex: 1 }}>
            <BackRow label="back" onPress={() => navigation.goBack()} />
            <ComponentsScreen
              scope={scope}
              projects={projects}
              onProject={(slug) => scope.set([slug])}
            />
          </View>
        )}
      </Stack.Screen>
      <Stack.Screen name="monitor">
        {({ navigation }) => (
          <View style={{ flex: 1 }}>
            <BackRow label="back" onPress={() => navigation.goBack()} />
            <MonitorScreen />
          </View>
        )}
      </Stack.Screen>
      <Stack.Screen name="machines">
        {({ navigation }) => (
          <View style={{ flex: 1 }}>
            <BackRow label="back" onPress={() => navigation.goBack()} />
            <MachinesScreen />
          </View>
        )}
      </Stack.Screen>
      <Stack.Screen name="settings">
        {({ navigation }) => (
          <View style={{ flex: 1 }}>
            <BackRow label="back" onPress={() => navigation.goBack()} />
            <SettingsScreen />
          </View>
        )}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

function MoreHome({ onOpen }: { onOpen: (key: string) => void }) {
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
        <Text style={{ fontFamily: fonts.display, fontSize: 20, fontWeight: '600' }}>More</Text>
      </View>
      <View style={{ paddingHorizontal: 16, paddingTop: 14, gap: 8 }}>
        {MORE_ITEMS.map((m) => (
          <MoreCard
            key={m.key}
            item={m}
            onOpen={() => {
              Haptics.selectionAsync().catch(() => {});
              onOpen(m.key);
            }}
          />
        ))}
      </View>
    </View>
  );
}

function MoreCard({
  item,
  onOpen,
}: {
  item: (typeof MORE_ITEMS)[number];
  onOpen: () => void;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPress={onOpen}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityRole="button"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: pressed ? colors.faint : colors.line,
        backgroundColor: colors.panel,
        paddingHorizontal: 14,
        paddingVertical: 13,
      }}
    >
      <Text style={{ width: 22, textAlign: 'center', fontSize: 15, opacity: 0.85 }}>{item.icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14.5, fontWeight: '600' }}>{item.label}</Text>
        <Text style={{ fontSize: 11.5, color: colors.muted, marginTop: 1 }}>{item.hint}</Text>
      </View>
      <Text style={{ color: colors.faint }}>›</Text>
    </Pressable>
  );
}
