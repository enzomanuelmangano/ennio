import { View, Text, StyleSheet, ScrollView, Pressable, Image } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { useAuthStore, useProductsStore, useCartStore, useSettingsStore } from '../../store';
import * as Haptics from 'expo-haptics';

function FeaturedProduct({ product }: { product: ReturnType<typeof useProductsStore.getState>['products'][0] }) {
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
        <Text style={styles.featuredTitle} numberOfLines={1}>{product.name}</Text>
        <Text style={styles.featuredPrice}>${product.price.toFixed(2)}</Text>
        <View style={styles.ratingContainer}>
          <Text style={styles.rating}>⭐ {product.rating}</Text>
          <Text style={styles.reviews}>({product.reviews})</Text>
        </View>
        <Pressable
          style={styles.addButton}
          onPress={handleAddToCart}
          testID={`add-to-cart-featured-${product.id}`}
        >
          <Text style={styles.addButtonText}>Add to Cart</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

function QuickAction({ icon, label, onPress, testID }: {
  icon: string;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable style={styles.quickAction} onPress={onPress} testID={testID}>
      <Text style={styles.quickActionIcon}>{icon}</Text>
      <Text style={styles.quickActionLabel}>{label}</Text>
    </Pressable>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const user = useAuthStore(state => state.user);
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const products = useProductsStore(state => state.products);
  const cartItemCount = useCartStore(state => state.getItemCount());
  const darkMode = useSettingsStore(state => state.preferences.darkMode);

  const featuredProducts = products.slice(0, 4);
  const trendingProducts = products.filter(p => p.rating >= 4.7).slice(0, 3);

  return (
    <ScrollView
      style={[styles.container, darkMode && styles.containerDark]}
      testID="home-screen"
    >
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={[styles.greeting, darkMode && styles.textLight]}>
            {isAuthenticated ? `Hello, ${user?.name?.split(' ')[0]}!` : 'Welcome!'}
          </Text>
          <Text style={[styles.subtitle, darkMode && styles.subtitleDark]}>
            Discover amazing products
          </Text>
        </View>
        {!isAuthenticated && (
          <Link href="/auth/login" asChild>
            <Pressable style={styles.signInButton} testID="home-signin-btn">
              <Text style={styles.signInText}>Sign In</Text>
            </Pressable>
          </Link>
        )}
      </View>

      {/* Quick Actions */}
      <View style={styles.quickActionsContainer}>
        <QuickAction
          icon="🔍"
          label="Search"
          onPress={() => router.push('/products')}
          testID="quick-action-search"
        />
        <QuickAction
          icon="🛒"
          label={`Cart (${cartItemCount})`}
          onPress={() => router.push('/cart')}
          testID="quick-action-cart"
        />
        <QuickAction
          icon="📦"
          label="Orders"
          onPress={() => router.push('/orders')}
          testID="quick-action-orders"
        />
        <QuickAction
          icon="⚙️"
          label="Settings"
          onPress={() => router.push('/settings')}
          testID="quick-action-settings"
        />
      </View>

      {/* Featured Products */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, darkMode && styles.textLight]}>Featured Products</Text>
          <Link href="/products" asChild>
            <Pressable testID="see-all-featured">
              <Text style={styles.seeAll}>See All</Text>
            </Pressable>
          </Link>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.featuredScroll}
        >
          {featuredProducts.map(product => (
            <FeaturedProduct key={product.id} product={product} />
          ))}
        </ScrollView>
      </View>

      {/* Trending */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, darkMode && styles.textLight]}>Trending Now</Text>
        {trendingProducts.map(product => (
          <Pressable
            key={product.id}
            style={[styles.trendingItem, darkMode && styles.cardDark]}
            onPress={() => router.push(`/product/${product.id}`)}
            testID={`trending-product-${product.id}`}
          >
            <Image source={{ uri: product.image }} style={styles.trendingImage} />
            <View style={styles.trendingContent}>
              <Text style={[styles.trendingTitle, darkMode && styles.textLight]}>{product.name}</Text>
              <Text style={[styles.trendingCategory, darkMode && styles.subtitleDark]}>{product.category}</Text>
              <View style={styles.trendingBottom}>
                <Text style={styles.trendingPrice}>${product.price.toFixed(2)}</Text>
                <Text style={styles.trendingRating}>⭐ {product.rating}</Text>
              </View>
            </View>
          </Pressable>
        ))}
      </View>

      {/* Categories */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, darkMode && styles.textLight]}>Shop by Category</Text>
        <View style={styles.categoriesGrid}>
          {['Electronics', 'Sports', 'Home', 'Accessories'].map(category => (
            <Pressable
              key={category}
              style={[styles.categoryCard, darkMode && styles.cardDark]}
              onPress={() => {
                useProductsStore.getState().setCategory(category);
                router.push('/products');
              }}
              testID={`category-${category.toLowerCase()}`}
            >
              <Text style={styles.categoryIcon}>
                {category === 'Electronics' ? '📱' :
                 category === 'Sports' ? '⚽' :
                 category === 'Home' ? '🏠' : '👜'}
              </Text>
              <Text style={[styles.categoryLabel, darkMode && styles.textLight]}>{category}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Promo Banner */}
      <View style={styles.promoBanner} testID="promo-banner">
        <Text style={styles.promoTitle}>🎉 Summer Sale!</Text>
        <Text style={styles.promoSubtitle}>Up to 50% off on selected items</Text>
        <Link href="/products" asChild>
          <Pressable style={styles.promoButton} testID="promo-shop-now">
            <Text style={styles.promoButtonText}>Shop Now</Text>
          </Pressable>
        </Link>
      </View>

      <View style={styles.bottomPadding} />
    </ScrollView>
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingTop: 10,
  },
  greeting: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#1a1a2e',
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginTop: 4,
  },
  subtitleDark: {
    color: '#aaa',
  },
  textLight: {
    color: '#ffffff',
  },
  signInButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  signInText: {
    color: '#fff',
    fontWeight: '600',
  },
  quickActionsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 10,
    paddingVertical: 15,
  },
  quickAction: {
    alignItems: 'center',
    padding: 12,
  },
  quickActionIcon: {
    fontSize: 28,
    marginBottom: 6,
  },
  quickActionLabel: {
    fontSize: 12,
    color: '#666',
    fontWeight: '500',
  },
  section: {
    padding: 20,
    paddingTop: 10,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 15,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1a1a2e',
    marginBottom: 15,
  },
  seeAll: {
    color: '#007AFF',
    fontWeight: '600',
  },
  featuredScroll: {
    paddingRight: 20,
  },
  featuredCard: {
    width: 180,
    backgroundColor: '#fff',
    borderRadius: 12,
    marginRight: 15,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  featuredImage: {
    width: '100%',
    height: 120,
    backgroundColor: '#f0f0f0',
  },
  featuredContent: {
    padding: 12,
  },
  featuredTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  featuredPrice: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#007AFF',
    marginTop: 4,
  },
  ratingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  rating: {
    fontSize: 12,
    color: '#666',
  },
  reviews: {
    fontSize: 12,
    color: '#999',
    marginLeft: 4,
  },
  addButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 8,
    borderRadius: 6,
    marginTop: 10,
    alignItems: 'center',
  },
  addButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 12,
  },
  trendingItem: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 12,
    marginBottom: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  cardDark: {
    backgroundColor: '#1a1a2e',
  },
  trendingImage: {
    width: 100,
    height: 100,
    backgroundColor: '#f0f0f0',
  },
  trendingContent: {
    flex: 1,
    padding: 12,
    justifyContent: 'space-between',
  },
  trendingTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  trendingCategory: {
    fontSize: 12,
    color: '#666',
  },
  trendingBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  trendingPrice: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  trendingRating: {
    fontSize: 12,
    color: '#666',
  },
  categoriesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -8,
  },
  categoryCard: {
    width: '45%',
    margin: '2.5%',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  categoryIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  categoryLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a2e',
  },
  promoBanner: {
    margin: 20,
    padding: 24,
    backgroundColor: '#FF6B6B',
    borderRadius: 16,
    alignItems: 'center',
  },
  promoTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  promoSubtitle: {
    fontSize: 14,
    color: '#fff',
    marginTop: 4,
    opacity: 0.9,
  },
  promoButton: {
    backgroundColor: '#fff',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 20,
    marginTop: 16,
  },
  promoButtonText: {
    color: '#FF6B6B',
    fontWeight: 'bold',
  },
  bottomPadding: {
    height: 40,
  },
});
