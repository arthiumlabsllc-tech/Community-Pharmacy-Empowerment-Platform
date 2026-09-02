import { readFontSize, type FontSize } from './appearance';

export interface NotificationPreferences {
  low_stock_alerts: boolean;
  expiring_alerts: boolean;
  claim_updates: boolean;
  appointment_reminders: boolean;
}

export const DEFAULT_NOTIFICATIONS: NotificationPreferences = {
  low_stock_alerts: true,
  expiring_alerts: true,
  claim_updates: true,
  appointment_reminders: true,
};

export interface PharmacySettings {
  notifications: NotificationPreferences;
  ui: {
    fontSize: FontSize;
  };
}

/**
 * Normalises the free-form `settings` JSONB column on pharmacies into a
 * predictable shape, filling in defaults for anything not yet stored.
 */
export function parsePharmacySettings(raw: unknown): PharmacySettings {
  const settings = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;

  const notifications = { ...DEFAULT_NOTIFICATIONS };
  if (settings.notifications && typeof settings.notifications === 'object') {
    for (const key of Object.keys(DEFAULT_NOTIFICATIONS) as (keyof NotificationPreferences)[]) {
      if (typeof settings.notifications[key] === 'boolean') {
        notifications[key] = settings.notifications[key];
      }
    }
  }

  const storedSize = settings.ui?.fontSize;
  const fontSize: FontSize =
    storedSize === 'large' || storedSize === 'extra-large' || storedSize === 'normal'
      ? storedSize
      : readFontSize();

  return { notifications, ui: { fontSize } };
}
