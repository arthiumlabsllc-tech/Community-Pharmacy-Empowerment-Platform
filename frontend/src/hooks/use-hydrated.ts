'use client';

import { useEffect, useState } from 'react';

/**
 * Returns true once the component has mounted on the client.
 *
 * With localStorage (a synchronous storage), zustand's persist middleware
 * rehydrates the store synchronously during module evaluation — so after
 * mount, the store is guaranteed to hold the persisted session. Gating
 * auth checks on this flag avoids SSR/hydration races where the server
 * render sees an empty store and wrongly redirects to /login.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  return hydrated;
}
