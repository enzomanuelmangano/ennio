import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Product } from './products';

export interface CartItem {
  product: Product;
  quantity: number;
}

export interface Order {
  id: string;
  items: CartItem[];
  total: number;
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  date: string;
  shippingAddress: string;
}

interface CartState {
  items: CartItem[];
  orders: Order[];
  addToCart: (product: Product, quantity?: number) => void;
  removeFromCart: (productId: string) => void;
  updateQuantity: (productId: string, quantity: number) => void;
  clearCart: () => void;
  getItemCount: () => number;
  getTotal: () => number;
  getSubtotal: () => number;
  getTax: () => number;
  checkout: (shippingAddress: string) => Promise<Order>;
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      orders: [],

      addToCart: (product: Product, quantity = 1) => {
        const { items } = get();
        const existingItem = items.find(item => item.product.id === product.id);

        if (existingItem) {
          set({
            items: items.map(item =>
              item.product.id === product.id
                ? { ...item, quantity: item.quantity + quantity }
                : item
            ),
          });
        } else {
          set({ items: [...items, { product, quantity }] });
        }
      },

      removeFromCart: (productId: string) => {
        set({ items: get().items.filter(item => item.product.id !== productId) });
      },

      updateQuantity: (productId: string, quantity: number) => {
        if (quantity <= 0) {
          get().removeFromCart(productId);
          return;
        }

        set({
          items: get().items.map(item =>
            item.product.id === productId ? { ...item, quantity } : item
          ),
        });
      },

      clearCart: () => set({ items: [] }),

      getItemCount: () => {
        return get().items.reduce((sum, item) => sum + item.quantity, 0);
      },

      getSubtotal: () => {
        return get().items.reduce(
          (sum, item) => sum + item.product.price * item.quantity,
          0
        );
      },

      getTax: () => {
        return get().getSubtotal() * 0.1; // 10% tax
      },

      getTotal: () => {
        return get().getSubtotal() + get().getTax();
      },

      checkout: async (shippingAddress: string) => {
        const { items, getTotal } = get();

        // Simulate checkout API call
        await new Promise(resolve => setTimeout(resolve, 1500));

        const order: Order = {
          id: `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          items: [...items],
          total: getTotal(),
          status: 'processing',
          date: new Date().toISOString(),
          shippingAddress,
        };

        set(state => ({
          orders: [order, ...state.orders],
          items: [],
        }));

        return order;
      },
    }),
    {
      name: 'cart-storage',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ items: state.items, orders: state.orders }),
    }
  )
);
