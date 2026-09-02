'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { User, Building2, Bell, Shield, Globe, Palette } from 'lucide-react';
import toast from 'react-hot-toast';

export default function SettingsPage() {
  const { isAuthenticated, user, pharmacy, _hasHydrated } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (_hasHydrated && !isAuthenticated) router.replace('/login');
  }, [isAuthenticated, _hasHydrated, router]);

  if (!_hasHydrated || !isAuthenticated) return null;

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in">
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
              <input className="input" defaultValue={user?.first_name || ''} />
            </div>
            <div>
              <label className="label">Last Name</label>
              <input className="input" defaultValue={user?.last_name || ''} />
            </div>
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" defaultValue={user?.email || ''} />
            </div>
            <div>
              <label className="label">Phone</label>
              <input className="input" defaultValue={user?.phone || ''} />
            </div>
          </div>
          <button className="btn-primary btn-sm mt-4" onClick={() => toast.success('Profile updated')}>
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
              <input className="input" defaultValue={pharmacy?.name || ''} />
            </div>
            <div>
              <label className="label">License Number</label>
              <input className="input" defaultValue={pharmacy?.license_number || ''} disabled />
            </div>
            <div>
              <label className="label">Subscription Tier</label>
              <input className="input" defaultValue={pharmacy?.subscription_tier || ''} disabled />
            </div>
          </div>
        </div>

        {/* Notifications */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Bell className="w-5 h-5 text-primary-500" />
            Notifications
          </h2>
          <div className="space-y-3">
            {[
              { label: 'Low stock alerts', checked: true },
              { label: 'Expiring products', checked: true },
              { label: 'NHIS claim updates', checked: true },
              { label: 'Patient appointment reminders', checked: true },
              { label: 'Marketing emails', checked: false },
            ].map((item, i) => (
              <label key={i} className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 cursor-pointer">
                <span className="text-sm text-gray-700">{item.label}</span>
                <input type="checkbox" defaultChecked={item.checked} className="w-5 h-5 rounded text-primary-500" />
              </label>
            ))}
          </div>
        </div>

        {/* Language & Accessibility */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Globe className="w-5 h-5 text-primary-500" />
            Language & Accessibility
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Language</label>
              <select className="input">
                <option value="en">English</option>
                <option value="tw">Twi</option>
                <option value="ee">Ewe</option>
              </select>
            </div>
            <div>
              <label className="label">Font Size</label>
              <select className="input">
                <option value="normal">Normal</option>
                <option value="large">Large</option>
                <option value="extra-large">Extra Large</option>
              </select>
            </div>
          </div>
        </div>

        {/* Security */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary-500" />
            Security
          </h2>
          <div className="space-y-4">
            <button className="btn-secondary btn-sm" onClick={() => toast.success('Password reset email sent')}>
              Change Password
            </button>
            <label className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 cursor-pointer">
              <span className="text-sm text-gray-700">Enable two-factor authentication</span>
              <input type="checkbox" className="w-5 h-5 rounded text-primary-500" />
            </label>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
