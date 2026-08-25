import { useEffect, useRef, type ReactNode } from 'react';
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
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const y = useRef(new Animated.Value(height)).current;
  const scrim = useRef(new Animated.Value(0)).current;
  const visible = useRef(false);

  useEffect(() => {
    if (open && !visible.current) {
      visible.current = true;
      y.setValue(height);
      Animated.parallel([
        Animated.spring(y, {
          toValue: 0,
          bounciness: 6,
          speed: 20,
          useNativeDriver: true,
        }),
        Animated.timing(scrim, { toValue: 1, duration: 180, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      ]).start();
    } else if (!open && visible.current) {
      visible.current = false;
      Animated.parallel([
        Animated.timing(y, { toValue: height, duration: 200, easing: Easing.in(Easing.ease), useNativeDriver: true }),
        Animated.timing(scrim, { toValue: 0, duration: 160, useNativeDriver: true }),
      ]).start();
    }
  }, [open, height, y, scrim]);

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
          visible.current = false;
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

  if (!open && !visible.current) return null;

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
        <View {...pan.panHandlers} style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 2 }}>
          <View style={{ width: 40, height: 4.5, borderRadius: 3, backgroundColor: colors.line }} />
        </View>
        {title ? (
          <View
            style={{
              paddingHorizontal: 20,
              paddingTop: 8,
              paddingBottom: 10,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: colors.line,
            }}
          >
            <View accessible accessibilityRole="header">
              {title}
            </View>
          </View>
        ) : null}
        <View style={{ flexShrink: 1 }}>
          {typeof children === 'function' ? children(onClose) : children}
        </View>
      </Animated.View>
    </View>
  );
}
