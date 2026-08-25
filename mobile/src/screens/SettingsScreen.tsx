import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { isView, VIEWS, type View as AtlasView } from '@atlas/shared';
import { DEFAULT_BASE_URL, probe, useServer } from '../state/server';
import { usePersistentState } from '../state/prefs';
import { toast } from '../components/Toast';
import { Eyebrow } from '../components/atoms';
import { api } from '../api/endpoints';
import { colors, fonts, tint } from '../theme';

/**
 * Preferences and connection. Settings are not a way of looking at your
 * projects — on the web they live in a rail menu; on a phone they get a real
 * screen, because a phone also needs what the web never does: WHERE the API
 * lives, and the bearer token for a LAN-exposed instance.
 */
export function SettingsScreen() {
  const { baseUrl, setBaseUrl, token, setToken, refresh } = useServer();
  const [startView, setStartView] = usePersistentState<AtlasView>('atlas.startView', 'search');
  const [urlDraft, setUrlDraft] = useState(baseUrl);
  const [tokenDraft, setTokenDraft] = useState('');
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState('');

  useEffect(() => {
    setUrlDraft(baseUrl);
  }, [baseUrl]);

  const saveUrl = () => {
    let clean = urlDraft.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(clean)) clean = `http://${clean}`;
    if (!clean) return;
    setBaseUrl(clean);
    toast('Server saved — reconnecting…');
    setTimeout(refresh, 300);
  };

  const saveToken = () => {
    const t = tokenDraft.trim();
    setToken(t || null);
    setTokenDraft('');
    toast(t ? 'Token saved.' : 'Token cleared.');
    setTimeout(refresh, 200);
  };

  const runProbe = async () => {
    saveUrlIfChanged();
    setProbing(true);
    const r = await probe(urlDraft.trim() || baseUrl, token);
    setProbing(false);
    setProbeResult(`${r.ok ? '✓' : '✕'} ${r.detail}`);
  };

  const saveUrlIfChanged = () => {
    const clean = urlDraft.trim().replace(/\/+$/, '');
    if (clean && clean !== baseUrl) setBaseUrl(clean);
  };

  const reindex = async () => {
    try {
      await api.reindex({});
      toast('Reindex triggered — new content appears within a few minutes.');
    } catch (e) {
      toast(`Reindex failed: ${(e as Error).message}`);
    }
  };

  const copyDiagnostics = () => {
    void Clipboard.setStringAsync(
      `Atlas mobile diagnostics\nserver: ${baseUrl}\ntoken: ${token ? 'set' : 'none'}\n`,
    ).then(() => toast('Diagnostics copied'));
  };

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 48 }}>
      <Text style={{ fontFamily: fonts.display, fontSize: 20, fontWeight: '600' }}>Settings</Text>

      {/* Server */}
      <View style={{ marginTop: 20 }}>
        <Eyebrow>Server</Eyebrow>
        <Text style={help}>
          The Atlas web UI's address, reachable from this device. On this Mac:{' '}
          <Text style={{ fontFamily: fonts.mono }}>{DEFAULT_BASE_URL}</Text>. From another device
          use the Mac's LAN IP with the same port.
        </Text>
        <TextInput
          value={urlDraft}
          onChangeText={setUrlDraft}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://192.168.1.20:8712"
          placeholderTextColor={colors.faint}
          accessibilityLabel="Server address"
          style={input}
        />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <SmallButton label="Save" onPress={saveUrl} />
          <SmallButton label={probing ? 'Testing…' : 'Test connection'} onPress={() => void runProbe()} disabled={probing} />
        </View>
        {probeResult ? (
          <Text selectable style={{ fontFamily: fonts.mono, fontSize: 11, marginTop: 8, color: probeResult.startsWith('✓') ? colors.git : colors.report }}>
            {probeResult}
          </Text>
        ) : null}

        <Text style={[help, { marginTop: 14 }]}>
          Bearer token — needed only when the instance is LAN-exposed (`atlas connect` prints it).
          Stored in the device Keychain/Keystore.
        </Text>
        <TextInput
          value={tokenDraft}
          onChangeText={setTokenDraft}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={token ? '•••••••• (stored)' : 'Bearer token'}
          placeholderTextColor={colors.faint}
          accessibilityLabel="Bearer token"
          style={input}
        />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <SmallButton label="Save token" onPress={saveToken} />
          {token ? (
            <SmallButton label="Remove token" onPress={() => setToken(null)} danger />
          ) : null}
        </View>
      </View>

      {/* Start view */}
      <View style={{ marginTop: 26 }}>
        <Eyebrow>Open Atlas on</Eyebrow>
        {VIEWS.map((v) => {
          const on = startView === v.key;
          return (
            <Pressable
              key={v.key}
              onPress={() => {
                if (!isView(v.key)) return;
                setStartView(v.key as AtlasView);
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingHorizontal: 10,
                paddingVertical: 10,
                borderRadius: 8,
                backgroundColor: pressed ? colors.panel2 : 'transparent',
              })}
            >
              <Text style={{ width: 18, textAlign: 'center', fontSize: 12, opacity: 0.8 }}>{v.icon}</Text>
              <Text style={{ flex: 1, fontSize: 13.5, color: on ? colors.ink : colors.muted }}>{v.label}</Text>
              <View
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 5,
                  backgroundColor: on ? colors.kdb : 'transparent',
                  borderWidth: 1,
                  borderColor: on ? colors.kdb : colors.faint,
                }}
              />
            </Pressable>
          );
        })}
        <Text style={[help, { marginTop: 6 }]}>Applies at the next launch.</Text>
      </View>

      {/* Operations */}
      <View style={{ marginTop: 26 }}>
        <Eyebrow>Operations</Eyebrow>
        <SmallButton label="Reindex now" onPress={() => void reindex()} wide />
        <Text style={[help, { marginTop: 6 }]}>
          Enqueues a full scan; new content appears within a few minutes.
        </Text>
      </View>

      {/* About */}
      <View style={{ marginTop: 26 }}>
        <Eyebrow>About</Eyebrow>
        <Text style={help}>
          Atlas mobile 1.0 — the native companion to the Atlas web UI: cross-project memory,
          searchable. Search & Ask, Timeline, Sessions, Components, Monitor and Machines in one
          app.
        </Text>
        <SmallButton label="Copy connection diagnostics" onPress={copyDiagnostics} wide />
      </View>
    </ScrollView>
  );
}

const input = {
  backgroundColor: colors.panel,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: colors.line,
  borderRadius: 8,
  paddingHorizontal: 12,
  paddingVertical: 9,
  color: colors.ink,
  fontSize: 13.5,
  fontFamily: fonts.mono,
} as const;

const help = {
  fontSize: 12,
  lineHeight: 17,
  color: colors.faint,
  marginBottom: 8,
} as const;

function SmallButton({
  label,
  onPress,
  disabled,
  danger,
  wide,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
  wide?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => ({
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: danger ? tint(colors.report, 45) : colors.line,
        backgroundColor: danger ? tint(colors.report, 8) : colors.panel2,
        paddingHorizontal: 14,
        paddingVertical: 9,
        alignItems: 'center',
        alignSelf: wide ? 'stretch' : 'auto',
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ fontSize: 13, color: colors.ink }}>{label}</Text>
    </Pressable>
  );
}
