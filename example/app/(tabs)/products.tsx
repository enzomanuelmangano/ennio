import { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  TextInput,
  Image,
  Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useProductsStore, useCartStore, useSettingsStore, categories } from '../../store';
import * as Haptics from 'expo-haptics';

type SortOption = 'price-asc' | 'price-desc' | 'rating' | 'name';

function ProductCard({ product }: { product: ReturnType<typeof useProductsStore.getState>['products'][0] }) {
  const router = useRouter();
  const addToCart = useCartStore(state => state.addToCart);
  const hapticEnabled = useSettingsStore(state => state.preferences.hapticFeedback);
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  const handleAddToCart = () => {
    if (product.inStock) {
      addToCart(product);
      if (hapticEnabled) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
    }
  };

  return (
    <Pressable
      style={[styles.productCard, darkMode && styles.cardDark]}
      onPress={() => router.push(`/product/${product.id}`)}
      testID={`product-card-${product.id}`}
    >
      <Image source={{ uri: product.image }} style={styles.productImage} />
      {!product.inStock && (
        <View style={styles.outOfStockBadge}>
          <Text style={styles.outOfStockText}>Out of Stock</Text>
        </View>
      )}
      <View style={styles.productContent}>
        <Text style={[styles.productCategory, darkMode && styles.subtitleDark]}>{product.category}</Text>
        <Text style={[styles.productName, darkMode && styles.textLight]} numberOfLines={2}>
          {product.name}
        </Text>
        <View style={styles.productMeta}>
          <Text style={styles.productRating}>⭐ {product.rating}</Text>
          <Text style={[styles.productReviews, darkMode && styles.subtitleDark]}>({product.reviews})</Text>
        </View>
        <View style={styles.productFooter}>
          <Text style={styles.productPrice}>${product.price.toFixed(2)}</Text>
          <Pressable
            style={[styles.addToCartBtn, !product.inStock && styles.addToCartBtnDisabled]}
            onPress={handleAddToCart}
            disabled={!product.inStock}
            testID={`add-to-cart-${product.id}`}
          >
            <Text style={styles.addToCartText}>+</Text>
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
}

function CategoryFilter() {
  const selectedCategory = useProductsStore(state => state.selectedCategory);
  const setCategory = useProductsStore(state => state.setCategory);
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  return (
    <View style={styles.categoryContainer}>
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={categories}
        keyExtractor={item => item}
        contentContainerStyle={styles.categoryList}
        renderItem={({ item }) => (
          <Pressable
            style={[
              styles.categoryChip,
              selectedCategory === item && styles.categoryChipActive,
              darkMode && styles.categoryChipDark,
            ]}
            onPress={() => setCategory(item)}
            testID={`filter-category-${item.toLowerCase()}`}
          >
            <Text
              style={[
                styles.categoryChipText,
                selectedCategory === item && styles.categoryChipTextActive,
              ]}
            >
              {item}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

function SortDropdown({
  value,
  onChange,
}: {
  value: SortOption;
  onChange: (value: SortOption) => void;
}) {
  const darkMode = useSettingsStore(state => state.preferences.darkMode);
  const hapticEnabled = useSettingsStore(state => state.preferences.hapticFeedback);
  const [open, setOpen] = useState(false);

  const options: { value: SortOption; label: string }[] = [
    { value: 'rating', label: 'Top Rated' },
    { value: 'price-asc', label: 'Price: Low to High' },
    { value: 'price-desc', label: 'Price: High to Low' },
    { value: 'name', label: 'Name: A to Z' },
  ];

  const selectedLabel = options.find(o => o.value === value)?.label || 'Sort By';

  const handleOpen = () => {
    if (hapticEnabled) Haptics.selectionAsync();
    setOpen(true);
  };

  const handleSelect = (val: SortOption) => {
    onChange(val);
    setOpen(false);
    if (hapticEnabled) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  return (
    <>
      <Pressable
        style={[styles.sortButton, darkMode && styles.sortButtonDark]}
        onPress={handleOpen}
        testID="sort-dropdown"
      >
        <Text style={[styles.sortButtonText, darkMode && styles.textLight]}>{selectedLabel}</Text>
        <Text style={styles.sortArrow}>▼</Text>
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.sortBackdrop} onPress={() => setOpen(false)}>
          <View
            style={[styles.sortMenu, darkMode && styles.sortMenuDark]}
            testID="sort-options"
          >
            {options.map(o => (
              <Pressable
                key={o.value}
                style={[styles.sortOption, value === o.value && styles.sortOptionActive]}
                onPress={() => handleSelect(o.value)}
                testID={`sort-option-${o.value}`}
              >
                <Text style={[styles.sortOptionText, darkMode && styles.textLight]}>
                  {o.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

export default function ProductsScreen() {
  const allProducts = useProductsStore(state => state.products);
  const selectedCategory = useProductsStore(state => state.selectedCategory);
  const searchQuery = useProductsStore(state => state.searchQuery);
  const setSearchQuery = useProductsStore(state => state.setSearchQuery);
  const sortBy = useProductsStore(state => state.sortBy);
  const setSortBy = useProductsStore(state => state.setSortBy);
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  // Memoize filtered products to avoid infinite re-renders
  const products = useMemo(() => {
    let filtered = allProducts;

    // Filter by category
    if (selectedCategory !== 'All') {
      filtered = filtered.filter(p => p.category === selectedCategory);
    }

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        p =>
          p.name.toLowerCase().includes(query) ||
          p.description.toLowerCase().includes(query)
      );
    }

    // Sort
    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'price-asc':
          return a.price - b.price;
        case 'price-desc':
          return b.price - a.price;
        case 'name':
          return a.name.localeCompare(b.name);
        case 'rating':
        default:
          return b.rating - a.rating;
      }
    });
  }, [allProducts, selectedCategory, searchQuery, sortBy]);

  const insets = useSafeAreaInsets();
  const TAB_BAR_HEIGHT = 49;

  return (
    <View style={[styles.container, darkMode && styles.containerDark, { paddingTop: insets.top, paddingBottom: insets.bottom + TAB_BAR_HEIGHT }]} testID="products-screen">
      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <TextInput
          style={[styles.searchInput, darkMode && styles.searchInputDark]}
          placeholder="Search products..."
          placeholderTextColor={darkMode ? '#888' : '#999'}
          value={searchQuery}
          onChangeText={setSearchQuery}
          testID="search-input"
        />
        {searchQuery.length > 0 && (
          <Pressable
            style={styles.clearSearch}
            onPress={() => setSearchQuery('')}
            testID="clear-search"
          >
            <Text style={styles.clearSearchText}>✕</Text>
          </Pressable>
        )}
      </View>

      {/* Category Filter */}
      <CategoryFilter />

      {/* Sort & Results Count */}
      <View style={styles.toolbar}>
        <Text style={[styles.resultsCount, darkMode && styles.subtitleDark]}>
          {products.length} products
        </Text>
        <SortDropdown value={sortBy} onChange={setSortBy} />
      </View>

      {/* Products Grid */}
      {products.length > 0 ? (
        <FlatList
          data={products}
          numColumns={2}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.productsList}
          columnWrapperStyle={styles.productsRow}
          renderItem={({ item }) => <ProductCard product={item} />}
          testID="products-list"
        />
      ) : (
        <View style={styles.emptyState} testID="no-products">
          <Text style={styles.emptyIcon}>🔍</Text>
          <Text style={[styles.emptyTitle, darkMode && styles.textLight]}>No products found</Text>
          <Text style={[styles.emptySubtitle, darkMode && styles.subtitleDark]}>
            Try adjusting your search or filters
          </Text>
          <Pressable
            style={styles.resetButton}
            onPress={() => {
              setSearchQuery('');
              useProductsStore.getState().setCategory('All');
            }}
            testID="reset-filters"
          >
            <Text style={styles.resetButtonText}>Reset Filters</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  containerDark: {
    backgroundColor: '#16213e',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 15,
    marginBottom: 10,
  },
  searchInput: {
    flex: 1,
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    fontSize: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  searchInputDark: {
    backgroundColor: '#1a1a2e',
    color: '#fff',
  },
  clearSearch: {
    position: 'absolute',
    right: 12,
    padding: 4,
  },
  clearSearchText: {
    fontSize: 16,
    color: '#999',
  },
  categoryContainer: {
    marginBottom: 10,
  },
  categoryList: {
    paddingHorizontal: 15,
  },
  categoryChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#fff',
    borderRadius: 20,
    marginRight: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 1,
  },
  categoryChipDark: {
    backgroundColor: '#1a1a2e',
  },
  categoryChipActive: {
    backgroundColor: '#007AFF',
  },
  categoryChipText: {
    fontSize: 14,
    color: '#666',
    fontWeight: '500',
  },
  categoryChipTextActive: {
    color: '#fff',
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 15,
    paddingVertical: 10,
  },
  resultsCount: {
    fontSize: 14,
    color: '#666',
  },
  subtitleDark: {
    color: '#aaa',
  },
  textLight: {
    color: '#fff',
  },
  sortButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  sortButtonDark: {
    backgroundColor: '#1a1a2e',
  },
  sortButtonText: {
    fontSize: 14,
    color: '#333',
    marginRight: 6,
  },
  sortArrow: {
    fontSize: 10,
    color: '#666',
  },
  sortBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sortMenu: {
    backgroundColor: '#fff',
    borderRadius: 12,
    width: '80%',
    paddingVertical: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },
  sortMenuDark: {
    backgroundColor: '#1a1a2e',
  },
  sortOption: {
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  sortOptionActive: {
    backgroundColor: '#e6f0ff',
  },
  sortOptionText: {
    fontSize: 16,
    color: '#222',
  },
  productsList: {
    padding: 10,
    paddingBottom: 100,
  },
  productsRow: {
    justifyContent: 'space-between',
    paddingHorizontal: 5,
  },
  productCard: {
    width: '48%',
    backgroundColor: '#fff',
    borderRadius: 12,
    marginBottom: 15,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  cardDark: {
    backgroundColor: '#1a1a2e',
  },
  productImage: {
    width: '100%',
    height: 140,
    backgroundColor: '#f0f0f0',
  },
  outOfStockBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  outOfStockText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  productContent: {
    padding: 12,
  },
  productCategory: {
    fontSize: 11,
    color: '#999',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  productName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a2e',
    marginTop: 4,
    lineHeight: 20,
  },
  productMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  productRating: {
    fontSize: 12,
    color: '#666',
  },
  productReviews: {
    fontSize: 11,
    color: '#999',
    marginLeft: 4,
  },
  productFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
  },
  productPrice: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  addToCartBtn: {
    backgroundColor: '#007AFF',
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addToCartBtnDisabled: {
    backgroundColor: '#ccc',
  },
  addToCartText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  emptyIcon: {
    fontSize: 60,
    marginBottom: 20,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1a1a2e',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
  },
  resetButton: {
    marginTop: 20,
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: '#007AFF',
    borderRadius: 20,
  },
  resetButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
});
