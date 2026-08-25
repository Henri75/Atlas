import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts } from '../theme';

/** One toast at a time; the shell renders it. */
let pushToast: ((msg: string) => void) | null = null;

export function toast(msg: string) {
  pushToast?.(msg);
}

/**
 * The web's toast (bottom-right, `rise`), native: a floating pill above the
 * tab bar, fading in and auto-dismissing. Used for reindex confirmations,
 * copy confirmations and errors that need no action.
 */
export function ToastHost() {
  const [msg, setMsg] = useState('');
  const opacity = useRef(new Animated.Value(0)).current;
  const lift = useRef(new Animated.Value(6)).current;
  const insets = useSafeAreaInsets();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    pushToast = (m: string) => {
      setMsg(m);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 140, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(lift, { toValue: 0, duration: 140, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      ]).start();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 260, useNativeDriver: true }).start(() =>
          setMsg(''),
        );
      }, 4200);
    };
    return () => {
      pushToast = null;
    };
  }, [opacity, lift]);

  if (!msg) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 20,
        right: 20,
        bottom: insets.bottom + 84,
        opacity,
        transform: [{ translateY: lift }],
      }}
    >
      <View
        style={{
          backgroundColor: colors.panel2,
          borderRadius: 10,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
          paddingHorizontal: 14,
          paddingVertical: 10,
          shadowColor: '#000',
          shadowOpacity: 0.35,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: 12,
        }}
      >
        <Text style={{ color: colors.ink, fontSize: 13, lineHeight: 18 }}>{msg}</Text>
      </View>
    </Animated.View>
  );
}
