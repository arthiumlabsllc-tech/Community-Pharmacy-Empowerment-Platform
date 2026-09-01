'use client';

import { useEffect } from 'react';
import { useAuthStore } from '@/store/auth-store';
import { api } from '@/lib/api';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { accessToken, refreshToken, setAuth, logout } = useAuthStore();

  useEffect(() => {
    api.configure({
      getAccessToken: () => useAuthStore.getState().accessToken,
      getRefreshToken: () => useAuthStore.getState().refreshToken,
      onTokenRefreshed: (newToken) => {
        const state = useAuthStore.getState();
        setAuth({
          accessToken: newToken,
          refreshToken: state.refreshToken!,
          user: state.user!,
          pharmacy: state.pharmacy!,
        });
      },
      onLogout: () => {
        logout();
        if (typeof window !== 'undefined') {
          window.location.href = '/login';
        }
      },
    });
  }, [setAuth, logout]);

  return <>{children}</>;
}
