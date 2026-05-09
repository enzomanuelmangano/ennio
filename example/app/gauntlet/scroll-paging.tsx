import { ScrollView, View, Text, StyleSheet, Dimensions } from 'react-native';
import { useState } from 'react';

const { width } = Dimensions.get('window');
const PAGES = ['One', 'Two', 'Three', 'Four', 'Five'];

export default function ScrollPagingScreen() {
  const [page, setPage] = useState(0);
  return (
    <View style={{ flex: 1 }} testID="scroll-paging-screen">
      <Text style={styles.title}>
        Page: {page + 1} / {PAGES.length}
      </Text>
      <Text style={styles.title} testID="scroll-page-index">
        {page}
      </Text>
      <ScrollView
        testID="scroll-paging-scroll"
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => {
          setPage(Math.round(e.nativeEvent.contentOffset.x / width));
        }}
      >
        {PAGES.map((label, i) => (
          <View key={label} style={[styles.page, { width }]} testID={`scroll-page-${i}`}>
            <Text style={styles.pageLabel}>{label}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 18, padding: 16 },
  page: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pageLabel: { fontSize: 64, fontWeight: '700' },
});
