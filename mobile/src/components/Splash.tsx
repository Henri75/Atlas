import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, tint } from '../theme';

/**
 * The boot screen. Expo's static splash hands off to this: the same dark
 * field and amber mark keep the transition seamless, then the mark comes
 * alive — an orbiting satellite around the lens — until first data resolves.
 * Motion is the point: it says "the app is alive and reaching for your
 * server", which a frozen logo cannot.
 */

/** The Atlas mark: a geometric lens/orbit, drawn (no image asset needed). */
export function AtlasMark({ size = 96, spin = false }: { size?: number; spin?: boolean }) {
  const rotation = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!spin) return;
    const loop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 2600,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin, rotation]);

  const ring = size;
  const dot = Math.max(5, size * 0.09);

  return (
    <View style={{ width: ring + dot * 2, height: ring + dot * 2, alignItems: 'center', justifyContent: 'center' }}>
      {/* Outer orbit ring */}
      <View
        style={{
          position: 'absolute',
          width: ring,
          height: ring,
          borderRadius: ring / 2,
          borderWidth: Math.max(1.5, size * 0.03),
          borderColor: tint(colors.kdb, 55),
        }}
      />
      {/* Inner pupil */}
      <View
        style={{
          width: ring * 0.42,
          height: ring * 0.42,
          borderRadius: ring * 0.21,
          borderWidth: Math.max(1.5, size * 0.035),
          borderColor: colors.kdb,
        }}
      />
      {/* Orbiting satellite */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: ring + dot * 2,
          height: ring + dot * 2,
          alignItems: 'center',
          justifyContent: 'flex-start',
          transform: [
            {
              rotate: rotation.interpolate({
                inputRange: [0, 1],
                outputRange: ['0deg', '360deg'],
              }),
            },
          ],
        }}
      >
        <View
          style={{
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: colors.kdb,
            shadowColor: colors.kdb,
            shadowOpacity: 0.9,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 0 },
          }}
        />
      </Animated.View>
    </View>
  );
}

/**
 * Full-screen animated splash shown while fonts load and the first projects/
 * stats fetch runs (minimum dwell so it never flashes past unreadably).
 */
export function SplashOverlay({ done }: { done: boolean }) {
  const fade = useRef(new Animated.Value(1)).current;
  const wordmark = useRef(new Animated.Value(0)).current;
  const minDwell = useRef(Date.now() + 900);

  useEffect(() => {
    Animated.timing(wordmark, {
      toValue: 1,
      duration: 500,
      delay: 150,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [wordmark]);

  useEffect(() => {
    if (!done) return;
    const wait = Math.max(0, minDwell.current - Date.now());
    const t = setTimeout(() => {
      Animated.timing(fade, {
        toValue: 0,
        duration: 320,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    }, wait);
    return () => clearTimeout(t);
  }, [done, fade]);

  return (
    <Animated.View
      pointerEvents={done ? 'none' : 'auto'}
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: colors.bg,
          opacity: fade,
          zIndex: 2000,
          alignItems: 'center',
          justifyContent: 'center',
        },
      ]}
    >
      <AtlasMark size={92} spin />
      <Animated.View style={{ opacity: wordmark, alignItems: 'center', marginTop: 22 }}>
        <Text style={{ fontFamily: fonts.displayBold, fontSize: 26, letterSpacing: 3 }}>Atlas</Text>
        <Text style={{ fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 1.5, color: colors.faint, marginTop: 4 }}>
          project memory, searchable
        </Text>
      </Animated.View>
    </Animated.View>
  );
}
