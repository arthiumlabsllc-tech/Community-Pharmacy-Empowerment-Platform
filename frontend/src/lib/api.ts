const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';

interface FetchOptions extends RequestInit {
  token?: string;
  /** Milliseconds before an unanswered request is abandoned. Defaults to 20s. */
  timeoutMs?: number;
  /**
   * Idempotency key for a write that may be replayed. Sent as
   * X-Client-Request-Id; the server stores its response against the key and
   * returns that instead of doing the work twice.
   */
  clientRequestId?: string;
}

/**
 * Every failure this client produces, whether the server answered or not.
 *
 * The distinction matters for offline-first: a `TypeError: Failed to fetch`
 * from the browser and a 500 from the API are completely different situations,
 * but both used to surface as an untyped Error whose only clue was the message
 * text. Callers could not tell "queue this and retry" from "the server
 * rejected this, show the user why".
 */
export class ApiError extends Error {
  /** HTTP status, or 0 when no response was ever received. */
  status: number;
  /** Parsed response body when there was one. */
  data: any;
  /** True when the request failed at the transport layer, before any status. */
  networkError: boolean;
  /** True when the browser itself reports no connectivity. */
  offline: boolean;
  /** True when the request was abandoned because it took too long. */
  timedOut: boolean;
  endpoint: string;
  method: string;

  constructor(params: {
    message: string;
    endpoint: string;
    method: string;
    status?: number;
    data?: any;
    networkError?: boolean;
    offline?: boolean;
    timedOut?: boolean;
  }) {
    super(params.message);
    this.name = 'ApiError';
    this.status = params.status ?? 0;
    this.data = params.data ?? null;
    this.networkError = params.networkError ?? false;
    this.offline = params.offline ?? false;
    this.timedOut = params.timedOut ?? false;
    this.endpoint = params.endpoint;
    this.method = params.method;
  }

  /**
   * Whether repeating the identical request could plausibly succeed.
   *
   * A transport failure or a 5xx might. A 400, 403 or 404 will not — the
   * request itself is wrong, and retrying it in a loop only hides the reason
   * from the person who has to fix it. 409 is deliberately excluded: on the
   * till it means stock moved underneath the sale, which needs a human.
   */
  get retryable(): boolean {
    if (this.networkError) return true;
    return [408, 425, 429, 500, 502, 503, 504].includes(this.status);
  }
}

/** True when the error means "could not reach the server at all". */
export function isNetworkError(error: unknown): boolean {
  return error instanceof ApiError && error.networkError;
}

/** True when the browser reports the device is disconnected. */
export function isOffline(error: unknown): boolean {
  return error instanceof ApiError && error.offline;
}

/**
 * Reads a response body without assuming it is JSON.
 *
 * A 502 from the platform's edge or an empty 204 both used to throw a JSON
 * parse error here, replacing the real status with "Unexpected token <". The
 * status is the useful part, so the body is best-effort.
 */
async function readBody(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

/** The browser reports no network interface. Absent during server rendering. */
function browserSaysOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

const DEFAULT_TIMEOUT_MS = 20_000;

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
    const { token, timeoutMs, clientRequestId, ...fetchOptions } = options;
    const method = String(fetchOptions.method || 'GET').toUpperCase();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((fetchOptions.headers as Record<string, string>) || {}),
    };

    const accessToken = token || this.getAccessToken();
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }
    if (clientRequestId) {
      headers['X-Client-Request-Id'] = clientRequestId;
    }

    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;

    let response: Response;
    try {
      response = await this.send(url, { ...fetchOptions, headers, method }, timeoutMs);
    } catch (error) {
      throw this.classifyTransportFailure(error, endpoint, method);
    }

    // Handle 401 — try to refresh token
    if (response.status === 401 && !token) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        headers['Authorization'] = `Bearer ${refreshed}`;
        try {
          response = await this.send(url, { ...fetchOptions, headers, method }, timeoutMs);
        } catch (error) {
          throw this.classifyTransportFailure(error, endpoint, method);
        }
      }
    }

    const data = await readBody(response);

    if (!response.ok) {
      throw new ApiError({
        message: data?.message || `Request failed (${response.status})`,
        endpoint,
        method,
        status: response.status,
        data,
      });
    }

    return data as T;
  }

  /**
   * One fetch with a deadline.
   *
   * The timeout is not a nicety. On a mobile connection that has signal bars
   * but no route to the server, `fetch` can hang for minutes, and a sync queue
   * waiting on it stalls everything behind it. Abandoning the request does not
   * mean the server did not process it — which is precisely why replayed writes
   * carry an idempotency key.
   */
  private async send(
    url: string,
    init: RequestInit,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 1000));

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Turns a transport-level failure into an ApiError the caller can act on.
   * An abort from our own deadline is reported as a timeout rather than as a
   * generic network error, because the two need different messages: one says
   * "you are offline", the other says "the server did not answer in time".
   */
  private classifyTransportFailure(error: unknown, endpoint: string, method: string): ApiError {
    const offline = browserSaysOffline();
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    // fetch() rejects with an AbortError for our timeout, but a caller can also
    // pass its own signal; either way the request did not complete.
    const timedOut = aborted;

    if (offline) {
      return new ApiError({
        message: 'No internet connection',
        endpoint,
        method,
        networkError: true,
        offline: true,
        timedOut,
      });
    }

    return new ApiError({
      message: timedOut
        ? 'The server did not respond in time'
        : 'Could not reach the server',
      endpoint,
      method,
      networkError: true,
      offline: false,
      timedOut,
    });
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

      const body = await readBody(response);
      this.onTokenRefreshed(body?.data?.accessToken);
      return body?.data?.accessToken ?? null;
    } catch {
      this.onLogout();
      return null;
    }
  }

  // Convenience methods
  get<T = any>(endpoint: string, options?: FetchOptions) {
    return this.fetch<T>(endpoint, { ...options, method: 'GET' });
  }

  post<T = any>(endpoint: string, body?: any, options?: FetchOptions) {
    return this.fetch<T>(endpoint, { ...options, method: 'POST', body: JSON.stringify(body) });
  }

  put<T = any>(endpoint: string, body?: any, options?: FetchOptions) {
    return this.fetch<T>(endpoint, { ...options, method: 'PUT', body: JSON.stringify(body) });
  }

  delete<T = any>(endpoint: string, options?: FetchOptions) {
    return this.fetch<T>(endpoint, { ...options, method: 'DELETE' });
  }
}

export const api = new ApiClient();
export default api;
