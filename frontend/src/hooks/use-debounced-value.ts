'use client';

import { useEffect, useState } from 'react';

/**
 * Debounces a rapidly-changing value (e.g. search input) so that
 * API calls fire only after the value settles.
 */
export function useDebouncedValue<T>(value: T, delayMs = 400): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
