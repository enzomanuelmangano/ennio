import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  Pressable,
  useColorScheme,
} from 'react-native';
import { PressableScale } from 'pressto';
import { Link, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useAuthStore,
  useProductsStore,
  useCartStore,
  useSettingsStore,
} from '../../store';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, lineHeight, radius } from '../../src/theme';

function FeaturedProduct({
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
    addToCart(product);
    if (hapticEnabled) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  return (
    <Pressable
      style={[
        styles.featuredCard,
        { backgroundColor: c.secondarySystemGroupedBackground },
      ]}
      onPress={() => router.push(`/product/${product.id}`)}
      testID={`featured-product-${product.id}`}
    >
      <Image source={{ uri: product.image }} style={styles.featuredImage} />
      <View style={styles.featuredContent}>
        <Text
          style={[styles.featuredTitle, { color: c.label }]}
          numberOfLines={1}
        >
          {product.name}
        </Text>
        <View style={styles.featuredRow}>
          <Text style={[styles.featuredPrice, { color: c.label }]}>
            ${product.price.toFixed(2)}
          </Text>
          <Text style={[styles.featuredRating, { color: c.secondaryLabel }]}>
            ★ {product.rating}
          </Text>
        </View>
        <Pressable
          style={[styles.addPill, { backgroundColor: c.systemBlue }]}
          onPress={handleAddToCart}
          testID={`add-to-cart-featured-${product.id}`}
        >
          <Text style={styles.addPillText}>Add to Cart</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

function QuickAction({
  symbol,
  label,
  tint,
  onPress,
  testID,
  c,
}: {
  symbol: string;
  label: string;
  tint: string;
  onPress: () => void;
  testID: string;
  c: ReturnType<typeof colors>;
}) {
  return (
    <PressableScale
      style={styles.quickAction}
      onPress={onPress}
      testID={testID}
    >
      <View style={[styles.quickActionIcon, { backgroundColor: tint + '22' }]}>
        <Text style={[styles.quickActionGlyph, { color: tint }]}>{symbol}</Text>
      </View>
      <Text style={[styles.quickActionLabel, { color: c.label }]}>{label}</Text>
    </PressableScale>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const user = useAuthStore(state => state.user);
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const products = useProductsStore(state => state.products);
  const cartItemCount = useCartStore(state => state.getItemCount());
  const darkMode = useSettingsStore(state => state.preferences.darkMode);
  const systemScheme = useColorScheme();
  const scheme = darkMode ? 'dark' : systemScheme === 'dark' ? 'dark' : 'light';
  const c = colors(scheme);
  const insets = useSafeAreaInsets();
  const TAB_BAR_HEIGHT = 49;

  const featuredProducts = products.slice(0, 4);
  const trendingProducts = products.filter(p => p.rating >= 4.7).slice(0, 3);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: c.systemGroupedBackground }]}
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24,
      }}
      showsVerticalScrollIndicator={false}
      testID="home-screen"
    >
      {/* Large title header */}
      <View style={styles.header}>
        <View style={styles.headerTextWrap}>
          <Text style={[styles.greeting, { color: c.secondaryLabel }]}>
            {isAuthenticated ? 'Welcome back' : 'Welcome'}
          </Text>
          <Text style={[styles.largeTitle, { color: c.label }]}>
            {isAuthenticated && user?.name
              ? user.name.split(' ')[0]
              : 'Discover'}
          </Text>
        </View>
        {!isAuthenticated && (
          <PressableScale
            style={[styles.signInButton, { backgroundColor: c.systemBlue }]}
            onPress={() => router.push('/auth/login')}
            testID="home-signin-btn"
          >
            <Text style={styles.signInText}>Sign In</Text>
          </PressableScale>
        )}
      </View>

      {/* Quick Actions */}
      <View
        style={[
          styles.quickActionsCard,
          { backgroundColor: c.secondarySystemGroupedBackground },
        ]}
      >
        <QuickAction
          symbol="⌕"
          label="Search"
          tint={c.systemBlue}
          onPress={() => router.push('/products')}
          testID="quick-action-search"
          c={c}
        />
        <QuickAction
          symbol="◔"
          label={`Cart${cartItemCount > 0 ? ` (${cartItemCount})` : ''}`}
          tint={c.systemPink}
          onPress={() => router.push('/cart')}
          testID="quick-action-cart"
          c={c}
        />
        <QuickAction
          symbol="◫"
          label="Orders"
          tint={c.systemOrange}
          onPress={() => router.push('/orders')}
          testID="quick-action-orders"
          c={c}
        />
        <QuickAction
          symbol="⚙"
          label="Settings"
          tint={c.systemPurple}
          onPress={() => router.push('/settings')}
          testID="quick-action-settings"
          c={c}
        />
      </View>

      {/* Featured Products */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: c.label }]}>
            Featured Products
          </Text>
          <Link href="/products" asChild>
            <PressableScale testID="see-all-featured" hitSlop={8}>
              <Text style={[styles.seeAll, { color: c.systemBlue }]}>
                See All
              </Text>
            </PressableScale>
          </Link>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.featuredScroll}
        >
          {featuredProducts.map(product => (
            <FeaturedProduct key={product.id} product={product} c={c} />
          ))}
        </ScrollView>
      </View>

      {/* Trending — inset-grouped list */}
      <View style={styles.section}>
        <Text
          style={[
            styles.sectionTitleSmall,
            { color: c.secondaryLabel, marginLeft: 16 },
          ]}
        >
          TRENDING NOW
        </Text>
        <View
          style={[
            styles.groupedCard,
            { backgroundColor: c.secondarySystemGroupedBackground },
          ]}
        >
          {trendingProducts.map((product, idx) => (
            <Pressable
              key={product.id}
              style={({ pressed }) => [
                styles.trendingItem,
                pressed && {
                  backgroundColor: c.tertiarySystemFill,
                },
              ]}
              onPress={() => router.push(`/product/${product.id}`)}
              testID={`trending-product-${product.id}`}
            >
              <Image
                source={{ uri: product.image }}
                style={styles.trendingImage}
              />
              <View style={styles.trendingContent}>
                <Text
                  style={[styles.trendingTitle, { color: c.label }]}
                  numberOfLines={1}
                >
                  {product.name}
                </Text>
                <Text
                  style={[
                    styles.trendingCategory,
                    { color: c.secondaryLabel },
                  ]}
                >
                  {product.category}
                </Text>
                <View style={styles.trendingBottom}>
                  <Text style={[styles.trendingPrice, { color: c.label }]}>
                    ${product.price.toFixed(2)}
                  </Text>
                  <Text
                    style={[
                      styles.trendingRating,
                      { color: c.secondaryLabel },
                    ]}
                  >
                    ★ {product.rating}
                  </Text>
                </View>
              </View>
              <Text style={[styles.chevron, { color: c.tertiaryLabel }]}>
                ›
              </Text>
              {idx < trendingProducts.length - 1 && (
                <View
                  style={[
                    styles.rowSeparator,
                    { backgroundColor: c.separator },
                  ]}
                />
              )}
            </Pressable>
          ))}
        </View>
      </View>

      {/* Categories */}
      <View style={styles.section}>
        <Text
          style={[
            styles.sectionTitleSmall,
            { color: c.secondaryLabel, marginLeft: 16 },
          ]}
        >
          SHOP BY CATEGORY
        </Text>
        <View style={styles.categoriesGrid}>
          {(
            [
              { name: 'Electronics', symbol: '⌬', tint: c.systemBlue },
              { name: 'Sports', symbol: '◉', tint: c.systemGreen },
              { name: 'Home', symbol: '⌂', tint: c.systemOrange },
              { name: 'Accessories', symbol: '◊', tint: c.systemPurple },
            ] as const
          ).map(({ name, symbol, tint }) => (
            <PressableScale
              key={name}
              style={[
                styles.categoryCard,
                { backgroundColor: c.secondarySystemGroupedBackground },
              ]}
              onPress={() => {
                useProductsStore.getState().setCategory(name);
                router.push('/products');
              }}
              testID={`category-${name.toLowerCase()}`}
            >
              <View
                style={[
                  styles.categoryIconBg,
                  { backgroundColor: tint + '22' },
                ]}
              >
                <Text style={[styles.categoryIcon, { color: tint }]}>
                  {symbol}
                </Text>
              </View>
              <Text style={[styles.categoryLabel, { color: c.label }]}>
                {name}
              </Text>
            </PressableScale>
          ))}
        </View>
      </View>

      {/* Promo Banner */}
      <View style={styles.section}>
        <View
          style={[styles.promoBanner, { backgroundColor: c.systemBlue }]}
          testID="promo-banner"
        >
          <View style={styles.promoText}>
            <Text style={styles.promoEyebrow}>SUMMER SALE</Text>
            <Text style={styles.promoTitle}>Up to 50% off</Text>
            <Text style={styles.promoSubtitle}>Selected items, today only</Text>
          </View>
          <Link href="/products" asChild>
            <PressableScale style={styles.promoButton} testID="promo-shop-now">
              <Text style={[styles.promoButtonText, { color: c.systemBlue }]}>
                Shop Now
              </Text>
            </PressableScale>
          </Link>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 18,
  },
  headerTextWrap: {
    flex: 1,
  },
  greeting: {
    fontSize: fontSize.subhead,
    lineHeight: lineHeight.subhead,
    fontWeight: '500',
  },
  largeTitle: {
    fontSize: fontSize.largeTitle,
    lineHeight: lineHeight.largeTitle,
    fontWeight: '700',
    letterSpacing: 0.37,
    marginTop: 2,
  },
  signInButton: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: radius.pill,
  },
  signInText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: fontSize.subhead,
  },
  quickActionsCard: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginHorizontal: 16,
    paddingVertical: 16,
    borderRadius: radius.card,
  },
  quickAction: {
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  quickActionIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  quickActionGlyph: {
    fontSize: 24,
    fontWeight: '600',
  },
  quickActionLabel: {
    fontSize: fontSize.caption1,
    lineHeight: lineHeight.caption1,
    fontWeight: '500',
  },
  section: {
    marginTop: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: fontSize.title2,
    lineHeight: lineHeight.title2,
    fontWeight: '700',
    letterSpacing: 0.35,
  },
  sectionTitleSmall: {
    fontSize: fontSize.footnote,
    lineHeight: lineHeight.footnote,
    fontWeight: '400',
    textTransform: 'uppercase',
    marginBottom: 8,
    marginHorizontal: 4,
  },
  seeAll: {
    fontSize: fontSize.body,
    fontWeight: '400',
  },
  featuredScroll: {
    paddingHorizontal: 20,
    paddingRight: 4,
  },
  featuredCard: {
    width: 200,
    borderRadius: radius.card,
    marginRight: 12,
    overflow: 'hidden',
  },
  featuredImage: {
    width: '100%',
    height: 130,
    backgroundColor: 'rgba(120,120,128,0.12)',
  },
  featuredContent: {
    padding: 12,
  },
  featuredTitle: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
  },
  featuredRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
  },
  featuredPrice: {
    fontSize: fontSize.body,
    fontWeight: '700',
  },
  featuredRating: {
    fontSize: fontSize.footnote,
    fontWeight: '500',
  },
  addPill: {
    marginTop: 10,
    paddingVertical: 8,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  addPillText: {
    color: '#FFFFFF',
    fontSize: fontSize.footnote,
    fontWeight: '600',
  },
  groupedCard: {
    marginHorizontal: 16,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  trendingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  trendingImage: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: 'rgba(120,120,128,0.12)',
  },
  trendingContent: {
    flex: 1,
    marginLeft: 12,
  },
  trendingTitle: {
    fontSize: fontSize.body,
    fontWeight: '600',
  },
  trendingCategory: {
    fontSize: fontSize.footnote,
    marginTop: 1,
  },
  trendingBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  trendingPrice: {
    fontSize: fontSize.subhead,
    fontWeight: '700',
  },
  trendingRating: {
    fontSize: fontSize.footnote,
    fontWeight: '500',
  },
  rowSeparator: {
    position: 'absolute',
    bottom: 0,
    left: 80,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },
  chevron: {
    fontSize: 22,
    fontWeight: '400',
    marginLeft: 6,
  },
  categoriesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
  },
  categoryCard: {
    width: '50%',
    padding: 6,
    paddingHorizontal: 4,
    flexDirection: 'row',
    alignItems: 'center',
  },
  categoryIconBg: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    marginLeft: 8,
  },
  categoryIcon: {
    fontSize: 22,
    fontWeight: '600',
  },
  categoryLabel: {
    fontSize: fontSize.subhead,
    fontWeight: '600',
  },
  promoBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    padding: 18,
    borderRadius: radius.card,
  },
  promoText: {
    flex: 1,
  },
  promoEyebrow: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: fontSize.caption2,
    fontWeight: '700',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  promoTitle: {
    fontSize: fontSize.title2,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  promoSubtitle: {
    fontSize: fontSize.footnote,
    color: 'rgba(255,255,255,0.85)',
    marginTop: 2,
  },
  promoButton: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: radius.pill,
    marginLeft: 12,
  },
  promoButtonText: {
    fontWeight: '600',
    fontSize: fontSize.subhead,
  },
});
