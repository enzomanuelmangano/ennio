import { useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TextInput, Image, Modal, Pressable } from 'react-native';
import { PressableScale } from 'pressto';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useProductsStore, useCartStore, useSettingsStore, categories } from '../../../store';
import { useTheme, type Theme } from '../../../theme';
import * as Haptics from 'expo-haptics';

type SortOption = 'price-asc' | 'price-desc' | 'rating' | 'name';

function ProductCard({
  product,
  styles,
  theme,
}: {
  product: ReturnType<typeof useProductsStore.getState>['products'][0];
  styles: ReturnType<typeof createStyles>;
  theme: Theme;
}) {
  const router = useRouter();
  const addToCart = useCartStore((state) => state.addToCart);
  const hapticEnabled = useSettingsStore((state) => state.preferences.hapticFeedback);

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
      style={styles.productCard}
      onPress={() => router.push(`/product/${product.id}`)}
      testID={`product-card-${product.id}`}
      accessibilityIdentifier={`product-card-${product.id}`}
      accessible
    >
      <Image source={{ uri: product.image }} style={styles.productImage} />
      {!product.inStock && (
        <View style={styles.outOfStockBadge}>
          <Text style={styles.outOfStockText}>Out of Stock</Text>
        </View>
      )}
      <View style={styles.productContent}>
        <Text style={styles.productCategory}>{product.category}</Text>
        <Text style={styles.productName} numberOfLines={2}>
          {product.name}
        </Text>
        <View style={styles.productMeta}>
          <Ionicons name="star" size={12} color={theme.colors.warning} />
          <Text style={styles.productRating}>{product.rating}</Text>
          <Text style={styles.productReviews}>({product.reviews})</Text>
        </View>
        <View style={styles.productFooter}>
          <Text style={styles.productPrice}>${product.price.toFixed(2)}</Text>
          <Pressable
            style={[styles.addToCartBtn, !product.inStock && styles.addToCartBtnDisabled]}
            onPress={handleAddToCart}
            disabled={!product.inStock}
            testID={`add-to-cart-${product.id}`}
          >
            <Ionicons name="add" size={20} color={theme.colors.text.onAccent} />
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
}

function CategoryFilter({ styles }: { styles: ReturnType<typeof createStyles> }) {
  const selectedCategory = useProductsStore((state) => state.selectedCategory);
  const setCategory = useProductsStore((state) => state.setCategory);

  return (
    <View style={styles.categoryContainer}>
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={categories}
        keyExtractor={(item) => item}
        contentContainerStyle={styles.categoryList}
        renderItem={({ item }) => (
          <PressableScale
            style={[styles.categoryChip, selectedCategory === item && styles.categoryChipActive]}
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
          </PressableScale>
        )}
      />
    </View>
  );
}

function SortDropdown({
  value,
  onChange,
  styles,
  theme,
}: {
  value: SortOption;
  onChange: (value: SortOption) => void;
  styles: ReturnType<typeof createStyles>;
  theme: Theme;
}) {
  const hapticEnabled = useSettingsStore((state) => state.preferences.hapticFeedback);
  const [open, setOpen] = useState(false);

  const options: { value: SortOption; label: string }[] = [
    { value: 'rating', label: 'Top Rated' },
    { value: 'price-asc', label: 'Price: Low to High' },
    { value: 'price-desc', label: 'Price: High to Low' },
    { value: 'name', label: 'Name: A to Z' },
  ];

  const selectedLabel = options.find((o) => o.value === value)?.label || 'Sort By';

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
      <PressableScale
        style={styles.sortButton}
        onPress={handleOpen}
        testID="sort-dropdown"
        // @ts-expect-error pressto patch propagates accessibilityIdentifier at runtime; types omit it
        accessibilityIdentifier="sort-dropdown"
      >
        <Text style={styles.sortButtonText}>{selectedLabel}</Text>
        <Ionicons name="chevron-down" size={14} color={theme.colors.text.muted} />
      </PressableScale>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <PressableScale style={styles.sortBackdrop} onPress={() => setOpen(false)}>
          <View style={styles.sortMenu} testID="sort-options">
            {options.map((o) => (
              <PressableScale
                key={o.value}
                style={[styles.sortOption, value === o.value && styles.sortOptionActive]}
                onPress={() => handleSelect(o.value)}
                testID={`sort-option-${o.value}`}
                // @ts-expect-error pressto patch propagates accessibilityIdentifier at runtime; types omit it
                accessibilityIdentifier={`sort-option-${o.value}`}
              >
                <Text style={styles.sortOptionText}>{o.label}</Text>
                {value === o.value && (
                  <Ionicons name="checkmark" size={18} color={theme.colors.accent.ink} />
                )}
              </PressableScale>
            ))}
          </View>
        </PressableScale>
      </Modal>
    </>
  );
}

export default function ProductsScreen() {
  const allProducts = useProductsStore((state) => state.products);
  const selectedCategory = useProductsStore((state) => state.selectedCategory);
  const searchQuery = useProductsStore((state) => state.searchQuery);
  const setSearchQuery = useProductsStore((state) => state.setSearchQuery);
  const sortBy = useProductsStore((state) => state.sortBy);
  const setSortBy = useProductsStore((state) => state.setSortBy);
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const products = useMemo(() => {
    let filtered = allProducts;
    if (selectedCategory !== 'All') {
      filtered = filtered.filter((p) => p.category === selectedCategory);
    }
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (p) => p.name.toLowerCase().includes(query) || p.description.toLowerCase().includes(query),
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

  const ListHeader = (
    <>
      <View style={styles.searchContainer}>
        <Ionicons
          name="search"
          size={16}
          color={theme.colors.text.muted}
          style={styles.searchIcon}
        />
        <TextInput
          style={styles.searchInput}
          placeholder="Search products..."
          placeholderTextColor={theme.colors.text.muted}
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
          >
            <Ionicons name="close-circle" size={18} color={theme.colors.text.muted} />
          </PressableScale>
        )}
      </View>
      <CategoryFilter styles={styles} />
      <View style={styles.toolbar}>
        <Text style={styles.resultsCount}>{products.length} products</Text>
        <SortDropdown value={sortBy} onChange={setSortBy} styles={styles} theme={theme} />
      </View>
      {(searchQuery.length > 0 || selectedCategory !== 'All') && (
        <PressableScale
          style={styles.resetTopButton}
          onPress={() => {
            setSearchQuery('');
            useProductsStore.getState().setCategory('All');
          }}
          testID="reset-all"
        >
          <Text style={styles.resetTopButtonText}>Reset Filters</Text>
        </PressableScale>
      )}
    </>
  );

  return (
    <FlatList
      style={styles.container}
      data={products}
      numColumns={2}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.productsList}
      columnWrapperStyle={products.length > 0 ? styles.productsRow : undefined}
      renderItem={({ item }) => <ProductCard product={item} styles={styles} theme={theme} />}
      testID="products-list"
      accessibilityLabel="products-screen"
      contentInsetAdjustmentBehavior="automatic"
      ListHeaderComponent={ListHeader}
      ListEmptyComponent={
        <View style={styles.emptyState} testID="no-products">
          <View style={styles.emptyIconWrap}>
            <Ionicons name="search-outline" size={36} color={theme.colors.text.muted} />
          </View>
          <Text style={styles.emptyTitle}>No products found</Text>
          <Text style={styles.emptySubtitle}>Try adjusting your search or filters</Text>
          <PressableScale
            style={styles.resetButton}
            onPress={() => {
              setSearchQuery('');
              useProductsStore.getState().setCategory('All');
            }}
            testID="reset-filters"
          >
            <Text style={styles.resetButtonText}>Reset Filters</Text>
          </PressableScale>
        </View>
      }
    />
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.primary,
    },
    list: {
      flex: 1,
    },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: 16,
      marginTop: 8,
      marginBottom: 12,
      backgroundColor: theme.colors.background.tonal,
      borderRadius: theme.radii.md,
      paddingHorizontal: 14,
      ...theme.shadows.inset,
    },
    searchIcon: {
      marginRight: 8,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 11,
      fontSize: 15,
      color: theme.colors.text.primary,
    },
    clearSearch: {
      padding: 4,
    },
    categoryContainer: {
      marginBottom: 6,
    },
    categoryList: {
      paddingHorizontal: 16,
      gap: 8,
    },
    categoryChip: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      backgroundColor: theme.colors.background.tonal,
      borderRadius: theme.radii.pill,
    },
    categoryChipActive: {
      backgroundColor: theme.colors.accent.ink,
    },
    categoryChipText: {
      fontSize: 13,
      color: theme.colors.text.secondary,
      fontWeight: '500',
    },
    categoryChipTextActive: {
      color: theme.colors.text.onAccent,
      fontWeight: '600',
    },
    toolbar: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    resultsCount: {
      fontSize: 13,
      color: theme.colors.text.muted,
    },
    sortButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: theme.colors.background.tonal,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: theme.radii.pill,
    },
    sortButtonText: {
      fontSize: 13,
      color: theme.colors.text.primary,
      fontWeight: '500',
    },
    sortBackdrop: {
      flex: 1,
      backgroundColor: theme.colors.overlay,
      justifyContent: 'center',
      alignItems: 'center',
    },
    sortMenu: {
      backgroundColor: theme.colors.background.elevated,
      borderRadius: theme.radii.lg,
      width: '82%',
      paddingVertical: 6,
      ...theme.shadows.depth,
    },
    sortOption: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
    },
    sortOptionActive: {
      backgroundColor: theme.colors.background.tonal,
    },
    sortOptionText: {
      fontSize: 15,
      color: theme.colors.text.primary,
    },
    productsList: {
      paddingHorizontal: 12,
      paddingBottom: theme.spacing.lg,
    },
    productsRow: {
      justifyContent: 'space-between',
      paddingHorizontal: 4,
    },
    productCard: {
      width: '48%',
      backgroundColor: theme.colors.background.elevated,
      borderRadius: theme.radii.lg,
      marginBottom: 16,
      ...theme.shadows.soft,
    },
    productImage: {
      width: '100%',
      height: 150,
      backgroundColor: theme.colors.background.tonal,
      borderTopLeftRadius: theme.radii.lg,
      borderTopRightRadius: theme.radii.lg,
    },
    outOfStockBadge: {
      position: 'absolute',
      top: 8,
      left: 8,
      backgroundColor: theme.colors.overlay,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 4,
    },
    outOfStockText: {
      color: '#FFFFFF',
      fontSize: 10,
      fontWeight: '700',
    },
    productContent: {
      padding: 12,
    },
    productCategory: {
      fontSize: 10,
      color: theme.colors.text.muted,
      textTransform: 'uppercase',
      letterSpacing: 1.2,
      fontWeight: '600',
    },
    productName: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text.primary,
      marginTop: 4,
      lineHeight: 20,
    },
    productMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 6,
      gap: 4,
    },
    productRating: {
      fontSize: 12,
      color: theme.colors.text.secondary,
    },
    productReviews: {
      fontSize: 11,
      color: theme.colors.text.muted,
    },
    productFooter: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 10,
    },
    productPrice: {
      fontSize: 15,
      fontWeight: '700',
      color: theme.colors.text.primary,
    },
    addToCartBtn: {
      backgroundColor: theme.colors.accent.ink,
      width: 32,
      height: 32,
      borderRadius: theme.radii.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addToCartBtnDisabled: {
      backgroundColor: theme.colors.text.muted,
      opacity: 0.5,
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 40,
    },
    emptyIconWrap: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: theme.colors.background.tonal,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 16,
    },
    emptyTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: theme.colors.text.primary,
      marginBottom: 6,
    },
    emptySubtitle: {
      fontSize: 14,
      color: theme.colors.text.muted,
      textAlign: 'center',
    },
    resetButton: {
      marginTop: 18,
      paddingHorizontal: 22,
      paddingVertical: 11,
      backgroundColor: theme.colors.accent.ink,
      borderRadius: theme.radii.pill,
    },
    resetButtonText: {
      color: theme.colors.text.onAccent,
      fontWeight: '600',
      letterSpacing: 0.2,
    },
    resetTopButton: {
      marginHorizontal: 16,
      marginBottom: 6,
      paddingVertical: 7,
      paddingHorizontal: 14,
      alignSelf: 'flex-start',
      borderRadius: theme.radii.pill,
      backgroundColor: theme.colors.background.tonal,
    },
    resetTopButtonText: {
      color: theme.colors.text.primary,
      fontWeight: '600',
      fontSize: 12,
    },
  });
