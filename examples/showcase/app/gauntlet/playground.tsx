import { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  Switch,
  Alert,
  ActivityIndicator,
  StyleSheet,
  useColorScheme,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router } from 'expo-router';
import { useSettingsStore } from '../../store';

const TOGGLE_COUNT = 5;

export default function Playground() {
  // Match other tabs: store override OR system scheme.
  const darkPref = useSettingsStore((state) => state.preferences.darkMode);
  const systemScheme = useColorScheme();
  const isDark = darkPref || systemScheme === 'dark';
  const styles = isDark ? darkStyles : lightStyles;

  const [count, setCount] = useState(0);
  const [toggles, setToggles] = useState<boolean[]>(Array(TOGGLE_COUNT).fill(false));
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadComplete, setLoadComplete] = useState(false);

  const fruits = ['apple', 'banana', 'cherry', 'date', 'elderberry', 'fig', 'grape'];
  const filteredFruits = search
    ? fruits.filter((f) => f.toLowerCase().includes(search.toLowerCase()))
    : fruits;

  const triggerLoading = () => {
    setLoading(true);
    setLoadComplete(false);
    setTimeout(() => {
      setLoading(false);
      setLoadComplete(true);
    }, 2000);
  };

  const showAlert = () => {
    Alert.alert('Playground Alert', 'This is a native iOS alert.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'OK', style: 'default' },
    ]);
  };

  return (
    <KeyboardAwareScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      bottomOffset={120}
      testID="playground-scroll"
    >
      {/* Counter — exercises getText, assertVisible: text */}
      <Section title="Counter" styles={styles}>
        <View style={styles.counterRow}>
          <TouchableOpacity
            testID="counter-dec-btn"
            onPress={() => setCount((c) => c - 1)}
            style={styles.btnSmall}
          >
            <Text style={styles.btnSmallText}>−</Text>
          </TouchableOpacity>
          <Text testID="counter-display" style={styles.counterValue}>
            {count}
          </Text>
          <TouchableOpacity
            testID="counter-inc-btn"
            onPress={() => setCount((c) => c + 1)}
            style={styles.btnSmall}
          >
            <Text style={styles.btnSmallText}>+</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="counter-reset-btn"
            onPress={() => setCount(0)}
            style={styles.btnSmall}
          >
            <Text style={styles.btnSmallText}>↺</Text>
          </TouchableOpacity>
        </View>
      </Section>

      {/* Toggle list — exercises id by index, checked state */}
      <Section title="Toggles" styles={styles}>
        {toggles.map((on, i) => (
          <View key={i} style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>Toggle {i + 1}</Text>
            <Switch
              testID={`toggle-${i + 1}`}
              value={on}
              onValueChange={(v) => setToggles((prev) => prev.map((p, idx) => (idx === i ? v : p)))}
            />
          </View>
        ))}
      </Section>

      {/* Search + filtered list */}
      <Section title="Search" styles={styles}>
        <TextInput
          testID="search-input"
          value={search}
          onChangeText={setSearch}
          placeholder="Filter fruits..."
          placeholderTextColor={isDark ? '#888' : '#999'}
          style={styles.input}
          autoCorrect={false}
          autoCapitalize="none"
        />
        <Text testID="search-count" style={styles.muted}>
          {filteredFruits.length} result{filteredFruits.length === 1 ? '' : 's'}
        </Text>
        {filteredFruits.map((f) => (
          <Text key={f} testID={`fruit-${f}`} style={styles.listItem}>
            {f}
          </Text>
        ))}
      </Section>

      {/* Loading button — exercises extendedWaitUntil visible→notVisible */}
      <Section title="Async loading" styles={styles}>
        <TouchableOpacity
          testID="loading-btn"
          onPress={triggerLoading}
          disabled={loading}
          style={[styles.btn, loading && styles.btnDisabled]}
        >
          <Text style={styles.btnText}>{loading ? 'Loading...' : 'Start 2s task'}</Text>
        </TouchableOpacity>
        {loading && (
          <View testID="loading-spinner" style={styles.row}>
            <ActivityIndicator size="small" />
            <Text style={styles.muted}>Working...</Text>
          </View>
        )}
        {loadComplete && (
          <Text testID="loading-done" style={styles.success}>
            Done!
          </Text>
        )}
      </Section>

      {/* Step row — relational selectors (leftOf/rightOf) */}
      <Section title="Steps (horizontal)" styles={styles}>
        <View style={styles.stepRow}>
          <View testID="step-1" style={styles.step}>
            <Text style={styles.stepText}>Step 1</Text>
          </View>
          <View testID="step-2" style={styles.step}>
            <Text style={styles.stepText}>Step 2</Text>
          </View>
          <View testID="step-3" style={styles.step}>
            <Text style={styles.stepText}>Step 3</Text>
          </View>
        </View>
      </Section>

      {/* Modal/sheet navigation */}
      <Section title="Navigation patterns" styles={styles}>
        <NavBtn
          testID="open-pressables-btn"
          label="Open Pressables showcase"
          onPress={() => router.push('/gauntlet/pressables-screen' as never)}
          styles={styles}
        />
        <NavBtn
          testID="open-form-sheet-btn"
          label="Open formSheet"
          onPress={() => router.push('/gauntlet/sheet-form' as never)}
          styles={styles}
        />
        <NavBtn
          testID="open-page-sheet-btn"
          label="Open pageSheet"
          onPress={() => router.push('/gauntlet/sheet-page' as never)}
          styles={styles}
        />
        <NavBtn
          testID="open-transparent-modal-btn"
          label="Open transparentModal"
          onPress={() => router.push('/gauntlet/sheet-transparent' as never)}
          styles={styles}
        />
        <NavBtn
          testID="open-stacked-modal-btn"
          label="Open stacked modal"
          onPress={() => router.push('/gauntlet/sheet-stacked' as never)}
          styles={styles}
        />
        <NavBtn
          testID="open-alert-btn"
          label="Show native alert"
          onPress={showAlert}
          styles={styles}
        />
      </Section>
    </KeyboardAwareScrollView>
  );
}

function Section({
  title,
  children,
  styles,
}: {
  title: string;
  children: React.ReactNode;
  styles: typeof lightStyles;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>{title}</Text>
      {children}
    </View>
  );
}

function NavBtn({
  testID,
  label,
  onPress,
  styles,
}: {
  testID: string;
  label: string;
  onPress: () => void;
  styles: typeof lightStyles;
}) {
  return (
    <TouchableOpacity testID={testID} onPress={onPress} style={styles.btn}>
      <Text style={styles.btnText}>{label}</Text>
    </TouchableOpacity>
  );
}

const baseStyles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, paddingBottom: 64 },
  h1: { fontSize: 28, fontWeight: '700', marginBottom: 4 },
  h2: { fontSize: 18, fontWeight: '600', marginBottom: 12 },
  subtitle: { fontSize: 14, marginBottom: 24 },
  section: { marginBottom: 28 },
  counterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  counterValue: { fontSize: 32, fontWeight: '700', minWidth: 64, textAlign: 'center' },
  btnSmall: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSmallText: { fontSize: 22, fontWeight: '600' },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toggleLabel: { fontSize: 16 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 8,
    borderCurve: 'continuous',
  },
  muted: { fontSize: 13, marginBottom: 8 },
  listItem: { fontSize: 15, paddingVertical: 4 },
  btn: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 8,
    borderCurve: 'continuous',
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { fontSize: 15, fontWeight: '600' },
  success: { fontSize: 15, fontWeight: '600', marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  stepRow: { flexDirection: 'row', justifyContent: 'space-between' },
  step: {
    flex: 1,
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginHorizontal: 4,
    borderCurve: 'continuous',
  },
  stepText: { fontSize: 14, fontWeight: '600' },
});

const lightStyles = StyleSheet.create({
  ...baseStyles,
  container: { ...baseStyles.container, backgroundColor: '#f5f5f5' },
  h1: { ...baseStyles.h1, color: '#000' },
  h2: { ...baseStyles.h2, color: '#000' },
  subtitle: { ...baseStyles.subtitle, color: '#666' },
  counterValue: { ...baseStyles.counterValue, color: '#000' },
  btnSmall: { ...baseStyles.btnSmall, backgroundColor: '#007AFF' },
  btnSmallText: { ...baseStyles.btnSmallText, color: '#fff' },
  toggleRow: { ...baseStyles.toggleRow, borderBottomColor: '#ddd' },
  toggleLabel: { ...baseStyles.toggleLabel, color: '#000' },
  input: { ...baseStyles.input, borderColor: '#ddd', color: '#000', backgroundColor: '#fff' },
  muted: { ...baseStyles.muted, color: '#666' },
  listItem: { ...baseStyles.listItem, color: '#000' },
  btn: { ...baseStyles.btn, backgroundColor: '#007AFF' },
  btnText: { ...baseStyles.btnText, color: '#fff' },
  success: { ...baseStyles.success, color: '#1a7f37' },
  step: { ...baseStyles.step, backgroundColor: '#fff' },
  stepText: { ...baseStyles.stepText, color: '#000' },
});

const darkStyles = StyleSheet.create({
  ...baseStyles,
  container: { ...baseStyles.container, backgroundColor: '#16213e' },
  h1: { ...baseStyles.h1, color: '#fff' },
  h2: { ...baseStyles.h2, color: '#fff' },
  subtitle: { ...baseStyles.subtitle, color: '#aaa' },
  counterValue: { ...baseStyles.counterValue, color: '#fff' },
  btnSmall: { ...baseStyles.btnSmall, backgroundColor: '#3b82f6' },
  btnSmallText: { ...baseStyles.btnSmallText, color: '#fff' },
  toggleRow: { ...baseStyles.toggleRow, borderBottomColor: '#333' },
  toggleLabel: { ...baseStyles.toggleLabel, color: '#fff' },
  input: { ...baseStyles.input, borderColor: '#333', color: '#fff', backgroundColor: '#1a1a2e' },
  muted: { ...baseStyles.muted, color: '#888' },
  listItem: { ...baseStyles.listItem, color: '#fff' },
  btn: { ...baseStyles.btn, backgroundColor: '#3b82f6' },
  btnText: { ...baseStyles.btnText, color: '#fff' },
  success: { ...baseStyles.success, color: '#34d399' },
  step: { ...baseStyles.step, backgroundColor: '#1a1a2e' },
  stepText: { ...baseStyles.stepText, color: '#fff' },
});
