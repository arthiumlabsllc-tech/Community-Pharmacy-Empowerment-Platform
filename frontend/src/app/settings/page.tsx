'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/auth-store';
import { usePharmacyStore } from '@/store/pharmacy-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { usePermissions } from '@/hooks/use-permissions';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { api } from '@/lib/api';
import { GHANA_REGIONS } from '@/components/patients/patient-form-modal';
import type { FontSize } from '@/lib/appearance';
import type { NotificationPreferences } from '@/lib/preferences';
import {
  User,
  Building2,
  Bell,
  Shield,
  Globe,
  Info,
  Lock,
} from 'lucide-react';

const NOTIFICATION_OPTIONS: { key: keyof NotificationPreferences; label: string; hint: string }[] = [
  { key: 'low_stock_alerts', label: 'Low stock alerts', hint: 'Items at or below their reorder level' },
  { key: 'expiring_alerts', label: 'Expiring products', hint: 'Stock expiring within the next 90 days' },
  { key: 'claim_updates', label: 'NHIS claim updates', hint: 'Approvals, rejections and payments' },
  { key: 'appointment_reminders', label: 'Patient appointment reminders', hint: 'Upcoming consultations' },
];

const FONT_SIZES: { key: FontSize; label: string }[] = [
  { key: 'normal', label: 'Normal' },
  { key: 'large', label: 'Large' },
  { key: 'extra-large', label: 'Extra large' },
];

const TIER_LABEL: Record<string, string> = {
  free: 'Starter (free)',
  premium: 'Professional',
  enterprise: 'Enterprise',
};

export default function SettingsPage() {
  const { isAuthenticated, user, updateUser } = useAuthStore();
  const { profile, settings, fetchProfile, saveNotifications, saveFontSize } = usePharmacyStore();
  const hydrated = useHydrated();
  const router = useRouter();
  const { isOwner, isPharmacist } = usePermissions();

  const canEditPharmacy = isOwner || isPharmacist;

  // Profile form
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [language, setLanguage] = useState('en');
  const [savingProfile, setSavingProfile] = useState(false);

  // Pharmacy form
  const [pharmacyName, setPharmacyName] = useState('');
  const [pharmacyPhone, setPharmacyPhone] = useState('');
  const [pharmacyEmail, setPharmacyEmail] = useState('');
  const [location, setLocation] = useState('');
  const [region, setRegion] = useState('');
  const [district, setDistrict] = useState('');
  const [gpsAddress, setGpsAddress] = useState('');
  const [savingPharmacy, setSavingPharmacy] = useState(false);

  // Password form
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  useEffect(() => {
    if (hydrated && isAuthenticated) fetchProfile();
  }, [hydrated, isAuthenticated, fetchProfile]);

  // Sync form fields whenever the user or pharmacy record arrives.
  useEffect(() => {
    if (!user) return;
    setFirstName(user.first_name || '');
    setLastName(user.last_name || '');
    setPhone(user.phone || '');
    setLanguage(user.preferred_language || 'en');
  }, [user]);

  useEffect(() => {
    if (!profile) return;
    setPharmacyName(profile.name || '');
    setPharmacyPhone(profile.phone || '');
    setPharmacyEmail(profile.email || '');
    setLocation(profile.location || '');
    setRegion(profile.region || '');
    setDistrict(profile.district || '');
    setGpsAddress(profile.gps_address || '');
  }, [profile]);

  const handleSaveProfile = useCallback(async () => {
    if (!firstName.trim() || !lastName.trim()) {
      toast.error('First and last name are required');
      return;
    }
    setSavingProfile(true);
    try {
      const response = await api.put('/auth/profile', {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        phone: phone.trim(),
        preferred_language: language,
      });
      updateUser(response.data);
      toast.success('Profile saved');
    } catch (error: any) {
      toast.error(error?.message || 'Failed to save profile');
    } finally {
      setSavingProfile(false);
    }
  }, [firstName, lastName, phone, language, updateUser]);

  const handleSavePharmacy = useCallback(async () => {
    if (!pharmacyName.trim() || !pharmacyPhone.trim()) {
      toast.error('Pharmacy name and phone number are required');
      return;
    }
    setSavingPharmacy(true);
    try {
      await api.put('/pharmacies/profile', {
        name: pharmacyName.trim(),
        phone: pharmacyPhone.trim(),
        email: pharmacyEmail.trim() || null,
        location: location.trim() || null,
        region: region || null,
        district: district.trim() || null,
        gps_address: gpsAddress.trim() || null,
      });
      useAuthStore.getState().updatePharmacy({ name: pharmacyName.trim() });
      await fetchProfile();
      toast.success('Pharmacy details saved');
    } catch (error: any) {
      toast.error(error?.message || 'Failed to save pharmacy details');
    } finally {
      setSavingPharmacy(false);
    }
  }, [pharmacyName, pharmacyPhone, pharmacyEmail, location, region, district, gpsAddress, fetchProfile]);

  const handleToggleNotification = async (key: keyof NotificationPreferences, checked: boolean) => {
    const synced = await saveNotifications({ ...settings.notifications, [key]: checked });
    if (!synced && canEditPharmacy) {
      toast.error('Could not save this preference to your account');
    }
  };

  const handleFontSize = async (size: FontSize) => {
    const synced = await saveFontSize(size);
    toast.success(synced ? 'Text size updated' : 'Text size updated on this device');
  };

  const handleChangePassword = async () => {
    if (newPassword.length < 8) {
      toast.error('New password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('The two passwords do not match');
      return;
    }
    if (!currentPassword) {
      toast.error('Enter your current password');
      return;
    }

    setSavingPassword(true);
    try {
      await api.put('/auth/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Password changed');
    } catch (error: any) {
      toast.error(error?.message || 'Failed to change password');
    } finally {
      setSavingPassword(false);
    }
  };

  if (!hydrated || !isAuthenticated) return null;

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-gray-500 mt-1">Manage your pharmacy and account preferences</p>
        </div>

        {/* Profile Section */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <User className="w-5 h-5 text-primary-500" />
            Profile
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">First Name</label>
              <input
                className="input"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Last Name</label>
              <input
                className="input"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" value={user?.email || ''} disabled />
              <p className="text-xs text-gray-400 mt-1">
                Your email is your login identity and cannot be changed here.
              </p>
            </div>
            <div>
              <label className="label">Phone</label>
              <input
                className="input"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          </div>
          <button className="btn-primary btn-sm mt-4" onClick={handleSaveProfile} disabled={savingProfile}>
            {savingProfile && <div className="spinner" />}
            Save Changes
          </button>
        </div>

        {/* Pharmacy Section */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Building2 className="w-5 h-5 text-primary-500" />
            Pharmacy Details
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Pharmacy Name</label>
              <input
                className="input"
                value={pharmacyName}
                disabled={!canEditPharmacy}
                onChange={(e) => setPharmacyName(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Phone</label>
              <input
                className="input"
                type="tel"
                value={pharmacyPhone}
                disabled={!canEditPharmacy}
                onChange={(e) => setPharmacyPhone(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Email</label>
              <input
                className="input"
                type="email"
                value={pharmacyEmail}
                disabled={!canEditPharmacy}
                onChange={(e) => setPharmacyEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="label">License Number</label>
              <input className="input" value={profile?.license_number || ''} disabled />
            </div>
            <div className="md:col-span-2">
              <label className="label">Street Address</label>
              <input
                className="input"
                value={location}
                disabled={!canEditPharmacy}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Region</label>
              <select
                className="select"
                value={region}
                disabled={!canEditPharmacy}
                onChange={(e) => setRegion(e.target.value)}
              >
                <option value="">Select region</option>
                {GHANA_REGIONS.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">District</label>
              <input
                className="input"
                value={district}
                disabled={!canEditPharmacy}
                onChange={(e) => setDistrict(e.target.value)}
              />
            </div>
            <div>
              <label className="label">GhanaPostGPS Address</label>
              <input
                className="input"
                placeholder="e.g. GA-183-6412"
                value={gpsAddress}
                disabled={!canEditPharmacy}
                onChange={(e) => setGpsAddress(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Subscription</label>
              <input
                className="input capitalize"
                value={TIER_LABEL[profile?.subscription_tier || ''] || profile?.subscription_tier || ''}
                disabled
              />
              <button
                type="button"
                className="text-xs text-primary-600 hover:underline mt-1"
                onClick={() => router.push('/subscription')}
              >
                Manage subscription
              </button>
            </div>
          </div>
          {canEditPharmacy ? (
            <button className="btn-primary btn-sm mt-4" onClick={handleSavePharmacy} disabled={savingPharmacy}>
              {savingPharmacy && <div className="spinner" />}
              Save Pharmacy Details
            </button>
          ) : (
            <p className="text-xs text-gray-500 mt-4">
              Only the pharmacy owner or a pharmacist can edit these details.
            </p>
          )}
        </div>

        {/* Notifications */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
            <Bell className="w-5 h-5 text-primary-500" />
            Notifications
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Choose which alerts appear in the notification bell and on your dashboard.
          </p>
          <div className="space-y-1">
            {NOTIFICATION_OPTIONS.map((option) => (
              <label
                key={option.key}
                className="flex items-center justify-between gap-4 p-3 rounded-lg hover:bg-gray-50 cursor-pointer"
              >
                <span className="min-w-0">
                  <span className="text-sm text-gray-700 block">{option.label}</span>
                  <span className="text-xs text-gray-400">{option.hint}</span>
                </span>
                <input
                  type="checkbox"
                  className="w-5 h-5 rounded text-primary-500 flex-shrink-0"
                  checked={settings.notifications[option.key]}
                  onChange={(e) => handleToggleNotification(option.key, e.target.checked)}
                />
              </label>
            ))}
          </div>
          <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-100 mt-3">
            <Info className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-800">
              These are in-app alerts only. SMS and email delivery to your patients is not connected to a
              provider yet, so patient-facing messages are not sent automatically.
              {!canEditPharmacy &&
                ' Your role cannot write to the shared pharmacy settings, so this choice is kept on this device only.'}
            </p>
          </div>
        </div>

        {/* Language & Accessibility */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Globe className="w-5 h-5 text-primary-500" />
            Language &amp; Accessibility
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Preferred Language</label>
              <select
                className="select"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="en">English</option>
                <option value="tw">Twi</option>
                <option value="ee">Ewe</option>
              </select>
              <p className="text-xs text-gray-400 mt-1">
                Saved to your profile with the button above. The interface itself is currently English only —
                Twi and Ewe translations are not available yet.
              </p>
            </div>
            <div>
              <label className="label">Text Size</label>
              <select
                className="select"
                value={settings.ui.fontSize}
                onChange={(e) => handleFontSize(e.target.value as FontSize)}
              >
                {FONT_SIZES.map((size) => (
                  <option key={size.key} value={size.key}>{size.label}</option>
                ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">Applies immediately across the whole app.</p>
            </div>
          </div>
        </div>

        {/* Security */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary-500" />
            Security
          </h2>
          <div className="space-y-4 max-w-md">
            <div>
              <label className="label">Current Password</label>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div>
              <label className="label">New Password</label>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <p className="text-xs text-gray-400 mt-1">At least 8 characters</p>
            </div>
            <div>
              <label className="label">Confirm New Password</label>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            <button
              className="btn-primary btn-sm"
              onClick={handleChangePassword}
              disabled={savingPassword}
            >
              {savingPassword && <div className="spinner" />}
              <Lock className="w-4 h-4" />
              Change Password
            </button>
          </div>

          <div className="flex items-start gap-2 p-3 rounded-xl bg-gray-50 border border-gray-100 mt-5">
            <Info className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-gray-600">
              Two-factor authentication is not available yet. Your session already uses short-lived access
              tokens with refresh-token rotation, and every staff action is written to the audit log.
            </p>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
