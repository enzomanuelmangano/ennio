// Native UISearchBar via Stack.Screen.options.headerSearchBarOptions.
// RNScreens binds an iOS UISearchController to the navigation
// header; tapping the field activates UIKit-native typing and
// dismiss behaviour. Validates Ennio can drive it via inputText
// and read echoed query state.

import { useState } from 'react';
import { Stack } from 'expo-router';
import { ScrollView, View, Text, StyleSheet } from 'react-native';

const ALL = [
  'Apple',
  'Avocado',
  'Banana',
  'Blueberry',
  'Cherry',
  'Date',
  'Elderberry',
  'Fig',
  'Grape',
  'Honeydew',
];

export default function SearchBarScreen() {
  const [query, setQuery] = useState('');
  const filtered = query ? ALL.filter((s) => s.toLowerCase().includes(query.toLowerCase())) : ALL;

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Search',
          headerSearchBarOptions: {
            placeholder: 'Search fruit',
            onChangeText: (e) => setQuery(e.nativeEvent.text),
            hideWhenScrolling: false,
          },
        }}
      />
      <ScrollView
        testID="search-bar-screen"
        style={styles.container}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <Text style={styles.title}>Native search</Text>
        <Text style={styles.echo} testID="search-echo">
          Query: {query || 'EMPTY'}
        </Text>
        {filtered.map((s) => (
          <View key={s} style={styles.row} testID={`fruit-${s.toLowerCase()}`}>
            <Text style={styles.rowText}>{s}</Text>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, paddingBottom: 120 },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 12 },
  echo: { fontSize: 16, color: '#34C759', marginBottom: 24 },
  row: {
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 10,
    marginBottom: 8,
    borderCurve: 'continuous',
  },
  rowText: { fontSize: 16 },
});
