import { create } from 'zustand';

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  image: string;
  category: string;
  rating: number;
  reviews: number;
  inStock: boolean;
  tags: string[];
}

export const mockProducts: Product[] = [
  {
    id: '1',
    name: 'Wireless Headphones',
    description: 'Premium noise-canceling wireless headphones with 30-hour battery life. Features high-resolution audio and comfortable over-ear design.',
    price: 299.99,
    image: 'https://picsum.photos/seed/headphones/400/400',
    category: 'Electronics',
    rating: 4.8,
    reviews: 1234,
    inStock: true,
    tags: ['audio', 'wireless', 'premium'],
  },
  {
    id: '2',
    name: 'Smart Watch Pro',
    description: 'Advanced fitness tracking smartwatch with heart rate monitoring, GPS, and 7-day battery life.',
    price: 449.99,
    image: 'https://picsum.photos/seed/smartwatch/400/400',
    category: 'Electronics',
    rating: 4.6,
    reviews: 892,
    inStock: true,
    tags: ['fitness', 'wearable', 'smart'],
  },
  {
    id: '3',
    name: 'Leather Messenger Bag',
    description: 'Handcrafted genuine leather messenger bag with laptop compartment. Perfect for professionals.',
    price: 189.99,
    image: 'https://picsum.photos/seed/bag/400/400',
    category: 'Accessories',
    rating: 4.9,
    reviews: 567,
    inStock: true,
    tags: ['leather', 'professional', 'bag'],
  },
  {
    id: '4',
    name: 'Mechanical Keyboard',
    description: 'RGB mechanical gaming keyboard with Cherry MX switches. Customizable macros and media controls.',
    price: 159.99,
    image: 'https://picsum.photos/seed/keyboard/400/400',
    category: 'Electronics',
    rating: 4.7,
    reviews: 2341,
    inStock: true,
    tags: ['gaming', 'mechanical', 'rgb'],
  },
  {
    id: '5',
    name: 'Running Shoes Elite',
    description: 'Professional running shoes with responsive cushioning and breathable mesh upper.',
    price: 179.99,
    image: 'https://picsum.photos/seed/shoes/400/400',
    category: 'Sports',
    rating: 4.5,
    reviews: 1876,
    inStock: true,
    tags: ['running', 'sports', 'comfort'],
  },
  {
    id: '6',
    name: 'Portable Charger 20000mAh',
    description: 'High-capacity portable charger with fast charging support. Charges up to 3 devices simultaneously.',
    price: 49.99,
    image: 'https://picsum.photos/seed/charger/400/400',
    category: 'Electronics',
    rating: 4.4,
    reviews: 3456,
    inStock: true,
    tags: ['power', 'portable', 'charging'],
  },
  {
    id: '7',
    name: 'Yoga Mat Premium',
    description: 'Extra-thick eco-friendly yoga mat with alignment lines. Non-slip surface for all yoga styles.',
    price: 79.99,
    image: 'https://picsum.photos/seed/yogamat/400/400',
    category: 'Sports',
    rating: 4.8,
    reviews: 789,
    inStock: true,
    tags: ['yoga', 'fitness', 'eco-friendly'],
  },
  {
    id: '8',
    name: 'Wireless Earbuds',
    description: 'True wireless earbuds with active noise cancellation and transparency mode. IPX5 water resistant.',
    price: 199.99,
    image: 'https://picsum.photos/seed/earbuds/400/400',
    category: 'Electronics',
    rating: 4.6,
    reviews: 4521,
    inStock: true,
    tags: ['audio', 'wireless', 'anc'],
  },
  {
    id: '9',
    name: 'Desk Lamp LED',
    description: 'Adjustable LED desk lamp with multiple brightness levels and color temperatures. USB charging port included.',
    price: 69.99,
    image: 'https://picsum.photos/seed/lamp/400/400',
    category: 'Decor',
    rating: 4.3,
    reviews: 654,
    inStock: true,
    tags: ['lighting', 'office', 'led'],
  },
  {
    id: '10',
    name: 'Coffee Maker Pro',
    description: 'Programmable coffee maker with built-in grinder. Makes up to 12 cups with thermal carafe.',
    price: 249.99,
    image: 'https://picsum.photos/seed/coffee/400/400',
    category: 'Decor',
    rating: 4.7,
    reviews: 1123,
    inStock: true,
    tags: ['coffee', 'kitchen', 'appliance'],
  },
];

export const categories = ['All', 'Electronics', 'Accessories', 'Sports', 'Decor'];

interface ProductsState {
  products: Product[];
  selectedCategory: string;
  searchQuery: string;
  sortBy: 'price-asc' | 'price-desc' | 'rating' | 'name';
  setCategory: (category: string) => void;
  setSearchQuery: (query: string) => void;
  setSortBy: (sort: 'price-asc' | 'price-desc' | 'rating' | 'name') => void;
  getFilteredProducts: () => Product[];
  getProductById: (id: string) => Product | undefined;
}

export const useProductsStore = create<ProductsState>((set, get) => ({
  products: mockProducts,
  selectedCategory: 'All',
  searchQuery: '',
  sortBy: 'rating',

  setCategory: (category: string) => set({ selectedCategory: category }),
  setSearchQuery: (query: string) => set({ searchQuery: query }),
  setSortBy: (sortBy) => set({ sortBy }),

  getFilteredProducts: () => {
    const { products, selectedCategory, searchQuery, sortBy } = get();

    let filtered = products;

    // Filter by category
    if (selectedCategory !== 'All') {
      filtered = filtered.filter(p => p.category === selectedCategory);
    }

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query) ||
        p.tags.some(t => t.toLowerCase().includes(query))
      );
    }

    // Sort
    switch (sortBy) {
      case 'price-asc':
        filtered = [...filtered].sort((a, b) => a.price - b.price);
        break;
      case 'price-desc':
        filtered = [...filtered].sort((a, b) => b.price - a.price);
        break;
      case 'rating':
        filtered = [...filtered].sort((a, b) => b.rating - a.rating);
        break;
      case 'name':
        filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
        break;
    }

    return filtered;
  },

  getProductById: (id: string) => {
    return get().products.find(p => p.id === id);
  },
}));
