import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  register: (name: string, email: string, password: string) => Promise<boolean>;
  logout: () => void;
  updateProfile: (updates: Partial<User>) => void;
}

// Simulated users database
const mockUsers: Record<string, { password: string; user: User }> = {
  'demo@example.com': {
    password: 'password123',
    user: {
      id: '1',
      email: 'demo@example.com',
      name: 'Demo User',
      avatar: 'https://i.pravatar.cc/150?u=demo',
    },
  },
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,

      login: async (email: string, password: string) => {
        set({ isLoading: true });

        // Simulate API call
        await new Promise(resolve => setTimeout(resolve, 1000));

        const mockUser = mockUsers[email.toLowerCase()];
        if (mockUser && mockUser.password === password) {
          set({ user: mockUser.user, isAuthenticated: true, isLoading: false });
          return true;
        }

        set({ isLoading: false });
        return false;
      },

      register: async (name: string, email: string, password: string) => {
        set({ isLoading: true });

        // Simulate API call
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Check if user exists
        if (mockUsers[email.toLowerCase()]) {
          set({ isLoading: false });
          return false;
        }

        // Create new user
        const newUser: User = {
          id: Date.now().toString(),
          email: email.toLowerCase(),
          name,
          avatar: `https://i.pravatar.cc/150?u=${email}`,
        };

        mockUsers[email.toLowerCase()] = { password, user: newUser };
        set({ user: newUser, isAuthenticated: true, isLoading: false });
        return true;
      },

      logout: () => {
        set({ user: null, isAuthenticated: false });
      },

      updateProfile: (updates: Partial<User>) => {
        const { user } = get();
        if (user) {
          set({ user: { ...user, ...updates } });
        }
      },
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ user: state.user, isAuthenticated: state.isAuthenticated }),
    }
  )
);
