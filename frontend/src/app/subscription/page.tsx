'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { usePermissions } from '@/hooks/use-permissions';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import {
  CreditCard,
  Check,
  Star,
  Info,
  Users,
  CalendarClock,
  Smartphone,
} from 'lucide-react';

interface Plan {
  tier: string;
  name: string;
  description: string | null;
  monthly_price: string | number;
  annual_price: string | number | null;
  currency: string;
  features: string[];
  max_users: number;
  max_patients: number | null;
}

interface SubscriptionStatus {
  id?: string;
  tier: string;
  status: string;
  start_date?: string;
  end_date?: string | null;
  trial_ends_at?: string | null;
  monthly_amount?: string | number;
  currency?: string;
  next_billing_at?: string | null;
  features: string[];
  plan_name?: string;
}

/** Human labels for the machine-readable feature keys stored in subscription_plans. */
const FEATURE_LABELS: Record<string, string> = {
  inventory_basic: 'Basic inventory tracking',
  inventory_full: 'Full inventory management with batch & expiry tracking',
  patients_basic: 'Up to 100 patient records',
  patients_full: 'Unlimited-scale patient records',
  dashboard: 'Simple dashboard',
  nhis_claims: 'NHIS claims submission & tracking',
  analytics: 'Analytics dashboard',
  analytics_advanced: 'Advanced analytics & reporting',
  sms_reminders: 'SMS medication reminders',
  screenings: 'Health screenings & risk triage',
  consultations: 'Patient consultations (in person, video, chat, phone)',
  api_access: 'API access',
  multi_branch: 'Multi-branch support',
};

function featureLabel(key: string) {
  return FEATURE_LABELS[key] || key.replace(/_/g, ' ');
}

const STATUS_BADGE: Record<string, string> = {
  active: 'badge-success',
  trial: 'badge-info',
  past_due: 'badge-warning',
  expired: 'badge-danger',
  cancelled: 'badge-neutral',
};

const PAYMENT_METHODS = [
  { key: 'momo', label: 'Mobile Money (MTN, Telecel, AT)' },
  { key: 'bank_transfer', label: 'Bank transfer' },
  { key: 'paystack', label: 'Card via Paystack' },
];

function formatMoney(amount: string | number | null | undefined, currency = 'GHS') {
  if (amount == null) return '—';
  return `${currency} ${Number(amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function SubscriptionPage() {
  const { isAuthenticated, pharmacy, updatePharmacy } = useAuthStore();
  const hydrated = useHydrated();
  const router = useRouter();
  const { canManageSubscription } = usePermissions();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [upgradePlan, setUpgradePlan] = useState<Plan | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [plansRes, statusRes] = await Promise.allSettled([
        api.get('/subscriptions/plans'),
        api.get('/subscriptions/status'),
      ]);
      if (plansRes.status === 'fulfilled') setPlans(plansRes.value.data || []);
      if (statusRes.status === 'fulfilled') setSubscription(statusRes.value.data || null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hydrated && isAuthenticated) load();
  }, [hydrated, isAuthenticated, load]);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await api.post('/subscriptions/cancel');
      toast.success('Subscription cancelled — your pharmacy is now on the free plan');
      updatePharmacy({ subscription_tier: 'free' });
      setCancelOpen(false);
      await load();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to cancel subscription');
    } finally {
      setCancelling(false);
    }
  };

  if (!hydrated || !isAuthenticated) return null;

  const currentTier = subscription?.tier || pharmacy?.subscription_tier || 'free';
  const isPaid = currentTier !== 'free';

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">Subscription Plans</h1>
          <p className="text-gray-500 mt-1">Choose the plan that fits your pharmacy</p>
        </div>

        {/* Current subscription */}
        {subscription && (
          <div className="card max-w-5xl mx-auto w-full">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-gray-900">
                    {subscription.plan_name || currentTier}
                  </h2>
                  <span className={STATUS_BADGE[subscription.status] || 'badge-neutral'}>
                    {subscription.status.replace('_', ' ')}
                  </span>
                </div>
                <p className="text-sm text-gray-500 mt-1">
                  {isPaid
                    ? `${formatMoney(subscription.monthly_amount, subscription.currency)} per month`
                    : 'No monthly charge'}
                </p>
              </div>
              <div className="flex flex-col sm:items-end gap-2 text-sm text-gray-600">
                {subscription.next_billing_at && (
                  <span className="flex items-center gap-1.5">
                    <CalendarClock className="w-4 h-4 text-gray-400" />
                    Next billing: {formatDate(subscription.next_billing_at)}
                  </span>
                )}
                {isPaid && canManageSubscription && (
                  <button className="btn-ghost btn-sm text-red-600" onClick={() => setCancelOpen(true)}>
                    Cancel subscription
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="spinner" />
          </div>
        ) : plans.length === 0 ? (
          <div className="empty-state max-w-5xl mx-auto">
            <CreditCard className="w-12 h-12 text-gray-300 mx-auto" />
            <h3 className="mt-3 text-sm font-semibold text-gray-900">Plans unavailable</h3>
            <p className="mt-1 text-sm text-gray-500">
              Subscription plans could not be loaded. Please try again later.
            </p>
            <button className="btn-secondary btn-sm mt-4" onClick={load}>Retry</button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {plans.map((plan) => {
              const isCurrent = plan.tier === currentTier;
              const isPopular = plan.tier === 'premium';
              const isUpgrade = plan.tier !== 'free' && !isCurrent;

              return (
                <div key={plan.tier} className={`card relative ${isPopular ? 'ring-2 ring-primary-500' : ''}`}>
                  {isPopular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <span className="bg-primary-500 text-white text-xs font-semibold px-3 py-1 rounded-full flex items-center gap-1">
                        <Star className="w-3 h-3" /> Most Popular
                      </span>
                    </div>
                  )}
                  <div className="text-center mb-6">
                    <h3 className="text-lg font-bold">{plan.name}</h3>
                    <div className="mt-2">
                      <span className="text-3xl font-bold text-gray-900">
                        {Number(plan.monthly_price) === 0 ? 'Free' : formatMoney(plan.monthly_price, plan.currency)}
                      </span>
                      {Number(plan.monthly_price) > 0 && (
                        <span className="text-gray-500 text-sm">/month</span>
                      )}
                    </div>
                    {plan.annual_price != null && Number(plan.annual_price) > 0 && (
                      <p className="text-xs text-gray-500 mt-1">
                        or {formatMoney(plan.annual_price, plan.currency)}/year (2 months free)
                      </p>
                    )}
                    <p className="text-sm text-gray-500 mt-2">{plan.description}</p>
                  </div>

                  <ul className="space-y-3 mb-6">
                    {(plan.features || []).map((feature) => (
                      <li key={feature} className="flex items-start gap-2 text-sm">
                        <Check className="w-4 h-4 text-primary-500 flex-shrink-0 mt-0.5" />
                        <span>{featureLabel(feature)}</span>
                      </li>
                    ))}
                    <li className="flex items-start gap-2 text-sm">
                      <Users className="w-4 h-4 text-primary-500 flex-shrink-0 mt-0.5" />
                      <span>
                        Up to {plan.max_users} user account{plan.max_users === 1 ? '' : 's'}
                        {plan.max_patients
                          ? ` · ${plan.max_patients.toLocaleString()} patients`
                          : ' · unlimited patients'}
                      </span>
                    </li>
                  </ul>

                  {isCurrent ? (
                    <button
                      className="w-full py-3 rounded-xl font-semibold text-sm bg-primary-100 text-primary-700 cursor-default"
                      disabled
                    >
                      Current Plan
                    </button>
                  ) : isUpgrade ? (
                    <button
                      className={`w-full py-3 rounded-xl font-semibold text-sm ${isPopular ? 'btn-primary' : 'btn-secondary'}`}
                      disabled={!canManageSubscription}
                      onClick={() => setUpgradePlan(plan)}
                      title={canManageSubscription ? undefined : 'Only the pharmacy owner can change the plan'}
                    >
                      {currentTier === 'enterprise' ? 'Switch plan' : 'Upgrade'}
                    </button>
                  ) : (
                    <button
                      className="w-full py-3 rounded-xl font-semibold text-sm btn-secondary"
                      disabled={!canManageSubscription || !isPaid}
                      onClick={() => setCancelOpen(true)}
                    >
                      Downgrade to free
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!canManageSubscription && (
          <p className="text-center text-xs text-gray-500 max-w-5xl mx-auto">
            Only the pharmacy owner can change the subscription plan.
          </p>
        )}

        {/* Payment Methods */}
        <div className="max-w-5xl mx-auto card w-full">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <CreditCard className="w-5 h-5" />
            Payment Methods
          </h3>
          <div className="flex flex-wrap gap-3 mb-4">
            {['MTN MoMo', 'Telecel Cash', 'AT Money', 'Visa / Mastercard'].map((method) => (
              <div
                key={method}
                className="flex items-center gap-2 px-4 py-2 bg-gray-50 rounded-xl border border-gray-200"
              >
                <Smartphone className="w-4 h-4 text-gray-400" />
                <span className="text-sm font-medium">{method}</span>
              </div>
            ))}
          </div>
          <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-100">
            <Info className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-800">
              Online payment collection is not connected yet. Upgrades are activated manually: you record how
              you paid, the plan switches on immediately, and our team reconciles the payment afterwards.
              Mobile Money and card gateway integration (Paystack / Hubtel) is on the roadmap.
            </p>
          </div>
        </div>
      </div>

      <UpgradeModal
        plan={upgradePlan}
        onClose={() => setUpgradePlan(null)}
        onActivated={async (tier) => {
          setUpgradePlan(null);
          updatePharmacy({ subscription_tier: tier });
          await load();
        }}
      />

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={handleCancel}
        busy={cancelling}
        title="Cancel subscription"
        message="Your pharmacy will be downgraded to the free plan at the end of today. Existing patient and inventory records are kept, but paid features such as NHIS claims and advanced analytics will stop working."
        confirmLabel="Cancel subscription"
      />
    </DashboardLayout>
  );
}

function UpgradeModal({
  plan,
  onClose,
  onActivated,
}: {
  plan: Plan | null;
  onClose: () => void;
  onActivated: (tier: string) => void;
}) {
  const [method, setMethod] = useState('momo');
  const [reference, setReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (plan) {
      setMethod('momo');
      setReference('');
      setTouched(false);
    }
  }, [plan]);

  if (!plan) return null;

  const referenceInvalid = touched && reference.trim() === '';

  const handleActivate = async () => {
    setTouched(true);
    if (!reference.trim()) return;

    setSubmitting(true);
    try {
      await api.post('/subscriptions/activate', {
        tier: plan.tier,
        payment_method: method,
        payment_reference: reference.trim(),
      });
      toast.success(`${plan.name} plan activated`);
      onActivated(plan.tier);
    } catch (error: any) {
      toast.error(error?.message || 'Failed to activate subscription');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={!!plan}
      onClose={() => { if (!submitting) onClose(); }}
      title={`Activate the ${plan.name} plan`}
      description="Manual activation — payment gateway integration pending"
      footer={
        <>
          <button className="btn-secondary btn-sm" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={handleActivate} disabled={submitting}>
            {submitting && <div className="spinner" />}
            Activate plan
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-100">
          <Info className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-amber-800">
            No money is collected through this app yet. Pay{' '}
            <span className="font-semibold">
              {formatMoney(plan.monthly_price, plan.currency)}/month
            </span>{' '}
            by Mobile Money or bank transfer, then enter the transaction reference below so our team can
            match your payment. The plan becomes active immediately.
          </p>
        </div>

        <div className="p-3 rounded-xl bg-gray-50 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Plan</span>
            <span className="font-medium text-gray-900">{plan.name}</span>
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-gray-500">Monthly</span>
            <span className="font-medium text-gray-900">{formatMoney(plan.monthly_price, plan.currency)}</span>
          </div>
          {plan.annual_price != null && Number(plan.annual_price) > 0 && (
            <div className="flex items-center justify-between mt-1">
              <span className="text-gray-500">Annual</span>
              <span className="font-medium text-gray-900">{formatMoney(plan.annual_price, plan.currency)}</span>
            </div>
          )}
        </div>

        <div>
          <label className="label">How did you pay?</label>
          <select className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
            {PAYMENT_METHODS.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="label">Payment reference *</label>
          <input
            type="text"
            className={`input ${referenceInvalid ? 'input-error' : ''}`}
            placeholder="e.g. MoMo transaction ID or bank transfer reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
          {referenceInvalid && (
            <p className="text-xs text-red-600 mt-1">Enter the reference from your payment confirmation</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
