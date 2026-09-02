'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { CreditCard, Check, Star } from 'lucide-react';

const plans = [
  {
    tier: 'free',
    name: 'Starter',
    price: 'Free',
    period: 'Forever',
    description: 'Basic inventory and patient management',
    features: ['Basic inventory tracking', 'Up to 100 patients', '2 user accounts', 'Simple dashboard'],
    current: false,
  },
  {
    tier: 'premium',
    name: 'Professional',
    price: 'GHS 99',
    period: '/month',
    description: 'Full features including NHIS integration',
    features: ['Full inventory management', 'Up to 5,000 patients', '10 user accounts', 'NHIS claims integration', 'SMS reminders', 'Health screenings', 'Analytics dashboard'],
    current: true,
    popular: true,
  },
  {
    tier: 'enterprise',
    name: 'Enterprise',
    price: 'GHS 299',
    period: '/month',
    description: 'Multi-branch with advanced reporting',
    features: ['Everything in Professional', 'Unlimited patients', '50 user accounts', 'Multi-branch support', 'API access', 'Advanced analytics', 'Priority support', 'Custom integrations'],
    current: false,
  },
];

export default function SubscriptionPage() {
  const { isAuthenticated, _hasHydrated } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (_hasHydrated && !isAuthenticated) router.replace('/login');
  }, [isAuthenticated, _hasHydrated, router]);

  if (!_hasHydrated || !isAuthenticated) return null;

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">Subscription Plans</h1>
          <p className="text-gray-500 mt-1">Choose the plan that fits your pharmacy</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {plans.map((plan) => (
            <div key={plan.tier} className={`card relative ${plan.popular ? 'ring-2 ring-primary-500' : ''}`}>
              {plan.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="bg-primary-500 text-white text-xs font-semibold px-3 py-1 rounded-full flex items-center gap-1">
                    <Star className="w-3 h-3" /> Most Popular
                  </span>
                </div>
              )}
              <div className="text-center mb-6">
                <h3 className="text-lg font-bold">{plan.name}</h3>
                <div className="mt-2">
                  <span className="text-3xl font-bold text-gray-900">{plan.price}</span>
                  <span className="text-gray-500 text-sm">{plan.period}</span>
                </div>
                <p className="text-sm text-gray-500 mt-2">{plan.description}</p>
              </div>
              <ul className="space-y-3 mb-6">
                {plan.features.map((feature, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm">
                    <Check className="w-4 h-4 text-primary-500 flex-shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <button className={`w-full py-3 rounded-xl font-semibold text-sm ${
                plan.current
                  ? 'bg-primary-100 text-primary-700 cursor-default'
                  : plan.popular
                    ? 'btn-primary'
                    : 'btn-secondary'
              }`}>
                {plan.current ? 'Current Plan' : 'Upgrade'}
              </button>
            </div>
          ))}
        </div>

        {/* Payment Methods */}
        <div className="max-w-5xl mx-auto card">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <CreditCard className="w-5 h-5" />
            Payment Methods
          </h3>
          <div className="flex flex-wrap gap-3">
            <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 rounded-xl border border-gray-200">
              <span className="text-sm font-medium">MTN MoMo</span>
            </div>
            <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 rounded-xl border border-gray-200">
              <span className="text-sm font-medium">Vodafone Cash</span>
            </div>
            <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 rounded-xl border border-gray-200">
              <span className="text-sm font-medium">AirtelTigo Money</span>
            </div>
            <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 rounded-xl border border-gray-200">
              <span className="text-sm font-medium">Visa/Mastercard</span>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
