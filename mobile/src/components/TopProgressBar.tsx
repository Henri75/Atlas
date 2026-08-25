import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme';
import { loadingBus } from '../api/loadingBus';

/**
 * THE loading indicator for data: a thin amber bar sweeping left→right at the
 * very top of the screen while any request is in flight. Subscribed to the
 * transport's loading bus, so it needs no wiring per screen — if bytes may be
 * moving, this says so.
 *
 * The sweep is an indeterminate loop that runs only while active; it fades out
 * rather than vanishing, so a fast response reads as a flick of motion rather
 * than a glitch.
 */
export function TopProgressBar() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const x = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const sweep = useRef<Animated.CompositeAnimation | null>(null);
  const active = useRef(false);

  useEffect(() => {
    return loadingBus.subscribe((nowActive) => {
      if (nowActive && !active.current) {
        active.current = true;
        Animated.timing(opacity, { toValue: 1, duration: 120, useNativeDriver: true }).start();
        sweep.current?.stop();
        sweep.current = Animated.loop(
          Animated.sequence([
            Animated.timing(x, {
              toValue: 1,
              duration: 1100,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(x, {
              toValue: 0,
              duration: 0,
              useNativeDriver: true,
            }),
          ]),
        );
        sweep.current.start();
      } else if (!nowActive && active.current) {
        active.current = false;
        sweep.current?.stop();
        sweep.current = null;
        setTimeout(() => {
          if (!active.current) {
            Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }).start();
          }
        }, 240);
      }
    });
  }, [x, opacity]);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: insets.top,
        left: 0,
        right: 0,
        height: 2.5,
        opacity,
        zIndex: 1000,
        overflow: 'hidden',
      }}
    >
      <View style={StyleSheet.absoluteFill} />
      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          width: width * 0.45,
          transform: [
            {
              translateX: x.interpolate({
                inputRange: [0, 1],
                outputRange: [-width * 0.45, width],
              }),
            },
          ],
          backgroundColor: colors.kdb,
          borderRadius: 2,
          shadowColor: colors.kdb,
          shadowOpacity: 0.8,
          shadowRadius: 4,
          shadowOffset: { width: 0, height: 0 },
        }}
      />
    </Animated.View>
  );
}
