const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';

interface FetchOptions extends RequestInit {
  token?: string;
}

class ApiClient {
  private baseUrl: string;
  private getAccessToken: () => string | null;
  private getRefreshToken: () => string | null;
  private onTokenRefreshed: (token: string) => void;
  private onLogout: () => void;

  constructor() {
    this.baseUrl = API_URL;
    this.getAccessToken = () => null;
    this.getRefreshToken = () => null;
    this.onTokenRefreshed = () => {};
    this.onLogout = () => {};
  }

  configure(callbacks: {
    getAccessToken: () => string | null;
    getRefreshToken: () => string | null;
    onTokenRefreshed: (token: string) => void;
    onLogout: () => void;
  }) {
    this.getAccessToken = callbacks.getAccessToken;
    this.getRefreshToken = callbacks.getRefreshToken;
    this.onTokenRefreshed = callbacks.onTokenRefreshed;
    this.onLogout = callbacks.onLogout;
  }

  async fetch<T = any>(endpoint: string, options: FetchOptions = {}): Promise<T> {
    const { token, ...fetchOptions } = options;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((fetchOptions.headers as Record<string, string>) || {}),
    };

    const accessToken = token || this.getAccessToken();
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;

    let response = await fetch(url, { ...fetchOptions, headers });

    // Handle 401 — try to refresh token
    if (response.status === 401 && !token) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        headers['Authorization'] = `Bearer ${refreshed}`;
        response = await fetch(url, { ...fetchOptions, headers });
      }
    }

    const data = await response.json();

    if (!response.ok) {
      const error = new Error(data.message || 'Request failed') as any;
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  private async refreshAccessToken(): Promise<string | null> {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) {
      this.onLogout();
      return null;
    }

    try {
      const response = await fetch(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        this.onLogout();
        return null;
      }

      const { data } = await response.json();
      this.onTokenRefreshed(data.accessToken);
      return data.accessToken;
    } catch {
      this.onLogout();
      return null;
    }
  }

  // Convenience methods
  get<T>(endpoint: string, options?: FetchOptions) {
    return this.fetch<T>(endpoint, { ...options, method: 'GET' });
  }

  post<T>(endpoint: string, body?: any, options?: FetchOptions) {
    return this.fetch<T>(endpoint, { ...options, method: 'POST', body: JSON.stringify(body) });
  }

  put<T>(endpoint: string, body?: any, options?: FetchOptions) {
    return this.fetch<T>(endpoint, { ...options, method: 'PUT', body: JSON.stringify(body) });
  }

  delete<T>(endpoint: string, options?: FetchOptions) {
    return this.fetch<T>(endpoint, { ...options, method: 'DELETE' });
  }
}

export const api = new ApiClient();
export default api;
