import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, Image, Pressable } from 'react-native';
import { PressableScale } from 'pressto';
import { Link, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore, useProductsStore, useCartStore, useSettingsStore } from '../../../store';
import { useTheme, type Theme } from '../../../theme';
import * as Haptics from 'expo-haptics';

const CATEGORY_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  Electronics: 'phone-portrait-outline',
  Sports: 'football-outline',
  Decor: 'home-outline',
  Accessories: 'bag-handle-outline',
};

function FeaturedProduct({
  product,
  styles,
  theme,
}: {
  product: ReturnType<typeof useProductsStore.getState>['products'][0];
  styles: ReturnType<typeof createStyles>;
  theme: Theme;
}) {
  const router = useRouter();
  const addToCart = useCartStore(state => state.addToCart);
  const hapticEnabled = useSettingsStore(state => state.preferences.hapticFeedback);

  const handleAddToCart = () => {
    addToCart(product);
    if (hapticEnabled) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  return (
    <Pressable
      style={styles.featuredCard}
      onPress={() => router.push(`/product/${product.id}`)}
      testID={`featured-product-${product.id}`}
    >
      <Image source={{ uri: product.image }} style={styles.featuredImage} />
      <View style={styles.featuredContent}>
        <Text style={styles.featuredCategory}>{product.category.toUpperCase()}</Text>
        <Text style={styles.featuredTitle} numberOfLines={1}>{product.name}</Text>
        <View style={styles.featuredFooter}>
          <Text style={styles.featuredPrice}>${product.price.toFixed(2)}</Text>
          <Pressable
            style={styles.featuredAddBtn}
            onPress={handleAddToCart}
            testID={`add-to-cart-featured-${product.id}`}
          >
            <Ionicons name="add" size={18} color={theme.colors.text.onAccent} />
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
}

function QuickAction({
  icon,
  label,
  onPress,
  testID,
  styles,
  theme,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  testID: string;
  styles: ReturnType<typeof createStyles>;
  theme: Theme;
}) {
  return (
    <PressableScale style={styles.quickAction} onPress={onPress} testID={testID}>
      <View style={styles.quickActionIconWrap}>
        <Ionicons name={icon} size={20} color={theme.colors.text.primary} />
      </View>
      <Text style={styles.quickActionLabel}>{label}</Text>
    </PressableScale>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const user = useAuthStore(state => state.user);
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const products = useProductsStore(state => state.products);
  const cartItemCount = useCartStore(state => state.getItemCount());
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const TAB_BAR_HEIGHT = 49;

  const featuredProducts = products.slice(0, 4);
  const trendingProducts = products.filter(p => p.rating >= 4.7).slice(0, 3);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 16 }}
      contentInsetAdjustmentBehavior="automatic"
      testID="home-screen"
    >
      {!isAuthenticated && (
        <View style={styles.signInRow}>
          <Text style={styles.subtitle}>Sign in to personalize your shop.</Text>
          <PressableScale
            style={styles.signInButton}
            onPress={() => router.push('/auth/login')}
            testID="home-signin-btn"
          >
            <Text style={styles.signInText}>Sign In</Text>
          </PressableScale>
        </View>
      )}
      {isAuthenticated && (
        <Text style={styles.subtitleAuthed}>
          Hello, {user?.name?.split(' ')[0]} — discover something elevated
        </Text>
      )}

      <View style={styles.quickActionsContainer}>
        <QuickAction
          icon="search-outline"
          label="Search"
          onPress={() => router.push('/(tabs)/(products)')}
          testID="quick-action-search"
          styles={styles}
          theme={theme}
        />
        <QuickAction
          icon="cart-outline"
          label={`Cart${cartItemCount > 0 ? ` (${cartItemCount})` : ''}`}
          onPress={() => router.push('/(tabs)/(cart)')}
          testID="quick-action-cart"
          styles={styles}
          theme={theme}
        />
        <QuickAction
          icon="cube-outline"
          label="Orders"
          onPress={() => router.push('/orders')}
          testID="quick-action-orders"
          styles={styles}
          theme={theme}
        />
        <QuickAction
          icon="settings-outline"
          label="Settings"
          onPress={() => router.push('/settings')}
          testID="quick-action-settings"
          styles={styles}
          theme={theme}
        />
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Featured</Text>
          <Link href="/(tabs)/(products)" asChild>
            <PressableScale testID="see-all-featured">
              <Text style={styles.seeAll}>See All</Text>
            </PressableScale>
          </Link>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.featuredScroll}
        >
          {featuredProducts.map(product => (
            <FeaturedProduct key={product.id} product={product} styles={styles} theme={theme} />
          ))}
        </ScrollView>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Trending Now</Text>
        {trendingProducts.map(product => (
          <PressableScale
            key={product.id}
            style={styles.trendingItem}
            onPress={() => router.push(`/product/${product.id}`)}
            testID={`trending-product-${product.id}`}
          >
            <Image source={{ uri: product.image }} style={styles.trendingImage} />
            <View style={styles.trendingContent}>
              <Text style={styles.trendingCategory}>{product.category.toUpperCase()}</Text>
              <Text style={styles.trendingTitle} numberOfLines={2}>{product.name}</Text>
              <View style={styles.trendingBottom}>
                <Text style={styles.trendingPrice}>${product.price.toFixed(2)}</Text>
                <View style={styles.ratingPill}>
                  <Ionicons name="star" size={11} color={theme.colors.star} />
                  <Text style={styles.ratingText}>{product.rating}</Text>
                </View>
              </View>
            </View>
          </PressableScale>
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Shop by Category</Text>
        <View style={styles.categoriesGrid}>
          {(['Electronics', 'Sports', 'Decor', 'Accessories'] as const).map(category => (
            <PressableScale
              key={category}
              style={styles.categoryCard}
              onPress={() => {
                useProductsStore.getState().setCategory(category);
                router.push('/(tabs)/(products)');
              }}
              testID={`category-${category.toLowerCase()}`}
            >
              <View style={styles.categoryIconWrap}>
                <Ionicons name={CATEGORY_ICON[category]} size={22} color={theme.colors.accent.champagneDeep} />
              </View>
              <Text style={styles.categoryLabel}>{category}</Text>
            </PressableScale>
          ))}
        </View>
      </View>

      <View style={styles.promoBanner} testID="promo-banner">
        <Text style={styles.promoEyebrow}>SEASONAL EDIT</Text>
        <Text style={styles.promoTitle}>Summer Sale</Text>
        <Text style={styles.promoSubtitle}>Up to 50% off curated pieces</Text>
        <Link href="/(tabs)/(products)" asChild>
          <PressableScale style={styles.promoButton} testID="promo-shop-now">
            <Text style={styles.promoButtonText}>Shop Now</Text>
            <Ionicons name="arrow-forward" size={16} color={theme.colors.accent.ink} />
          </PressableScale>
        </Link>
      </View>

      <View style={styles.bottomPadding} />
    </ScrollView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.primary,
    },
    signInRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 4,
      gap: 12,
    },
    subtitle: {
      flex: 1,
      fontSize: 14,
      color: theme.colors.text.muted,
      letterSpacing: 0.1,
    },
    subtitleAuthed: {
      fontSize: 14,
      color: theme.colors.text.muted,
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 4,
      letterSpacing: 0.1,
    },
    signInButton: {
      backgroundColor: theme.colors.accent.ink,
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: theme.radii.pill,
    },
    signInText: {
      color: theme.colors.text.onAccent,
      fontWeight: '600',
      letterSpacing: 0.2,
    },

    quickActionsContainer: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      paddingHorizontal: 12,
      paddingVertical: 18,
    },
    quickAction: {
      alignItems: 'center',
      paddingHorizontal: 8,
    },
    quickActionIconWrap: {
      width: 52,
      height: 52,
      borderRadius: theme.radii.md,
      backgroundColor: theme.colors.background.tonal,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 8,
      ...theme.shadows.inset,
    },
    quickActionLabel: {
      fontSize: 12,
      color: theme.colors.text.secondary,
      fontWeight: '500',
    },

    section: {
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 16,
    },
    sectionHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 14,
    },
    sectionTitle: {
      fontSize: 22,
      fontWeight: '700',
      color: theme.colors.text.primary,
      marginBottom: 14,
      letterSpacing: -0.4,
    },
    seeAll: {
      color: theme.colors.text.primary,
      fontWeight: '600',
      fontSize: 13,
      textDecorationLine: 'underline',
    },

    featuredScroll: {
      paddingRight: 20,
      gap: 14,
    },
    featuredCard: {
      width: 220,
      backgroundColor: theme.colors.background.elevated,
      borderRadius: theme.radii.lg,
      overflow: 'hidden',
      ...theme.shadows.depth,
    },
    featuredImage: {
      width: '100%',
      height: 200,
      backgroundColor: theme.colors.background.tonal,
    },
    featuredContent: {
      padding: 14,
    },
    featuredCategory: {
      fontSize: 10,
      color: theme.colors.text.muted,
      letterSpacing: 1.2,
      fontWeight: '600',
    },
    featuredTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text.primary,
      marginTop: 4,
      letterSpacing: -0.2,
    },
    featuredFooter: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 12,
    },
    featuredPrice: {
      fontSize: 17,
      fontWeight: '700',
      color: theme.colors.text.primary,
      letterSpacing: -0.3,
    },
    featuredAddBtn: {
      width: 34,
      height: 34,
      borderRadius: theme.radii.pill,
      backgroundColor: theme.colors.accent.ink,
      alignItems: 'center',
      justifyContent: 'center',
    },

    trendingItem: {
      flexDirection: 'row',
      backgroundColor: theme.colors.background.elevated,
      borderRadius: theme.radii.lg,
      marginBottom: 12,
      overflow: 'hidden',
      ...theme.shadows.soft,
    },
    trendingImage: {
      width: 110,
      height: 110,
      backgroundColor: theme.colors.background.tonal,
    },
    trendingContent: {
      flex: 1,
      padding: 14,
      justifyContent: 'space-between',
    },
    trendingCategory: {
      fontSize: 10,
      color: theme.colors.text.muted,
      letterSpacing: 1.2,
      fontWeight: '600',
    },
    trendingTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text.primary,
      marginTop: 2,
      letterSpacing: -0.2,
    },
    trendingBottom: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 6,
    },
    trendingPrice: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.colors.text.primary,
      letterSpacing: -0.3,
    },
    ratingPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: theme.colors.background.tonal,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: theme.radii.pill,
    },
    ratingText: {
      fontSize: 11,
      color: theme.colors.text.secondary,
      fontWeight: '600',
    },

    categoriesGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginHorizontal: -6,
    },
    categoryCard: {
      width: '46%',
      margin: '2%',
      backgroundColor: theme.colors.background.elevated,
      borderRadius: theme.radii.lg,
      paddingVertical: 22,
      alignItems: 'center',
      ...theme.shadows.soft,
    },
    categoryIconWrap: {
      width: 50,
      height: 50,
      borderRadius: theme.radii.md,
      backgroundColor: theme.colors.background.tonal,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 10,
    },
    categoryLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text.primary,
      letterSpacing: -0.1,
    },

    promoBanner: {
      marginHorizontal: 20,
      marginTop: 8,
      padding: 28,
      backgroundColor: theme.colors.accent.ink,
      borderRadius: theme.radii.xl,
      ...theme.shadows.depth,
    },
    promoEyebrow: {
      fontSize: 11,
      color: theme.colors.accent.champagne,
      letterSpacing: 1.6,
      fontWeight: '700',
      marginBottom: 8,
    },
    promoTitle: {
      fontSize: 30,
      fontWeight: '700',
      color: theme.colors.text.onAccent,
      letterSpacing: -0.6,
    },
    promoSubtitle: {
      fontSize: 14,
      color: theme.colors.text.onAccent,
      marginTop: 6,
      opacity: 0.78,
    },
    promoButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: theme.colors.background.elevated,
      paddingHorizontal: 22,
      paddingVertical: 12,
      borderRadius: theme.radii.pill,
      marginTop: 18,
      alignSelf: 'flex-start',
    },
    promoButtonText: {
      color: theme.colors.accent.ink,
      fontWeight: '700',
      letterSpacing: 0.2,
    },

    bottomPadding: {
      height: 24,
    },
  });
