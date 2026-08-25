import { Pressable, StyleSheet, TextInput, View, Text } from 'react-native';
import { colors } from '../theme';
import { CountCaption } from './atoms';

/**
 * Client-side filter box with a clear affordance and the "showing N of M"
 * caption — silence about what a filter hid is its own bug (web FilterInput).
 */
export function FilterInput({
  value,
  onChange,
  placeholder,
  count,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  count?: { shown: number; total: number };
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        accessibilityLabel={placeholder}
        autoCorrect={false}
        autoCapitalize="none"
        style={{
          flex: 1,
          backgroundColor: colors.panel,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
          borderRadius: 8,
          paddingHorizontal: 12,
          paddingVertical: 7,
          fontSize: 13,
          color: colors.ink,
        }}
      />
      {value ? (
        <Pressable onPress={() => onChange('')} hitSlop={6}>
          <Text style={{ fontSize: 12, color: colors.muted }}>clear</Text>
        </Pressable>
      ) : null}
      {count ? <CountCaption shown={count.shown} total={count.total} /> : null}
    </View>
  );
}
