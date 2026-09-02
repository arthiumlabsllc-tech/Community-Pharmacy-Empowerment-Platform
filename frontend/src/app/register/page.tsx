'use client';

/**
 * Pharmacy registration — the target of the "Register your pharmacy" link on
 * the login page, which previously pointed at a route that did not exist.
 *
 * Creates the pharmacy, its owner account and a 30-day trial in one
 * `POST /auth/register` call; the server returns tokens, so a successful
 * registration is also a sign-in. The client-side rules below mirror the
 * express-validator chains on that route exactly, so nothing is rejected only
 * after a round trip.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Building2, Eye, EyeOff, Loader2, ShieldCheck, User } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth-store';
import { usePharmacyStore } from '@/store/pharmacy-store';
import { GHANA_REGIONS } from '@/components/patients/patient-form-modal';

const EMPTY_FORM = {
  pharmacy_name: '',
  license_number: '',
  location: '',
  region: '',
  district: '',
  gps_address: '',
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  password: '',
  confirmPassword: '',
};

type FormKey = keyof typeof EMPTY_FORM;

interface RegisterResponse {
  success: boolean;
  message: string;
  data: {
    accessToken: string;
    refreshToken: string;
    user: {
      id: string;
      first_name: string;
      last_name: string;
      email: string;
      phone: string;
      role: string;
    };
    pharmacy: {
      id: string;
      name: string;
      license_number: string;
      subscription_tier: string;
    };
  };
}

// Rough but deliberately permissive: the server is the authority, and a strict
// client regex only produces false rejections of valid addresses.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function RegisterPage() {
  const router = useRouter();
  const setAuth = useAuthStore((state) => state.setAuth);
  const fetchProfile = usePharmacyStore((state) => state.fetchProfile);

  const [form, setForm] = useState(EMPTY_FORM);
  const [touched, setTouched] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Field messages that came back from the server (422 validation, 409
  // duplicate). Kept separate from the local rules so a server objection stays
  // visible even after the field is edited, until the next submit.
  const [serverErrors, setServerErrors] = useState<Partial<Record<FormKey, string>>>({});

  const set = (field: FormKey, value: string) => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setServerErrors((previous) =>
      previous[field] ? { ...previous, [field]: undefined } : previous
    );
  };

  const errors: Partial<Record<FormKey, string>> = {
    pharmacy_name: form.pharmacy_name.trim() === '' ? 'Pharmacy name is required' : undefined,
    license_number:
      form.license_number.trim() === '' ? 'Pharmacy Council licence number is required' : undefined,
    location: form.location.trim() === '' ? 'Street address is required' : undefined,
    first_name: form.first_name.trim() === '' ? 'First name is required' : undefined,
    last_name: form.last_name.trim() === '' ? 'Last name is required' : undefined,
    email: !EMAIL_PATTERN.test(form.email.trim()) ? 'A valid email address is required' : undefined,
    phone: form.phone.trim() === '' ? 'Phone number is required' : undefined,
    password:
      form.password.length < 8 ? 'Password must be at least 8 characters' : undefined,
    confirmPassword:
      form.confirmPassword !== form.password ? 'Passwords do not match' : undefined,
  };

  const errorFor = (field: FormKey) =>
    serverErrors[field] || (touched ? errors[field] : undefined);

  const hasErrors = Object.values(errors).some(Boolean);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    setServerErrors({});
    if (hasErrors) return;

    setSubmitting(true);
    try {
      const response = await api.post<RegisterResponse>('/auth/register', {
        pharmacy_name: form.pharmacy_name.trim(),
        license_number: form.license_number.trim(),
        location: form.location.trim(),
        region: form.region.trim() || null,
        district: form.district.trim() || null,
        gps_address: form.gps_address.trim() || null,
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        password: form.password,
      });

      const { accessToken, refreshToken, user, pharmacy } = response.data;
      setAuth({ accessToken, refreshToken, user, pharmacy });

      // The registration reply carries a summarised pharmacy (and a synthetic
      // trial tier), so pull the real row before the dashboard renders it.
      // Best-effort: a failure here must not lose an account that exists.
      fetchProfile().catch(() => undefined);

      toast.success(response.message || 'Registration successful');
      router.push('/');
    } catch (error: any) {
      const fieldErrors: Partial<Record<FormKey, string>> = {};

      if (error?.status === 422 && Array.isArray(error?.data?.errors)) {
        for (const item of error.data.errors) {
          if (item?.field && item.field in EMPTY_FORM) {
            fieldErrors[item.field as FormKey] = item.message;
          }
        }
      }

      if (error?.status === 409) {
        // Put the duplicate on the field it belongs to rather than a banner the
        // user has to translate into an action.
        const message = String(error?.message || '');
        if (/license/i.test(message)) fieldErrors.license_number = message;
        else fieldErrors.email = message;
      }

      setServerErrors(fieldErrors);
      toast.error(
        Object.values(fieldErrors)[0] || error?.message || 'Registration failed. Please try again.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const fieldClass = (field: FormKey, base = 'input') =>
    `${base} ${errorFor(field) ? 'input-error' : ''}`;

  const errorText = (field: FormKey) => {
    const message = errorFor(field);
    return message ? <p className="mt-1 text-xs text-red-600">{message}</p> : null;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 via-white to-accent-50 p-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-8 text-center">
          <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-500">
            <span className="text-3xl font-bold text-white">P</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Register your pharmacy</h1>
          <p className="mt-1 text-gray-500">
            Inventory, the till, NHIS claims and patient records in one place.
          </p>
        </div>

        <div className="rounded-2xl border border-gray-100 bg-white p-6 shadow-lg sm:p-8">
          <form onSubmit={handleSubmit} className="space-y-8" noValidate>
            {/* Pharmacy */}
            <section className="space-y-4">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
                <Building2 className="h-5 w-5 text-primary-500" />
                Your pharmacy
              </h2>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="label" htmlFor="pharmacy_name">Pharmacy name *</label>
                  <input
                    id="pharmacy_name"
                    type="text"
                    className={fieldClass('pharmacy_name')}
                    placeholder="e.g. Accra Community Pharmacy"
                    value={form.pharmacy_name}
                    onChange={(event) => set('pharmacy_name', event.target.value)}
                  />
                  {errorText('pharmacy_name')}
                </div>

                <div>
                  <label className="label" htmlFor="license_number">Licence number *</label>
                  <input
                    id="license_number"
                    type="text"
                    className={fieldClass('license_number')}
                    placeholder="Pharmacy Council of Ghana licence"
                    value={form.license_number}
                    onChange={(event) => set('license_number', event.target.value)}
                  />
                  {errorText('license_number')}
                  {!errorFor('license_number') && (
                    <p className="mt-1 text-xs text-gray-400">
                      Printed on receipts and NHIS claims. Each licence can only be registered once.
                    </p>
                  )}
                </div>

                <div>
                  <label className="label" htmlFor="gps_address">GhanaPostGPS address</label>
                  <input
                    id="gps_address"
                    type="text"
                    className="input"
                    placeholder="e.g. GA-183-6412"
                    value={form.gps_address}
                    onChange={(event) => set('gps_address', event.target.value)}
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="label" htmlFor="location">Street address *</label>
                  <input
                    id="location"
                    type="text"
                    className={fieldClass('location')}
                    placeholder="e.g. 12 Oxford Street, Osu"
                    value={form.location}
                    onChange={(event) => set('location', event.target.value)}
                  />
                  {errorText('location')}
                </div>

                <div>
                  <label className="label" htmlFor="region">Region</label>
                  <select
                    id="region"
                    className="select"
                    value={form.region}
                    onChange={(event) => set('region', event.target.value)}
                  >
                    <option value="">Select region</option>
                    {GHANA_REGIONS.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="label" htmlFor="district">District</label>
                  <input
                    id="district"
                    type="text"
                    className="input"
                    value={form.district}
                    onChange={(event) => set('district', event.target.value)}
                  />
                </div>
              </div>
            </section>

            {/* Owner account */}
            <section className="space-y-4">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
                <User className="h-5 w-5 text-primary-500" />
                Owner account
              </h2>
              <p className="text-sm text-gray-500">
                You are registered as the pharmacy owner. Cashiers and pharmacists can be added
                later under Staff, each with their own permissions.
              </p>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="first_name">First name *</label>
                  <input
                    id="first_name"
                    type="text"
                    className={fieldClass('first_name')}
                    value={form.first_name}
                    onChange={(event) => set('first_name', event.target.value)}
                  />
                  {errorText('first_name')}
                </div>

                <div>
                  <label className="label" htmlFor="last_name">Last name *</label>
                  <input
                    id="last_name"
                    type="text"
                    className={fieldClass('last_name')}
                    value={form.last_name}
                    onChange={(event) => set('last_name', event.target.value)}
                  />
                  {errorText('last_name')}
                </div>

                <div>
                  <label className="label" htmlFor="email">Email *</label>
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    className={fieldClass('email')}
                    value={form.email}
                    onChange={(event) => set('email', event.target.value)}
                  />
                  {errorText('email')}
                  {!errorFor('email') && (
                    <p className="mt-1 text-xs text-gray-400">This is your login identity.</p>
                  )}
                </div>

                <div>
                  <label className="label" htmlFor="phone">Phone *</label>
                  <input
                    id="phone"
                    type="tel"
                    autoComplete="tel"
                    className={fieldClass('phone')}
                    placeholder="e.g. 024 123 4567"
                    value={form.phone}
                    onChange={(event) => set('phone', event.target.value)}
                  />
                  {errorText('phone')}
                </div>

                <div>
                  <label className="label" htmlFor="password">Password *</label>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      className={fieldClass('password', 'input pr-12')}
                      value={form.password}
                      onChange={(event) => set('password', event.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((previous) => !previous)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                    >
                      {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                    </button>
                  </div>
                  {errorText('password')}
                  {!errorFor('password') && (
                    <p className="mt-1 text-xs text-gray-400">At least 8 characters.</p>
                  )}
                </div>

                <div>
                  <label className="label" htmlFor="confirmPassword">Confirm password *</label>
                  <input
                    id="confirmPassword"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    className={fieldClass('confirmPassword')}
                    value={form.confirmPassword}
                    onChange={(event) => set('confirmPassword', event.target.value)}
                  />
                  {errorText('confirmPassword')}
                </div>
              </div>
            </section>

            <button type="submit" disabled={submitting} className="btn-primary btn-lg w-full">
              {submitting ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  Creating your pharmacy…
                </>
              ) : (
                'Create account and start free trial'
              )}
            </button>
          </form>

          <div className="mt-6 flex items-start gap-2 rounded-xl bg-gray-50 p-4">
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-500" />
            <p className="text-xs text-gray-600">
              Registration starts a 30-day free trial of the Professional plan. No card is taken
              now, and your data stays on your pharmacy&apos;s own record — you can export it at
              any time.
            </p>
          </div>

          <div className="mt-6 text-center">
            <p className="text-sm text-gray-500">
              Already registered?{' '}
              <Link href="/login" className="font-semibold text-primary-600 hover:underline">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
