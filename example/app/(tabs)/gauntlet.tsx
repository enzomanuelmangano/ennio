// Gauntlet — one screen per UI pattern Ennio must validate against.
// Each row navigates to a dedicated route under /gauntlet/<pattern>.

import { router } from 'expo-router';
import { ScrollView, Text, View, StyleSheet } from 'react-native';
import { PressableScale } from 'pressto';

const PATTERNS: { id: string; label: string; route: string }[] = [
  { id: 'g-flashlist',         label: 'FlashList virtualization',     route: '/gauntlet/flashlist' },
  { id: 'g-bottomsheet',       label: 'BottomSheet (gorhom)',         route: '/gauntlet/bottomsheet' },
  { id: 'g-webview',           label: 'WebView',                       route: '/gauntlet/webview' },
  { id: 'g-slider',            label: 'Slider',                        route: '/gauntlet/slider' },
  { id: 'g-picker',            label: 'Picker (system wheel)',         route: '/gauntlet/picker' },
  { id: 'g-switch',            label: 'Switch + Stepper',              route: '/gauntlet/switch-stepper' },
  { id: 'g-multiline',         label: 'Multi-line TextInput',          route: '/gauntlet/multiline' },
  { id: 'g-keyboard',          label: 'KeyboardAvoidingView',          route: '/gauntlet/keyboard' },
  { id: 'g-reanimated',        label: 'Reanimated worklet button',     route: '/gauntlet/reanimated' },
  { id: 'g-scroll-paging',     label: 'ScrollView paging',             route: '/gauntlet/scroll-paging' },
  { id: 'g-pan',               label: 'RNGH pan gesture',              route: '/gauntlet/pan' },
  { id: 'g-pinch',             label: 'RNGH pinch gesture',            route: '/gauntlet/pinch' },
  { id: 'g-touchables',        label: 'Touchable variants',            route: '/gauntlet/touchables' },
  { id: 'g-action-sheet',      label: 'Action sheet (Alert)',          route: '/gauntlet/action-sheet' },
  { id: 'g-alert',             label: 'Alert variants',                route: '/gauntlet/alert' },
  { id: 'g-form',              label: 'Form validation',               route: '/gauntlet/form' },
  { id: 'g-modal-stack',       label: 'Modal stacking',                route: '/gauntlet/modal-stack' },
  { id: 'g-deep-link',         label: 'Deep link target',              route: '/gauntlet/deep-link' },
];

export default function GauntletIndex() {
  return (
    <ScrollView style={styles.container} testID="gauntlet-screen">
      <Text style={styles.heading}>Compatibility gauntlet</Text>
      <Text style={styles.subheading}>One screen per UI pattern.</Text>
      {PATTERNS.map((p) => (
        <PressableScale
          key={p.id}
          testID={p.id}
          style={styles.row}
          onPress={() => router.push(p.route as never)}
        >
          <Text style={styles.rowLabel}>{p.label}</Text>
          <Text style={styles.chevron}>›</Text>
        </PressableScale>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  heading: { fontSize: 28, fontWeight: '700', padding: 16, paddingBottom: 4 },
  subheading: { fontSize: 14, color: '#666', paddingHorizontal: 16, paddingBottom: 12 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginHorizontal: 12,
    marginBottom: 6,
    borderRadius: 10,
  },
  rowLabel: { fontSize: 16, color: '#000' },
  chevron: { fontSize: 22, color: '#c7c7cc' },
});
