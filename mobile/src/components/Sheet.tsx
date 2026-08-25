import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  PanResponder,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme';

/**
 * A bottom sheet: the native form of the web's EntryDrawer / CallDrawer.
 * Slides up on a spring with a dimmed scrim, drags to dismiss, and Android's
 * back button closes it. The list underneath stays mounted as context — the
 * reason the web overlays rather than navigates, kept intact.
 *
 * Mount discipline: `mounted` state gates rendering so the EXIT animation
 * plays in full and only then unmounts — gating on the `open` prop alone
 * would either kill the animation mid-flight or leak the view off-screen.
 */
export function Sheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Receives `close` so inner controls dismiss with the same animation. */
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const y = useRef(new Animated.Value(height)).current;
  const scrim = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      y.setValue(height);
      Animated.parallel([
        Animated.spring(y, { toValue: 0, bounciness: 6, speed: 20, useNativeDriver: true }),
        Animated.timing(scrim, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(y, {
          toValue: height,
          duration: 200,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(scrim, { toValue: 0, duration: 160, useNativeDriver: true }),
      ]).start(() => setMounted(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Android hardware back closes the sheet first.
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_e, g) => {
        if (g.dy > 0) y.setValue(g.dy);
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > height * 0.18 || g.vy > 0.9) {
          Animated.timing(y, { toValue: height, duration: 190, useNativeDriver: true }).start(() =>
            onClose(),
          );
          Animated.timing(scrim, { toValue: 0, duration: 150, useNativeDriver: true }).start();
        } else {
          Animated.spring(y, { toValue: 0, bounciness: 5, speed: 22, useNativeDriver: true }).start();
        }
      },
    }),
  ).current;

  if (!mounted) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay, opacity: scrim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
      </Animated.View>
      <Animated.View
        {...pan.panHandlers}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: height - insets.top - 64,
          transform: [{ translateY: y }],
          backgroundColor: colors.bg,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.line,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          paddingBottom: insets.bottom,
          shadowColor: '#000',
          shadowOpacity: 0.4,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: -8 },
          elevation: 24,
        }}
      >
        <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 2 }}>
          <View style={{ width: 40, height: 4.5, borderRadius: 3, backgroundColor: colors.line }} />
        </View>
        <View style={{ flexShrink: 1 }}>{typeof children === 'function' ? children(onClose) : children}</View>
      </Animated.View>
    </View>
  );
}
