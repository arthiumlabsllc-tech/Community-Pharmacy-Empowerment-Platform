import { create } from 'zustand';
import { api } from '@/lib/api';
import {
  DEFAULT_NOTIFICATIONS,
  parsePharmacySettings,
  type NotificationPreferences,
  type PharmacySettings,
} from '@/lib/preferences';
import { applyFontSize, readFontSize, saveFontSize, type FontSize } from '@/lib/appearance';

interface PharmacyProfile {
  id: string;
  name: string;
  license_number: string;
  phone: string;
  email: string | null;
  location: string | null;
  region: string | null;
  district: string | null;
  gps_address: string | null;
  subscription_tier: string;
  logo_url: string | null;
  settings: unknown;
  staff_count?: string;
  patient_count?: string;
  inventory_count?: string;
}

interface PharmacyState {
  profile: PharmacyProfile | null;
  settings: PharmacySettings;
  loaded: boolean;
  loading: boolean;
  fetchProfile: () => Promise<void>;
  /** Returns false when the change could only be kept on this device. */
  saveNotifications: (notifications: NotificationPreferences) => Promise<boolean>;
  saveFontSize: (fontSize: FontSize) => Promise<boolean>;
}

const NOTIFICATION_STORAGE_KEY = 'pharmacy-notification-prefs';

function readLocalNotifications(): NotificationPreferences | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const merged = { ...DEFAULT_NOTIFICATIONS };
    for (const key of Object.keys(DEFAULT_NOTIFICATIONS) as (keyof NotificationPreferences)[]) {
      if (typeof parsed[key] === 'boolean') merged[key] = parsed[key];
    }
    return merged;
  } catch {
    return null;
  }
}

function writeLocalNotifications(preferences: NotificationPreferences) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(preferences));
}

/**
 * Holds the pharmacy record plus its normalised `settings` JSONB so that every
 * component (settings page, notification bell, dashboard alerts) reads the same
 * preferences.
 *
 * Preferences are local-first: they always apply on this device immediately,
 * and are additionally pushed to pharmacies.settings when the signed-in user is
 * allowed to write there (pharmacy owner or pharmacist).
 */
export const usePharmacyStore = create<PharmacyState>()((set, get) => ({
  profile: null,
  settings: {
    notifications: readLocalNotifications() || DEFAULT_NOTIFICATIONS,
    ui: { fontSize: readFontSize() },
  },
  loaded: false,
  loading: false,

  fetchProfile: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const response = await api.get('/pharmacies/profile');
      const profile = response.data as PharmacyProfile;
      const remote = parsePharmacySettings(profile?.settings);
      const rawSettings = (profile?.settings || {}) as Record<string, any>;

      // Remote settings win only when something was actually stored there;
      // otherwise keep what this device already has.
      const notifications = rawSettings.notifications
        ? remote.notifications
        : readLocalNotifications() || remote.notifications;

      const settings: PharmacySettings = {
        notifications,
        ui: { fontSize: rawSettings.ui?.fontSize ? remote.ui.fontSize : readFontSize() },
      };

      applyFontSize(settings.ui.fontSize);
      set({ profile, settings, loaded: true });
    } catch {
      // Leave the local defaults in place; the settings page surfaces its own error.
    } finally {
      set({ loading: false });
    }
  },

  saveNotifications: async (notifications) => {
    const merged = { ...get().settings, notifications };
    writeLocalNotifications(notifications);
    set({ settings: merged });
    return persistSettings(merged, set);
  },

  saveFontSize: async (fontSize) => {
    const merged = { ...get().settings, ui: { ...get().settings.ui, fontSize } };
    // Apply immediately so the change is visible without a reload.
    saveFontSize(fontSize);
    set({ settings: merged });
    return persistSettings(merged, set);
  },
}));

/**
 * Writes the settings blob back to pharmacies.settings. The endpoint replaces
 * the whole column, so the already-merged object is sent as-is. Returns false
 * when the write was rejected (for example a staff member without permission)
 * so the caller can say the change was kept on this device only.
 */
async function persistSettings(
  settings: PharmacySettings,
  set: (partial: Partial<PharmacyState>) => void
): Promise<boolean> {
  try {
    const response = await api.put('/pharmacies/profile', {
      settings: {
        notifications: settings.notifications,
        ui: settings.ui,
      },
    });
    set({ profile: response.data });
    return true;
  } catch {
    return false;
  }
}
