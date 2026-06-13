// Gauntlet demo + visual-match target: faithful reproduction of the mood-app
// flow from a reference video (Downloads/ssstwitter…1781352368561.mp4). Goal is
// visual identity — real iOS 26 liquid glass (expo-glass-effect), a soft Skia
// bloom, matched arch/star, warm palette, and the emotion→context chip
// crossfade. Driven + validated with ennio (assertScreenConformance +
// assertScreenMatches overlay).
//
// The Skia glow + the native GlassView are Fabric components that render under
// ennio injection now that the Fabric mount-method swizzle was removed.

import { Canvas, RadialGradient, Rect, vec } from '@shopify/react-native-skia';
import { Stack } from 'expo-router';
import { GlassContainer, GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { PressableScale } from 'pressto';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

const EMOTIONS = [
  'Amazed', 'Amused', 'Brave', 'Calm', 'Confident', 'Content',
  'Excited', 'Grateful', 'Happy', 'Hopeful', 'Indifferent', 'Joyful',
  'Passionate', 'Peaceful', 'Proud', 'Relieved', 'Satisfied', 'Surprised',
];

const CONTEXT = [
  'Community', 'Current Events', 'Dating', 'Education', 'Family', 'Fitness',
  'Friends', 'Health', 'Hobbies', 'Identity', 'Money', 'Partner',
  'Self Care', 'Spirituality', 'Tasks', 'Travel', 'Weather', 'Work',
];

const GOLD = '#E8C45A';
const TEXT = 'rgba(245,240,228,0.92)';
const CROSSFADE_MS = 220;
const GLASS_OK = isLiquidGlassAvailable();

function Chip({ label, selected }: { label: string; selected?: boolean }) {
  return (
    <PressableScale testID={`tag-${label}`} style={styles.chipWrap}>
      {GLASS_OK ? (
        <GlassView
          glassEffectStyle="regular"
          colorScheme="dark"
          isInteractive
          tintColor={selected ? 'rgba(216,183,58,0.5)' : 'rgba(48,42,24,0.22)'}
          style={[styles.chip, selected && styles.chipSelected]}
        >
          <Text style={[styles.chipText, selected && styles.chipTextSel]}>{label}</Text>
        </GlassView>
      ) : (
        <View style={[styles.chip, styles.chipFallback, selected && styles.chipSelected]}>
          <Text style={[styles.chipText, selected && styles.chipTextSel]}>{label}</Text>
        </View>
      )}
    </PressableScale>
  );
}

function ChipField({ tags, selected }: { tags: string[]; selected?: string }) {
  const body = (
    <View style={styles.tags}>
      {tags.map((t) => (
        <Chip key={t} label={t} selected={t === selected} />
      ))}
    </View>
  );
  return GLASS_OK ? <GlassContainer spacing={8} style={styles.field}>{body}</GlassContainer> : body;
}

export default function MoodContext() {
  const { width: W, height: H } = useWindowDimensions();
  const [mode, setMode] = useState<'emotion' | 'context'>('emotion');
  const t = useSharedValue(0);

  const showContext = useCallback(() => {
    setMode('context');
    t.value = withTiming(1, { duration: CROSSFADE_MS, easing: Easing.inOut(Easing.ease) });
  }, [t]);
  const showEmotion = useCallback(() => {
    setMode('emotion');
    t.value = withTiming(0, { duration: CROSSFADE_MS, easing: Easing.inOut(Easing.ease) });
  }, [t]);

  const emotionStyle = useAnimatedStyle(() => ({ opacity: 1 - t.value }));
  const contextStyle = useAnimatedStyle(() => ({ opacity: t.value }));

  const Sheet = GLASS_OK ? GlassView : View;
  const sheetGlass = GLASS_OK
    ? { glassEffectStyle: 'regular' as const, colorScheme: 'dark' as const, tintColor: 'rgba(14,12,6,0.26)' }
    : {};

  return (
    <View style={styles.root} testID="mood-context-screen">
      <Stack.Screen options={{ headerShown: false }} />

      {/* emotion indicator dots carried from the previous screen */}
      <View style={styles.dots} pointerEvents="none">
        <View style={[styles.dot, { backgroundColor: '#4a8f9e' }]} />
        <View style={[styles.dot, { backgroundColor: '#c2603f' }]} />
      </View>

      {/* soft radial bloom: tight warm core + wide falloff */}
      <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
        <Rect x={0} y={0} width={W} height={H}>
          <RadialGradient
            c={vec(W / 2, H * 0.34)}
            r={W * 0.48}
            colors={['rgba(240,204,100,0.4)', 'rgba(232,196,90,0.12)', 'rgba(13,12,10,0)']}
            positions={[0, 0.4, 1]}
          />
        </Rect>
      </Canvas>

      {/* arch / stadium card glowing behind the sheet */}
      <View style={styles.card} testID="emotion-card">
        <Text style={styles.star}>★</Text>
      </View>

      {/* persistent glass sheet — chips crossfade between modes */}
      <Sheet {...(sheetGlass as object)} style={styles.sheet} testID="context-sheet">
        <Text style={styles.label}>{mode === 'emotion' ? 'Pleasant' : 'Add context'}</Text>
        <View style={styles.stack}>
          <Animated.View style={[styles.layer, emotionStyle]} pointerEvents={mode === 'emotion' ? 'auto' : 'none'}>
            <ChipField tags={EMOTIONS} selected="Grateful" />
          </Animated.View>
          <Animated.View style={[styles.layer, contextStyle]} pointerEvents={mode === 'context' ? 'auto' : 'none'}>
            <ChipField tags={CONTEXT} />
          </Animated.View>
        </View>

        <View style={styles.footer}>
          {mode === 'emotion' ? (
            <>
              <PressableScale testID="show-all"><Text style={styles.ghost}>Show all</Text></PressableScale>
              <PressableScale testID="add-context" onPress={showContext}>
                {GLASS_OK ? (
                  <GlassView glassEffectStyle="regular" colorScheme="dark" isInteractive tintColor="rgba(30,26,16,0.5)" style={styles.pill}>
                    <Text style={styles.pillText}>Add context →</Text>
                  </GlassView>
                ) : (
                  <View style={[styles.pill, styles.chipFallback]}><Text style={styles.pillText}>Add context →</Text></View>
                )}
              </PressableScale>
            </>
          ) : (
            <>
              <PressableScale testID="back-chip" onPress={showEmotion}><Text style={styles.ghost}>← 1 emotion</Text></PressableScale>
              <PressableScale testID="submit-button">
                <View style={styles.submit}><Text style={styles.submitGlyph}>↑</Text></View>
              </PressableScale>
            </>
          )}
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#131312' },
  dots: {
    position: 'absolute',
    top: '6.5%',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 6,
    zIndex: 2,
  },
  dot: { width: 12, height: 16, borderRadius: 6 },
  card: {
    position: 'absolute',
    top: '33%',
    alignSelf: 'center',
    width: 166,
    height: 140,
    borderTopLeftRadius: 83,
    borderTopRightRadius: 83,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
    borderWidth: 1.2,
    borderColor: 'rgba(238,202,98,0.7)',
    backgroundColor: 'rgba(232,196,90,0.1)',
    alignItems: 'center',
    paddingTop: 26,
    shadowColor: GOLD,
    shadowOpacity: 0.6,
    shadowRadius: 40,
    shadowOffset: { width: 0, height: 0 },
  },
  star: { color: GOLD, fontSize: 23 },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '57%',
    backgroundColor: GLASS_OK ? undefined : 'rgba(22,18,10,0.92)',
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    overflow: 'hidden',
    paddingHorizontal: 18,
    paddingTop: 18,
  },
  label: { color: 'rgba(245,240,228,0.55)', fontSize: 13, marginBottom: 12, marginLeft: 4 },
  stack: { flex: 1 },
  layer: { ...StyleSheet.absoluteFillObject },
  field: { flex: 1 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10 },
  chipWrap: { borderRadius: 19 },
  chip: {
    paddingVertical: 9,
    paddingHorizontal: 22,
    borderRadius: 19,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipFallback: { backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  chipSelected: { borderWidth: 1, borderColor: GOLD },
  chipText: { color: TEXT, fontSize: 15 },
  chipTextSel: { color: GOLD },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16 },
  ghost: { color: 'rgba(245,240,228,0.8)', fontSize: 15, paddingVertical: 12, paddingHorizontal: 16 },
  pill: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: 22, overflow: 'hidden' },
  pillText: { color: TEXT, fontSize: 15 },
  submit: {
    width: 64, height: 44, borderRadius: 22, backgroundColor: GOLD,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: GOLD, shadowOpacity: 0.7, shadowRadius: 16, shadowOffset: { width: 0, height: 0 },
  },
  submitGlyph: { color: '#1a1500', fontSize: 22, fontWeight: '700' },
});
