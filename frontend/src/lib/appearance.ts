export type FontSize = 'normal' | 'large' | 'extra-large';

const STORAGE_KEY = 'pharmacy-font-size';
const VALID_SIZES: FontSize[] = ['normal', 'large', 'extra-large'];

/**
 * The chosen size is kept in localStorage so it applies before the first
 * authenticated API response arrives, and mirrored into the pharmacy's
 * `settings` JSONB so it follows the account across devices.
 */
export function readFontSize(): FontSize {
  if (typeof window === 'undefined') return 'normal';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return VALID_SIZES.includes(stored as FontSize) ? (stored as FontSize) : 'normal';
}

export function applyFontSize(size: FontSize) {
  if (typeof document === 'undefined') return;
  if (size === 'normal') {
    delete document.documentElement.dataset.fontSize;
  } else {
    document.documentElement.dataset.fontSize = size;
  }
}

export function saveFontSize(size: FontSize) {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, size);
  }
  applyFontSize(size);
}
