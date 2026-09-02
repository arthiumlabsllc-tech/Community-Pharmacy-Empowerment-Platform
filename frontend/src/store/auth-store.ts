import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  role: string;
  avatar_url?: string;
  preferred_language?: string;
}

interface Pharmacy {
  id: string;
  name: string;
  license_number?: string;
  subscription_tier: string;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;
  pharmacy: Pharmacy | null;
  isAuthenticated: boolean;
  _hasHydrated: boolean;
  setAuth: (data: { accessToken: string; refreshToken: string; user: User; pharmacy: Pharmacy }) => void;
  logout: () => void;
  updateUser: (user: Partial<User>) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      pharmacy: null,
      isAuthenticated: false,
      _hasHydrated: false,

      setAuth: ({ accessToken, refreshToken, user, pharmacy }) =>
        set({
          accessToken,
          refreshToken,
          user,
          pharmacy,
          isAuthenticated: true,
        }),

      logout: () =>
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          pharmacy: null,
          isAuthenticated: false,
        }),

      updateUser: (updates) =>
        set((state) => ({
          user: state.user ? { ...state.user, ...updates } : null,
        })),
    }),
    {
      name: 'pharmacy-auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        pharmacy: state.pharmacy,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state._hasHydrated = true;
      },
    }
  )
);
