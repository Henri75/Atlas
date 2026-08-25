import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useServer } from '../state/server';
import { colors, fonts } from '../theme';

/**
 * One-time bearer-token prompt. The shell swaps the entire app for this the
 * moment any API call 401s — meaning the instance is LAN-exposed and the
 * stored token is missing or wrong (spec §7). Saving retries immediately; no
 * reload dance, since the transport reads the token live.
 */
export function TokenGate() {
  const { setToken, clearNeedsToken, refresh } = useServer();
  const [value, setValue] = useState('');

  const save = () => {
    if (!value.trim()) return;
    setToken(value.trim());
    clearNeedsToken();
    setTimeout(refresh, 150);
  };

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: colors.bg }}>
      <View
        style={{
          width: '100%',
          maxWidth: 360,
          backgroundColor: colors.panel,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
          borderRadius: 12,
          padding: 20,
        }}
      >
        <Text style={{ fontFamily: fonts.display, fontSize: 17, fontWeight: '700' }}>Atlas</Text>
        <Text style={{ fontSize: 13, color: colors.muted, lineHeight: 19, marginTop: 8 }}>
          This Atlas instance is LAN-exposed and needs its bearer token — paste the one from{' '}
          <Text style={{ fontFamily: fonts.mono }}>atlas connect</Text>.
        </Text>
        <TextInput
          value={value}
          onChangeText={setValue}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={save}
          placeholder="Bearer token"
          placeholderTextColor={colors.faint}
          accessibilityLabel="Bearer token"
          style={{
            marginTop: 14,
            backgroundColor: colors.panel2,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.line,
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 9,
            color: colors.ink,
            fontFamily: fonts.mono,
            fontSize: 13,
          }}
        />
        <Pressable
          onPress={save}
          accessibilityRole="button"
          style={({ pressed }) => ({
            marginTop: 10,
            backgroundColor: colors.panel2,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: pressed ? colors.faint : colors.line,
            borderRadius: 8,
            paddingVertical: 10,
            alignItems: 'center',
          })}
        >
          <Text style={{ fontSize: 13 }}>Save & retry</Text>
        </Pressable>
      </View>
    </View>
  );
}
