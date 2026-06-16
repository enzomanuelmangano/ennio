import { Stack } from 'expo-router';
import { useState } from 'react';
import { NativeSyntheticEvent, StyleSheet, Text, View } from 'react-native';
import PagerView from 'react-native-pager-view';
import { SafeAreaView } from 'react-native-safe-area-context';

// Mirrors Maestro demo_app's paging screen. Uses react-native-pager-view so on
// iOS it wraps a native UIPageViewController — the archetype this screen exists
// to exercise. Swiping LEFT advances to the next page; only the active page's
// text is mounted/visible, so flows can assertVisible "Page 2", "Page 3", etc.
type PageSelectedEvent = NativeSyntheticEvent<{ position: number }>;

const PAGES = [
  { label: 'Page 1', color: '#ef5350' },
  { label: 'Page 2', color: '#42a5f5' },
  { label: 'Page 3', color: '#66bb6a' },
  { label: 'Page 4', color: '#ffa726' },
];

export default function PagingScreen() {
  const [page, setPage] = useState(0);

  const onPageSelected = (e: PageSelectedEvent) => {
    setPage(e.nativeEvent.position);
  };

  return (
    <SafeAreaView style={styles.flex} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Paging Test' }} />

      <PagerView style={styles.pager} initialPage={0} onPageSelected={onPageSelected}>
        {PAGES.map((p, index) => (
          <View
            key={p.label}
            style={[styles.page, { backgroundColor: p.color }]}
            testID={`page-${index + 1}`}
            accessibilityLabel={p.label}
          >
            <Text style={styles.pageText}>{p.label}</Text>
          </View>
        ))}
      </PagerView>

      <View style={styles.indicator}>
        <View style={styles.dots}>
          {PAGES.map((p, index) => (
            <View
              key={p.label}
              style={[styles.dot, index === page ? styles.dotActive : styles.dotInactive]}
            />
          ))}
        </View>
        <Text
          style={styles.indicatorText}
          testID="page-indicator"
          accessibilityLabel={`Page ${page + 1} of 4`}
        >
          {`Page ${page + 1} of 4`}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#ffffff' },
  pager: { flex: 1 },
  page: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pageText: { fontSize: 48, fontWeight: '700', color: '#ffffff' },
  indicator: {
    paddingVertical: 16,
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#ffffff',
  },
  dots: { flexDirection: 'row', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotActive: { backgroundColor: '#212121' },
  dotInactive: { backgroundColor: '#bdbdbd' },
  indicatorText: { fontSize: 16, fontWeight: '600', color: '#212121' },
});
