import { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  Image,
  Pressable,
  useColorScheme,
} from 'react-native';
import { PressableScale } from 'pressto';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DropdownMenu from 'zeego/dropdown-menu';
import {
  useProductsStore,
  useCartStore,
  useSettingsStore,
  categories,
} from '../../store';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, lineHeight, radius } from '../../src/theme';

type SortOption = 'price-asc' | 'price-desc' | 'rating' | 'name';

function ProductCard({
  product,
  c,
}: {
  product: ReturnType<typeof useProductsStore.getState>['products'][0];
  c: ReturnType<typeof colors>;
}) {
  const router = useRouter();
  const addToCart = useCartStore(state => state.addToCart);
  const hapticEnabled = useSettingsStore(
    state => state.preferences.hapticFeedback,
  );

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
      style={[
        styles.productCard,
        { backgroundColor: c.secondarySystemGroupedBackground },
      ]}
      onPress={() => router.push(`/product/${product.id}`)}
      testID={`product-card-${product.id}`}
    >
      <View style={styles.productImageWrap}>
        <Image source={{ uri: product.image }} style={styles.productImage} />
        {!product.inStock && (
          <View style={styles.outOfStockBadge}>
            <Text style={styles.outOfStockText}>Out of Stock</Text>
          </View>
        )}
      </View>
      <View style={styles.productContent}>
        <Text
          style={[styles.productCategory, { color: c.secondaryLabel }]}
        >
          {product.category}
        </Text>
        <Text
          style={[styles.productName, { color: c.label }]}
          numberOfLines={2}
        >
          {product.name}
        </Text>
        <View style={styles.productMeta}>
          <Text style={[styles.productRating, { color: c.secondaryLabel }]}>
            ★ {product.rating}
          </Text>
          <Text style={[styles.productReviews, { color: c.tertiaryLabel }]}>
            ({product.reviews})
          </Text>
        </View>
        <View style={styles.productFooter}>
          <Text style={[styles.productPrice, { color: c.label }]}>
            ${product.price.toFixed(2)}
          </Text>
          <Pressable
            style={[
              styles.addToCartBtn,
              { backgroundColor: c.systemBlue },
              !product.inStock && { backgroundColor: c.tertiarySystemFill },
            ]}
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

function CategoryFilter({ c }: { c: ReturnType<typeof colors> }) {
  const selectedCategory = useProductsStore(state => state.selectedCategory);
  const setCategory = useProductsStore(state => state.setCategory);

  return (
    <View style={styles.categoryContainer}>
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={categories}
        keyExtractor={item => item}
        contentContainerStyle={styles.categoryList}
        renderItem={({ item }) => {
          const active = selectedCategory === item;
          return (
            <PressableScale
              style={[
                styles.categoryChip,
                {
                  backgroundColor: active
                    ? c.systemBlue
                    : c.secondarySystemGroupedBackground,
                },
              ]}
              onPress={() => setCategory(item)}
              testID={`filter-category-${item.toLowerCase()}`}
            >
              <Text
                style={[
                  styles.categoryChipText,
                  { color: active ? '#FFFFFF' : c.label },
                ]}
              >
                {item}
              </Text>
            </PressableScale>
          );
        }}
      />
    </View>
  );
}

function SortDropdown({
  value,
  onChange,
  c,
}: {
  value: SortOption;
  onChange: (value: SortOption) => void;
  c: ReturnType<typeof colors>;
}) {
  const hapticEnabled = useSettingsStore(
    state => state.preferences.hapticFeedback,
  );

  const options: { value: SortOption; label: string }[] = [
    { value: 'rating', label: 'Top Rated' },
    { value: 'price-asc', label: 'Price: Low to High' },
    { value: 'price-desc', label: 'Price: High to Low' },
    { value: 'name', label: 'Name: A to Z' },
  ];

  const selectedLabel =
    options.find(o => o.value === value)?.label || 'Sort By';

  const handleSelect = (val: SortOption) => {
    onChange(val);
    if (hapticEnabled) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {/* No onPress here — zeego's UIMenu requires the real UIKit
            touch sequence, not a synthesised React onPress. Ennio's
            tap path will see no onPress on this fiber and fall through
            to idb HID, which delivers the touch UIKit needs. */}
        <View
          style={[
            styles.sortButton,
            { backgroundColor: c.secondarySystemGroupedBackground },
          ]}
          testID="sort-dropdown"
        >
          <Text style={[styles.sortButtonText, { color: c.label }]}>
            {selectedLabel}
          </Text>
          <Text style={[styles.sortArrow, { color: c.secondaryLabel }]}>⌄</Text>
        </View>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        {/* Hidden anchor view: keeps the historical `sort-options` testID
            in the React tree so e2e flows can `assertVisible: id:
            sort-options` while the dropdown is open without depending
            on UIMenu's invisible-to-Fabric internals. */}
        {options.map(o => (
          <DropdownMenu.CheckboxItem
            key={o.value}
            value={value === o.value ? 'on' : 'off'}
            onValueChange={() => handleSelect(o.value)}
            testID={`sort-option-${o.value}`}
          >
            <DropdownMenu.ItemTitle>{o.label}</DropdownMenu.ItemTitle>
            <DropdownMenu.ItemIndicator />
          </DropdownMenu.CheckboxItem>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
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
  const systemScheme = useColorScheme();
  const scheme = darkMode ? 'dark' : systemScheme === 'dark' ? 'dark' : 'light';
  const c = colors(scheme);

  const products = useMemo(() => {
    let filtered = allProducts;

    if (selectedCategory !== 'All') {
      filtered = filtered.filter(p => p.category === selectedCategory);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        p =>
          p.name.toLowerCase().includes(query) ||
          p.description.toLowerCase().includes(query),
      );
    }

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
    <View
      style={[
        styles.container,
        { backgroundColor: c.systemGroupedBackground },
        {
          paddingTop: insets.top + 8,
          paddingBottom: insets.bottom + TAB_BAR_HEIGHT,
        },
      ]}
      testID="products-screen"
    >
      <Text style={[styles.largeTitle, { color: c.label }]}>Products</Text>

      {/* Search Bar */}
      <View
        style={[
          styles.searchContainer,
          { backgroundColor: c.tertiarySystemFill },
        ]}
      >
        <Text style={[styles.searchIcon, { color: c.secondaryLabel }]}>⌕</Text>
        <TextInput
          style={[styles.searchInput, { color: c.label }]}
          placeholder="Search products"
          placeholderTextColor={c.secondaryLabel}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          testID="search-input"
        />
        {searchQuery.length > 0 && (
          <PressableScale
            style={styles.clearSearch}
            onPress={() => setSearchQuery('')}
            testID="clear-search"
            hitSlop={8}
          >
            <View
              style={[
                styles.clearSearchCircle,
                { backgroundColor: c.tertiaryLabel },
              ]}
            >
              <Text style={styles.clearSearchText}>✕</Text>
            </View>
          </PressableScale>
        )}
      </View>

      {/* Category Filter */}
      <CategoryFilter c={c} />

      {/* Sort & Results Count */}
      <View style={styles.toolbar}>
        <Text style={[styles.resultsCount, { color: c.secondaryLabel }]}>
          {products.length} {products.length === 1 ? 'result' : 'results'}
        </Text>
        <SortDropdown value={sortBy} onChange={setSortBy} c={c} />
      </View>

      {(searchQuery.length > 0 || selectedCategory !== 'All') && (
        <PressableScale
          style={[
            styles.resetTopButton,
            { backgroundColor: c.tertiarySystemFill },
          ]}
          onPress={() => {
            setSearchQuery('');
            useProductsStore.getState().setCategory('All');
          }}
          testID="reset-all"
        >
          <Text style={[styles.resetTopButtonText, { color: c.label }]}>
            Reset Filters
          </Text>
        </PressableScale>
      )}

      {/* Products Grid */}
      {products.length > 0 ? (
        <FlatList
          data={products}
          numColumns={2}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.productsList}
          columnWrapperStyle={styles.productsRow}
          renderItem={({ item }) => <ProductCard product={item} c={c} />}
          showsVerticalScrollIndicator={false}
          testID="products-list"
        />
      ) : (
        <View style={styles.emptyState} testID="no-products">
          <View
            style={[
              styles.emptyIconBg,
              { backgroundColor: c.tertiarySystemFill },
            ]}
          >
            <Text style={[styles.emptyIcon, { color: c.secondaryLabel }]}>
              ⌕
            </Text>
          </View>
          <Text style={[styles.emptyTitle, { color: c.label }]}>
            No products found
          </Text>
          <Text style={[styles.emptySubtitle, { color: c.secondaryLabel }]}>
            Try adjusting your search or filters
          </Text>
          <PressableScale
            style={[styles.resetButton, { backgroundColor: c.systemBlue }]}
            onPress={() => {
              setSearchQuery('');
              useProductsStore.getState().setCategory('All');
            }}
            testID="reset-filters"
          >
            <Text style={styles.resetButtonText}>Reset Filters</Text>
          </PressableScale>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  largeTitle: {
    fontSize: fontSize.largeTitle,
    lineHeight: lineHeight.largeTitle,
    fontWeight: '700',
    letterSpacing: 0.37,
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.card,
  },
  searchIcon: {
    fontSize: 18,
    marginRight: 6,
  },
  searchInput: {
    flex: 1,
    fontSize: fontSize.body,
    paddingVertical: 0,
  },
  clearSearch: {
    paddingLeft: 8,
  },
  clearSearchCircle: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearSearchText: {
    fontSize: 11,
    color: '#FFFFFF',
    fontWeight: '700',
  },
  categoryContainer: {
    marginTop: 14,
  },
  categoryList: {
    paddingHorizontal: 16,
    gap: 8,
  },
  categoryChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.pill,
    marginRight: 8,
  },
  categoryChipText: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  resultsCount: {
    fontSize: fontSize.footnote,
    fontWeight: '500',
  },
  sortButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  sortButtonText: {
    fontSize: fontSize.footnote,
    fontWeight: '600',
    marginRight: 4,
  },
  sortArrow: {
    fontSize: 12,
    fontWeight: '700',
  },
  sortBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sortMenu: {
    borderRadius: radius.sheet,
    width: '78%',
    overflow: 'hidden',
  },
  sortOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  sortOptionText: {
    fontSize: fontSize.body,
    fontWeight: '500',
  },
  sortCheck: {
    fontSize: 17,
    fontWeight: '600',
  },
  sortSeparator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 18,
  },
  resetTopButton: {
    marginHorizontal: 20,
    marginBottom: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
  },
  resetTopButtonText: {
    fontSize: fontSize.footnote,
    fontWeight: '600',
  },
  productsList: {
    paddingHorizontal: 12,
    paddingBottom: 24,
  },
  productsRow: {
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  productCard: {
    width: '48%',
    borderRadius: radius.card,
    marginBottom: 12,
    overflow: 'hidden',
  },
  productImageWrap: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: 'rgba(120,120,128,0.12)',
  },
  productImage: {
    width: '100%',
    height: '100%',
  },
  outOfStockBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  outOfStockText: {
    color: '#FFFFFF',
    fontSize: fontSize.caption2,
    fontWeight: '700',
  },
  productContent: {
    padding: 12,
  },
  productCategory: {
    fontSize: fontSize.caption2,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontWeight: '600',
  },
  productName: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
    marginTop: 4,
    lineHeight: 20,
  },
  productMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  productRating: {
    fontSize: fontSize.caption1,
    fontWeight: '500',
  },
  productReviews: {
    fontSize: fontSize.caption1,
    marginLeft: 4,
  },
  productFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
  },
  productPrice: {
    fontSize: fontSize.body,
    fontWeight: '700',
  },
  addToCartBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addToCartText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginTop: -2,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  emptyIconBg: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  emptyIcon: {
    fontSize: 38,
    fontWeight: '500',
  },
  emptyTitle: {
    fontSize: fontSize.title2,
    fontWeight: '700',
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: fontSize.subhead,
    textAlign: 'center',
  },
  resetButton: {
    marginTop: 22,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: radius.pill,
  },
  resetButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: fontSize.body,
  },
});
