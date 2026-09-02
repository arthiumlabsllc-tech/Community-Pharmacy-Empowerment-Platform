'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { StatCard } from '@/components/ui/stat-card';
import { api } from '@/lib/api';
import {
  Package,
  Users,
  FileText,
  AlertTriangle,
  Clock,
  Activity,
  Boxes,
  ArrowRight,
  Stethoscope,
  ShoppingCart,
} from 'lucide-react';

interface AnalyticsSummary {
  totalPatients: number;
  totalInventoryItems: number;
  totalInventoryUnits: number;
  lowStockItems: number;
  expiringSoonItems: number;
}

interface Analytics {
  summary: AnalyticsSummary;
  sales: { date: string; count: string; revenue: string | null }[];
  prescriptions: { status: string; count: string }[];
  claims: { status: string; count: string; total_amount: string }[];
  patientGrowth: { date: string; new_patients: string }[];
  topMedications: { product_name: string; category: string; quantity: number; unit_price: string }[];
  revenueByCategory: { category: string; item_count: string; total_value: string }[];
}

interface PerformanceScore {
  overall_score: number;
  rating: string;
  breakdown: Record<string, { score: number; weight: number }>;
}

interface ClaimSummaryRow {
  status: string;
  count: string;
  amount: string;
}

interface ActivityItem {
  kind: string;
  title: string;
  detail: string;
  at: string;
}

interface StockAlert {
  id: string;
  product_name: string;
  quantity: number;
  reorder_level: number;
  expiry_date: string | null;
}

const RATING_LABEL: Record<string, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  needs_improvement: 'Needs improvement',
};

const RATING_BADGE: Record<string, string> = {
  excellent: 'badge-success',
  good: 'badge-success',
  fair: 'badge-warning',
  needs_improvement: 'badge-danger',
};

const BREAKDOWN_LABEL: Record<string, string> = {
  claim_approval: 'Claims approval',
  inventory_health: 'Inventory health',
  patient_engagement: 'Patient engagement',
  health_screenings: 'Health screenings',
};

function formatMoney(value: number) {
  if (value >= 1000) return `GHS ${(value / 1000).toFixed(1)}K`;
  return `GHS ${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function timeAgo(iso: string) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function daysUntil(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

export default function DashboardPage() {
  const { user, pharmacy, isAuthenticated } = useAuthStore();
  const hydrated = useHydrated();
  const router = useRouter();

  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [score, setScore] = useState<PerformanceScore | null>(null);
  const [claimSummary, setClaimSummary] = useState<ClaimSummaryRow[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [lowStock, setLowStock] = useState<StockAlert[]>([]);
  const [expiring, setExpiring] = useState<StockAlert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Each request is settled independently: one slow or failing panel should
      // not blank out the whole dashboard.
      const [analyticsRes, scoreRes, claimsRes, activityRes, lowStockRes, expiringRes] =
        await Promise.allSettled([
          api.get('/pharmacies/analytics?period=30'),
          api.get('/pharmacies/performance-score'),
          api.get('/nhis/claims?limit=1'),
          api.get('/pharmacies/activity?limit=8'),
          api.get('/inventory/low-stock'),
          api.get('/inventory/expiring?days=30'),
        ]);

      if (analyticsRes.status === 'fulfilled') setAnalytics(analyticsRes.value.data);
      if (scoreRes.status === 'fulfilled') setScore(scoreRes.value.data);
      if (claimsRes.status === 'fulfilled') setClaimSummary(claimsRes.value.summary || []);
      if (activityRes.status === 'fulfilled') setActivity(activityRes.value.data || []);
      if (lowStockRes.status === 'fulfilled') setLowStock(lowStockRes.value.data || []);
      if (expiringRes.status === 'fulfilled') setExpiring(expiringRes.value.data || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hydrated && isAuthenticated) load();
  }, [hydrated, isAuthenticated, load]);

  if (!hydrated || !isAuthenticated) return null;

  const summary = analytics?.summary;

  // Inventory value is the only monetary figure computed here. Till revenue
  // lives on /reports, which reads the POS sales table and needs the
  // 001_pos.sql migration applied before it returns anything.
  const inventoryValue = (analytics?.revenueByCategory || []).reduce(
    (sum, row) => sum + Number(row.total_value || 0),
    0
  );

  const prescriptionsFilled = Number(
    (analytics?.prescriptions || []).find((p) => p.status === 'filled')?.count || 0
  );
  const prescriptionsPending = Number(
    (analytics?.prescriptions || []).find((p) => p.status === 'pending')?.count || 0
  );
  const newPatientsThisMonth = (analytics?.patientGrowth || []).reduce(
    (sum, row) => sum + Number(row.new_patients || 0),
    0
  );

  const claimCount = (...statuses: string[]) =>
    claimSummary
      .filter((row) => statuses.includes(row.status))
      .reduce((sum, row) => sum + Number(row.count), 0);
  const claimAmount = (...statuses: string[]) =>
    claimSummary
      .filter((row) => statuses.includes(row.status))
      .reduce((sum, row) => sum + Number(row.amount || 0), 0);

  const alerts = [
    ...lowStock.slice(0, 4).map((item) => ({
      id: `low-${item.id}`,
      severity: item.quantity === 0 ? 'danger' : 'warning',
      text: `${item.product_name} — ${
        item.quantity === 0 ? 'out of stock' : `low stock (${item.quantity} left)`
      }`,
      sub: `Reorder level: ${item.reorder_level}`,
    })),
    ...expiring.slice(0, 4).map((item) => {
      const days = daysUntil(item.expiry_date!);
      return {
        id: `exp-${item.id}`,
        severity: days <= 14 ? 'danger' : 'warning',
        text: `${item.product_name} — expires in ${days} day${days === 1 ? '' : 's'}`,
        sub: new Date(item.expiry_date!).toLocaleDateString([], {
          day: 'numeric', month: 'short', year: 'numeric',
        }),
      };
    }),
  ].slice(0, 6);

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in">
        {/* Welcome Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Welcome back, {user?.first_name}!
            </h1>
            <p className="text-gray-500 mt-1">
              Here&apos;s what&apos;s happening at {pharmacy?.name || 'your pharmacy'} today.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="btn-secondary btn-sm" onClick={() => router.push('/patients?new=1')}>
              <Users className="w-4 h-4" />
              Add Patient
            </button>
            <button className="btn-secondary btn-sm" onClick={() => router.push('/screenings')}>
              <Stethoscope className="w-4 h-4" />
              Record Screening
            </button>
            {/* The till is the primary action for a counter — it is the one
                screen a cashier opens all day. */}
            <button className="btn-primary btn-sm" onClick={() => router.push('/pos')}>
              <ShoppingCart className="w-4 h-4" />
              Open the Till
            </button>
          </div>
        </div>

        {/* KPI Stats Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            icon={<Boxes className="w-5 h-5" />}
            label="Inventory Value"
            value={loading && !analytics ? '—' : formatMoney(inventoryValue)}
            change={`${summary?.totalInventoryItems ?? 0} products · ${summary?.totalInventoryUnits ?? 0} units`}
            changeType="neutral"
            color="primary"
          />
          <StatCard
            icon={<FileText className="w-5 h-5" />}
            label="Prescriptions Filled"
            value={loading && !analytics ? '—' : prescriptionsFilled}
            change={`${prescriptionsPending} awaiting dispensing`}
            changeType={prescriptionsPending > 0 ? 'negative' : 'positive'}
            color="blue"
          />
          <StatCard
            icon={<Users className="w-5 h-5" />}
            label="Total Patients"
            value={loading && !analytics ? '—' : (summary?.totalPatients ?? 0).toLocaleString()}
            change={`+${newPatientsThisMonth} in the last 30 days`}
            changeType="positive"
            color="purple"
          />
          <StatCard
            icon={<AlertTriangle className="w-5 h-5" />}
            label="Low Stock Items"
            value={loading && !analytics ? '—' : (summary?.lowStockItems ?? 0)}
            change={`${summary?.expiringSoonItems ?? 0} expiring within 90 days`}
            changeType={(summary?.lowStockItems ?? 0) > 0 ? 'negative' : 'positive'}
            color="yellow"
          />
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* NHIS Claims Summary */}
          <div className="lg:col-span-2 card">
            <div className="card-header">
              <h2 className="text-lg font-semibold">NHIS Claims</h2>
              <button className="btn-ghost btn-sm" onClick={() => router.push('/claims')}>
                View All
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="text-center p-3 bg-blue-50 rounded-xl">
                <div className="text-2xl font-bold text-blue-700">
                  {claimCount('pending', 'submitted', 'resubmitted')}
                </div>
                <div className="text-xs text-blue-600 mt-1">Awaiting review</div>
              </div>
              <div className="text-center p-3 bg-green-50 rounded-xl">
                <div className="text-2xl font-bold text-green-700">{claimCount('approved', 'paid')}</div>
                <div className="text-xs text-green-600 mt-1">Approved</div>
              </div>
              <div className="text-center p-3 bg-red-50 rounded-xl">
                <div className="text-2xl font-bold text-red-700">{claimCount('rejected')}</div>
                <div className="text-xs text-red-600 mt-1">Rejected</div>
              </div>
              <div className="text-center p-3 bg-yellow-50 rounded-xl">
                <div className="text-2xl font-bold text-yellow-700">
                  {formatMoney(claimAmount('approved'))}
                </div>
                <div className="text-xs text-yellow-600 mt-1">Awaiting payment</div>
              </div>
            </div>
            {claimSummary.length === 0 && !loading && (
              <p className="text-sm text-gray-500 mt-4">
                No claims submitted yet. Create one from the Claims page to start tracking reimbursements.
              </p>
            )}
          </div>

          {/* Performance Score */}
          <div className="card">
            <div className="card-header">
              <h2 className="text-lg font-semibold">Performance Score</h2>
            </div>
            <div className="flex flex-col items-center">
              <div className="relative w-32 h-32">
                <svg className="w-full h-full" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="#e5e7eb" strokeWidth="8" />
                  <circle
                    cx="50" cy="50" r="42" fill="none"
                    stroke="#008753" strokeWidth="8"
                    strokeLinecap="round"
                    strokeDasharray={`${(score?.overall_score ?? 0) * 2.64} ${264 - (score?.overall_score ?? 0) * 2.64}`}
                    transform="rotate(-90 50 50)"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-3xl font-bold text-primary-600">
                    {score ? score.overall_score : '—'}
                  </span>
                  <span className="text-xs text-gray-500">out of 100</span>
                </div>
              </div>
              <div className="mt-3">
                <span className={RATING_BADGE[score?.rating || ''] || 'badge-neutral'}>
                  {RATING_LABEL[score?.rating || ''] || 'No data yet'}
                </span>
              </div>

              {score && (
                <div className="w-full mt-4 space-y-2.5">
                  {Object.entries(score.breakdown).map(([key, metric]) => (
                    <div key={key}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-gray-600">{BREAKDOWN_LABEL[key] || key}</span>
                        <span className="text-gray-400">{metric.score} · {metric.weight}% weight</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary-500 rounded-full transition-all"
                          style={{ width: `${Math.min(100, Math.max(0, metric.score))}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Alerts & Recent Activity */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Expiring / Low Stock Alerts */}
          <div className="card">
            <div className="card-header">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Clock className="w-5 h-5 text-yellow-500" />
                Stock Alerts
              </h2>
              <button className="btn-ghost btn-sm" onClick={() => router.push('/inventory')}>
                Manage
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
            {alerts.length === 0 ? (
              <div className="py-8 text-center">
                <Package className="w-10 h-10 text-gray-200 mx-auto" />
                <p className="text-sm text-gray-500 mt-2">
                  {loading ? 'Checking stock levels...' : 'No low-stock or expiring items. Your inventory is healthy.'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`flex items-start gap-3 p-3 rounded-lg ${
                      alert.severity === 'danger' ? 'bg-red-50' : 'bg-yellow-50'
                    }`}
                  >
                    <AlertTriangle
                      className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                        alert.severity === 'danger' ? 'text-red-500' : 'text-yellow-500'
                      }`}
                    />
                    <div className="min-w-0">
                      <span className="text-sm text-gray-700 block">{alert.text}</span>
                      <span className="text-xs text-gray-500">{alert.sub}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent Activity */}
          <div className="card">
            <div className="card-header">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Activity className="w-5 h-5 text-primary-500" />
                Recent Activity
              </h2>
            </div>
            {activity.length === 0 ? (
              <div className="py-8 text-center">
                <Activity className="w-10 h-10 text-gray-200 mx-auto" />
                <p className="text-sm text-gray-500 mt-2">
                  {loading ? 'Loading activity...' : 'No activity recorded yet for this pharmacy.'}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {activity.map((item, index) => (
                  <div key={`${item.kind}-${index}`} className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <span className="text-xs font-semibold text-primary-600 uppercase">
                        {item.kind.slice(0, 2)}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-800 font-medium">{item.title}</p>
                      <p className="text-xs text-gray-500 truncate">{item.detail}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{timeAgo(item.at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
