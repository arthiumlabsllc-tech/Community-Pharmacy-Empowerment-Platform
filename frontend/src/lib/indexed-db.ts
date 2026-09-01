/**
 * Offline-first IndexedDB wrapper for the Pharmacy Empowerment Platform.
 * Provides local data storage and sync queue for offline operations.
 */

const DB_NAME = 'pharmacy-platform-db';
const DB_VERSION = 1;

interface SyncQueueItem {
  id: string;
  method: 'POST' | 'PUT' | 'DELETE';
  endpoint: string;
  body: any;
  timestamp: number;
  retryCount: number;
}

// ============ DATABASE SETUP ============
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Object stores
      if (!db.objectStoreNames.contains('patients')) {
        const store = db.createObjectStore('patients', { keyPath: 'id' });
        store.createIndex('pharmacy_id', 'pharmacy_id');
        store.createIndex('nhis_number', 'nhis_number');
        store.createIndex('name', ['first_name', 'last_name']);
      }

      if (!db.objectStoreNames.contains('inventory')) {
        const store = db.createObjectStore('inventory', { keyPath: 'id' });
        store.createIndex('pharmacy_id', 'pharmacy_id');
        store.createIndex('product_code', 'product_code');
        store.createIndex('category', 'category');
        store.createIndex('expiry_date', 'expiry_date');
      }

      if (!db.objectStoreNames.contains('prescriptions')) {
        const store = db.createObjectStore('prescriptions', { keyPath: 'id' });
        store.createIndex('patient_id', 'patient_id');
        store.createIndex('pharmacy_id', 'pharmacy_id');
      }

      if (!db.objectStoreNames.contains('screenings')) {
        const store = db.createObjectStore('screenings', { keyPath: 'id' });
        store.createIndex('patient_id', 'patient_id');
      }

      if (!db.objectStoreNames.contains('syncQueue')) {
        db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
      }

      if (!db.objectStoreNames.contains('notifications')) {
        db.createObjectStore('notifications', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache', { keyPath: 'key' });
      }
    };
  });
}

// ============ GENERIC CRUD ============
export async function getAll<T>(storeName: string): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getById<T>(storeName: string, id: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function put<T>(storeName: string, data: T): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(data);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function putMany<T>(storeName: string, items: T[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    items.forEach((item) => store.put(item));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function remove(storeName: string, id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function clear(storeName: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ============ SYNC QUEUE ============
export async function addToSyncQueue(item: Omit<SyncQueueItem, 'id' | 'timestamp' | 'retryCount'>): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('syncQueue', 'readwrite');
    const store = tx.objectStore('syncQueue');
    store.add({
      ...item,
      timestamp: Date.now(),
      retryCount: 0,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getSyncQueue(): Promise<SyncQueueItem[]> {
  return getAll<SyncQueueItem>('syncQueue');
}

export async function removeFromSyncQueue(id: number): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('syncQueue', 'readwrite');
    const store = tx.objectStore('syncQueue');
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============ SYNC PROCESSOR ============
export async function processSyncQueue(
  apiFetch: (endpoint: string, options: any) => Promise<any>
): Promise<{ synced: number; failed: number }> {
  const queue = await getSyncQueue();
  let synced = 0;
  let failed = 0;

  for (const item of queue) {
    try {
      await apiFetch(item.endpoint, {
        method: item.method,
        body: JSON.stringify(item.body),
      });
      await removeFromSyncQueue(item.id as unknown as number);
      synced++;
    } catch (error) {
      failed++;
      // Increment retry count
      if (item.retryCount >= 3) {
        await removeFromSyncQueue(item.id as unknown as number);
      } else {
        const db = await openDB();
        const tx = db.transaction('syncQueue', 'readwrite');
        tx.objectStore('syncQueue').put({
          ...item,
          retryCount: item.retryCount + 1,
        });
      }
    }
  }

  return { synced, failed };
}

// ============ CACHE HELPERS ============
export async function setCache(key: string, data: any, ttlMs: number = 300000): Promise<void> {
  await put('cache', { key, data, expiresAt: Date.now() + ttlMs });
}

export async function getCache<T>(key: string): Promise<T | null> {
  const entry = await getById<{ key: string; data: T; expiresAt: number }>('cache', key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    await remove('cache', key);
    return null;
  }
  return entry.data;
}
