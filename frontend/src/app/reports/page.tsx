'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  BarChart3,
  Download,
  Loader2,
  Lock,
  Percent,
  Receipt,
  RefreshCw,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { usePermissions } from '@/hooks/use-permissions';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { api } from '@/lib/api';
import {
  money,
  PAYMENT_METHOD_LABEL,
  VAT_TREATMENT_LABEL,
  type DailySalesPoint,
  type PaymentMethod,
  type ProductProfitRow,
  type SalesSummaryReport,
  type StaffPerformanceRow,
  type VatReturnReport,
} from '@/lib/pos-types';

type TabKey = 'overview' | 'profitability' | 'staff' | 'tax';

const TABS: Array<{ key: TabKey; label: string; icon: typeof BarChart3 }> = [
  { key: 'overview', label: 'Sales overview', icon: BarChart3 },
  { key: 'profitability', label: 'Product profitability', icon: TrendingUp },
  { key: 'staff', label: 'Staff performance', icon: Users },
  { key: 'tax', label: 'VAT return', icon: Receipt },
];

const RANGES = [
  { days: 1, label: 'Today' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '12 months' },
];

function dayLabel(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : format(date, 'dd MMM');
}

/**
 * Sales, profitability and tax reporting.
 *
 * Restricted to owner and pharmacist because it exposes cost price, margin and
 * named staff performance; the backend enforces the same restriction, so a
 * cashier reaching this page directly gets an explanation rather than an
 * empty dashboard that looks broken.
 *
 * Every figure is computed server-side over completed sales. Net sales are
 * gross less VAT/NHIL/GETFund because that tax belongs to GRA, and profit is
 * measured on net sales — reporting margin on the gross figure would overstate
 * what the pharmacy actually keeps.
 */
export default function ReportsPage() {
  const { isAuthenticated } = useAuthStore();
  const hydrated = useHydrated();
  const router = useRouter();
  const { canViewSalesReports } = usePermissions();

  const [tab, setTab] = useState<TabKey>('overview');
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  const [summary, setSummary] = useState<SalesSummaryReport | null>(null);
  const [daily, setDaily] = useState<DailySalesPoint[]>([]);
  const [products, setProducts] = useState<ProductProfitRow[]>([]);
  const [staff, setStaff] = useState<StaffPerformanceRow[]>([]);
  const [tax, setTax] = useState<VatReturnReport | null>(null);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  const load = useCallback(async () => {
    if (!canViewSalesReports) return;
    setLoading(true);
    try {
      const query = `days=${days}`;
      const [summaryResponse, dailyResponse, productResponse, staffResponse, taxResponse] =
        await Promise.all([
          api.get<{ success: boolean; data: SalesSummaryReport }>(`/pos/reports/summary?${query}`),
          api.get<{ success: boolean; data: DailySalesPoint[] }>(`/pos/reports/daily?${query}`),
          api.get<{ success: boolean; data: ProductProfitRow[] }>(
            `/pos/reports/products?${query}&limit=50`
          ),
          api.get<{ success: boolean; data: StaffPerformanceRow[] }>(`/pos/reports/staff?${query}`),
          api.get<{ success: boolean; data: VatReturnReport }>(`/pos/reports/tax?${query}`),
        ]);

      setSummary(summaryResponse.data || null);
      setDaily(dailyResponse.data || []);
      setProducts(productResponse.data || []);
      setStaff(staffResponse.data || []);
      setTax(taxResponse.data || null);
    } catch (error: any) {
      toast.error(error?.message || 'Failed to load reports');
    } finally {
      setLoading(false);
    }
  }, [days, canViewSalesReports]);

  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    load();
  }, [hydrated, isAuthenticated, load]);

  /** Writes the active tab's table to a CSV so the figures can go to an accountant. */
  function exportCsv() {
    let filename = 'sales-report.csv';
    let header = '';
    let body = '';

    if (tab === 'profitability') {
      filename = `product-profitability-${days}d.csv`;
      header = 'Product,Generic,VAT treatment,Units,Transactions,Gross sales,Tax,Net sales,COGS,Gross profit,Margin %';
      body = products
        .map((row) =>
          [
            csv(row.product_name),
            csv(row.generic_name || ''),
            row.vat_treatment,
            row.units_sold,
            row.transactions,
            row.gross_sales.toFixed(2),
            row.tax.toFixed(2),
            row.net_sales.toFixed(2),
            row.cogs.toFixed(2),
            row.gross_profit.toFixed(2),
            row.margin_percent.toFixed(2),
          ].join(',')
        )
        .join('\n');
    } else if (tab === 'staff') {
      filename = `staff-performance-${days}d.csv`;
      header = 'Staff,Role,Transactions,Voided,Gross sales,Net sales,Tax collected,Discounts,Average basket';
      body = staff
        .map((row) =>
          [
            csv(row.name),
            csv(row.role || ''),
            row.transactions,
            row.voided_sales,
            row.gross_sales.toFixed(2),
            row.net_sales.toFixed(2),
            row.tax_collected.toFixed(2),
            row.discounts_given.toFixed(2),
            row.avg_basket.toFixed(2),
          ].join(',')
        )
        .join('\n');
    } else if (tab === 'tax') {
      filename = `vat-return-${days}d.csv`;
      header = 'Treatment,Lines,Units,Value,Taxable base,VAT,NHIL,GETFund';
      body = (tax?.by_treatment || [])
        .map((row) =>
          [
            row.vat_treatment,
            row.line_count,
            row.units,
            row.value.toFixed(2),
            row.taxable_base.toFixed(2),
            row.vat.toFixed(2),
            row.nhil.toFixed(2),
            row.getfund.toFixed(2),
          ].join(',')
        )
        .join('\n');
    } else {
      filename = `daily-sales-${days}d.csv`;
      header = 'Day,Transactions,Gross sales,Tax,Net sales,Discounts';
      body = daily
        .map((row) =>
          [
            row.day,
            row.transactions,
            row.gross_sales.toFixed(2),
            row.tax.toFixed(2),
            row.net_sales.toFixed(2),
            row.discounts.toFixed(2),
          ].join(',')
        )
        .join('\n');
    }

    const blob = new Blob([`${header}\n${body}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (hydrated && isAuthenticated && !canViewSalesReports) {
    return (
      <DashboardLayout>
        <div className="empty-state py-20">
          <Lock className="mx-auto h-10 w-10 text-gray-300" />
          <p className="mt-3 font-medium text-gray-800">Sales reports are restricted</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
            These reports show cost price, profit margin and named staff performance, so they are
            available to the pharmacy owner and pharmacists only. Ask your owner if you need them.
          </p>
          <a href="/pos" className="btn-primary btn-sm mt-4">Open the till</a>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="animate-fade-in space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
            <p className="text-sm text-gray-500">
              Completed sales over the last {days} day{days === 1 ? '' : 's'}.
              {summary?.period.from ? ` From ${summary.period.from}.` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary btn-sm" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={exportCsv} disabled={loading}>
              <Download className="h-4 w-4" />
              Export CSV
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {TABS.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => setTab(entry.key)}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium ${
                  tab === entry.key
                    ? 'border-primary-500 bg-primary-50 text-primary-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                <Icon className="h-4 w-4" />
                {entry.label}
              </button>
            );
          })}

          <div className="ml-auto flex flex-wrap gap-1">
            {RANGES.map((range) => (
              <button
                key={range.days}
                type="button"
                onClick={() => setDays(range.days)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                  days === range.days
                    ? 'border-gray-800 bg-gray-800 text-white'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="card flex items-center justify-center py-20 text-gray-400">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <>
            {tab === 'overview' && <OverviewTab summary={summary} daily={daily} />}
            {tab === 'profitability' && <ProfitabilityTab products={products} />}
            {tab === 'staff' && <StaffTab staff={staff} />}
            {tab === 'tax' && <TaxTab tax={tax} />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

function csv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab({
  summary,
  daily,
}: {
  summary: SalesSummaryReport | null;
  daily: DailySalesPoint[];
}) {
  if (!summary) return <Empty message="No sales data for this period." />;

  // Money recorded by hand rather than settled through the gateway. Shown
  // separately because it has not been confirmed by Paystack.
  const manualTotal = summary.payment_methods.reduce(
    (total, entry) => total + (entry.manual_count > 0 ? entry.total : 0),
    0
  );
  const manualPayments = summary.payment_methods.reduce(
    (total, entry) => total + entry.manual_count,
    0
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          icon={<Receipt className="h-5 w-5" />}
          color="primary"
          label="Transactions"
          value={String(summary.transactions)}
          hint={`${summary.units_sold} units sold`}
        />
        <Metric
          icon={<Wallet className="h-5 w-5" />}
          color="green"
          label="Gross takings"
          value={money(summary.gross_sales)}
          hint={`Avg basket ${money(summary.avg_basket)}`}
        />
        <Metric
          icon={<Percent className="h-5 w-5" />}
          color="yellow"
          label="Tax collected"
          value={money(summary.tax)}
          hint="Owed to GRA, not revenue"
        />
        <Metric
          icon={<TrendingUp className="h-5 w-5" />}
          color="purple"
          label="Gross profit"
          value={money(summary.gross_profit)}
          hint={`${summary.margin_percent.toFixed(1)}% margin on net sales`}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SmallStat label="Net sales (excl. tax)" value={money(summary.net_sales)} />
        <SmallStat label="Cost of goods sold" value={money(summary.cogs)} />
        <SmallStat label="Discounts given" value={money(summary.discounts)} />
        <SmallStat label="Exempt stock sold" value={money(summary.exempt_value)} />
        <SmallStat label="Largest sale" value={money(summary.largest_sale)} />
        <SmallStat label="Voided sales" value={String(summary.voided_sales)} />
        <SmallStat
          label="Awaiting payment"
          value={`${summary.outstanding.pending_sales} · ${money(summary.outstanding.owed)}`}
        />
        <SmallStat label="Manual payments" value={`${manualPayments}`} />
      </div>

      {manualPayments > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <p>
            {money(manualTotal)} across {manualPayments} payment
            {manualPayments === 1 ? '' : 's'} was recorded by hand rather than settled through
            Paystack. The app wrote down what the cashier said they received — it cannot confirm
            the money arrived. Add PAYSTACK_SECRET_KEY on the server to settle mobile money and
            card electronically.
          </p>
        </div>
      )}

      <div className="card p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">Daily takings</h2>
        {daily.length === 0 ? (
          <Empty message="No completed sales in this period." />
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={daily.map((point) => ({ ...point, label: dayLabel(point.day) }))}>
                <defs>
                  <linearGradient id="gross" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0d9488" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="tax" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#d97706" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#d97706" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={20} />
                <YAxis tick={{ fontSize: 11 }} width={56} />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    money(value),
                    name === 'gross_sales' ? 'Gross takings' : 'Tax collected',
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey="gross_sales"
                  stroke="#0d9488"
                  strokeWidth={2}
                  fill="url(#gross)"
                />
                <Area
                  type="monotone"
                  dataKey="tax"
                  stroke="#d97706"
                  strokeWidth={1.5}
                  fill="url(#tax)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">By payment method</h2>
        </div>
        {summary.payment_methods.length === 0 ? (
          <Empty message="No payments recorded." />
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Method</th>
                  <th className="text-right">Payments</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Recorded manually</th>
                </tr>
              </thead>
              <tbody>
                {summary.payment_methods.map((entry) => (
                  <tr key={entry.method}>
                    <td className="font-medium text-gray-900">
                      {PAYMENT_METHOD_LABEL[entry.method as PaymentMethod] || entry.method}
                    </td>
                    <td className="text-right tabular-nums">{entry.payment_count}</td>
                    <td className="text-right font-semibold tabular-nums">{money(entry.total)}</td>
                    <td className="text-right tabular-nums">
                      {entry.manual_count > 0 ? (
                        <span className="badge badge-warning">{entry.manual_count}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Product profitability
// ---------------------------------------------------------------------------

function ProfitabilityTab({ products }: { products: ProductProfitRow[] }) {
  if (products.length === 0) return <Empty message="No products sold in this period." />;

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500">
        Ranked by gross takings. Profit is measured on net sales (takings less the VAT, NHIL and
        GETFund levy that belongs to GRA) minus the cost recorded at the moment of sale.
      </p>
      <div className="card overflow-hidden">
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="text-right">Units</th>
                <th className="text-right">Sales</th>
                <th className="text-right">Gross</th>
                <th className="text-right">Tax</th>
                <th className="text-right">Net</th>
                <th className="text-right">Cost</th>
                <th className="text-right">Profit</th>
                <th className="text-right">Margin</th>
              </tr>
            </thead>
            <tbody>
              {products.map((row) => (
                <tr key={row.product_name}>
                  <td>
                    <span className="font-medium text-gray-900">{row.product_name}</span>
                    {row.generic_name && (
                      <span className="block text-xs text-gray-500">{row.generic_name}</span>
                    )}
                    <span className="badge badge-neutral mt-1 text-2xs">
                      {VAT_TREATMENT_LABEL[row.vat_treatment] || row.vat_treatment}
                    </span>
                  </td>
                  <td className="text-right tabular-nums">{row.units_sold}</td>
                  <td className="text-right tabular-nums text-gray-500">{row.transactions}</td>
                  <td className="text-right tabular-nums">{money(row.gross_sales)}</td>
                  <td className="text-right tabular-nums text-gray-500">{money(row.tax)}</td>
                  <td className="text-right tabular-nums">{money(row.net_sales)}</td>
                  <td className="text-right tabular-nums text-gray-500">{money(row.cogs)}</td>
                  <td
                    className={`text-right font-semibold tabular-nums ${
                      row.gross_profit < 0 ? 'text-red-600' : 'text-gray-900'
                    }`}
                  >
                    {money(row.gross_profit)}
                  </td>
                  <td
                    className={`text-right tabular-nums ${
                      row.margin_percent < 0
                        ? 'font-semibold text-red-600'
                        : row.margin_percent < 10
                          ? 'text-amber-600'
                          : 'text-green-700'
                    }`}
                  >
                    {row.margin_percent.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {products.some((row) => row.gross_profit < 0) && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <p>
            Some products are being sold below cost. Check whether the shelf price was updated
            after the last purchase, or whether a discount is being applied too broadly.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staff performance
// ---------------------------------------------------------------------------

function StaffTab({ staff }: { staff: StaffPerformanceRow[] }) {
  if (staff.length === 0) return <Empty message="No active staff at this pharmacy." />;

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500">
        Every active staff member is listed, including those who made no sales in this period, so
        an empty row is visible rather than silently missing.
      </p>
      <div className="card overflow-hidden">
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Staff member</th>
                <th>Role</th>
                <th className="text-right">Sales</th>
                <th className="text-right">Gross takings</th>
                <th className="text-right">Avg basket</th>
                <th className="text-right">Tax collected</th>
                <th className="text-right">Discounts</th>
                <th className="text-right">Voided</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((row) => (
                <tr key={row.id}>
                  <td className="font-medium text-gray-900">{row.name}</td>
                  <td>
                    <span className="badge badge-neutral">{row.role || '—'}</span>
                  </td>
                  <td className="text-right tabular-nums">{row.transactions}</td>
                  <td className="text-right font-semibold tabular-nums">{money(row.gross_sales)}</td>
                  <td className="text-right tabular-nums">{money(row.avg_basket)}</td>
                  <td className="text-right tabular-nums text-gray-500">
                    {money(row.tax_collected)}
                  </td>
                  <td className="text-right tabular-nums text-gray-500">
                    {money(row.discounts_given)}
                  </td>
                  <td className="text-right tabular-nums">
                    {row.voided_sales > 0 ? (
                      <span className="badge badge-danger">{row.voided_sales}</span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VAT return
// ---------------------------------------------------------------------------

function TaxTab({ tax }: { tax: VatReturnReport | null }) {
  if (!tax) return <Empty message="No tax data for this period." />;

  return (
    <div className="space-y-4">
      {/* Stated plainly so nobody files a return from a dashboard that has
          quietly stopped charging VAT. */}
      {tax.notice && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <p className="font-medium">{tax.notice}</p>
        </div>
      )}

      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">
              {tax.pharmacy.name || 'Pharmacy'}
            </h2>
            <p className="text-xs text-gray-500">
              {tax.pharmacy.license_number ? `Licence ${tax.pharmacy.license_number} · ` : ''}
              {tax.transactions} completed sale{tax.transactions === 1 ? '' : 's'} over{' '}
              {tax.period.days} day{tax.period.days === 1 ? '' : 's'}
            </p>
          </div>
          <span className={`badge ${tax.vat_registered ? 'badge-success' : 'badge-danger'}`}>
            {tax.vat_registered ? 'VAT registered' : 'NOT VAT registered'}
          </span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SmallStat label="Gross takings" value={money(tax.gross_sales)} />
          <SmallStat label="Taxable base" value={money(tax.taxable_base)} />
          <SmallStat label="Exempt sales" value={money(tax.exempt_value)} />
          <SmallStat label="Total levies" value={money(tax.total_levies)} />
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">
            Output tax under the Value Added Tax Act, 2025 (Act 1151)
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            VAT 15%, NHIL 2.5% and the GETFund Levy 2.5% are each charged on the same taxable base.
            Chapter 30 pharmaceuticals are exempt under the First Schedule.
          </p>
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <LevyCard label="VAT (15%)" value={tax.vat} />
          <LevyCard label="NHIL (2.5%)" value={tax.nhil} />
          <LevyCard label="GETFund Levy (2.5%)" value={tax.getfund} />
        </div>

        <div className="table-container border-t border-gray-100">
          <table className="table">
            <thead>
              <tr>
                <th>Treatment</th>
                <th className="text-right">Lines</th>
                <th className="text-right">Units</th>
                <th className="text-right">Value</th>
                <th className="text-right">Taxable base</th>
                <th className="text-right">VAT</th>
                <th className="text-right">NHIL</th>
                <th className="text-right">GETFund</th>
              </tr>
            </thead>
            <tbody>
              {tax.by_treatment.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-sm text-gray-500">
                    Nothing sold in this period.
                  </td>
                </tr>
              ) : (
                tax.by_treatment.map((row) => (
                  <tr key={row.vat_treatment}>
                    <td className="font-medium text-gray-900">
                      {VAT_TREATMENT_LABEL[row.vat_treatment] || row.vat_treatment}
                    </td>
                    <td className="text-right tabular-nums">{row.line_count}</td>
                    <td className="text-right tabular-nums">{row.units}</td>
                    <td className="text-right tabular-nums">{money(row.value)}</td>
                    <td className="text-right tabular-nums">{money(row.taxable_base)}</td>
                    <td className="text-right tabular-nums">{money(row.vat)}</td>
                    <td className="text-right tabular-nums">{money(row.nhil)}</td>
                    <td className="text-right tabular-nums">{money(row.getfund)}</td>
                  </tr>
                ))
              )}
            </tbody>
            {tax.by_treatment.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-gray-200 font-semibold">
                  <td>Total</td>
                  <td className="text-right tabular-nums">
                    {tax.by_treatment.reduce((total, row) => total + row.line_count, 0)}
                  </td>
                  <td className="text-right tabular-nums">
                    {tax.by_treatment.reduce((total, row) => total + row.units, 0)}
                  </td>
                  <td className="text-right tabular-nums">
                    {money(tax.by_treatment.reduce((total, row) => total + row.value, 0))}
                  </td>
                  <td className="text-right tabular-nums">{money(tax.taxable_base)}</td>
                  <td className="text-right tabular-nums">{money(tax.vat)}</td>
                  <td className="text-right tabular-nums">{money(tax.nhil)}</td>
                  <td className="text-right tabular-nums">{money(tax.getfund)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        This is a management summary of output tax, not a GRA filing. It covers completed sales
        only — voided sales are excluded — and does not include input tax on purchases.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const METRIC_COLOR = {
  primary: 'bg-primary-50 text-primary-600',
  green: 'bg-green-50 text-green-600',
  yellow: 'bg-yellow-50 text-yellow-600',
  purple: 'bg-purple-50 text-purple-600',
};

function Metric({
  icon,
  label,
  value,
  hint,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  color: keyof typeof METRIC_COLOR;
}) {
  return (
    <div className="stat-card">
      <div className="flex items-center gap-3">
        <div className={`p-2.5 rounded-xl ${METRIC_COLOR[color]}`}>{icon}</div>
        <span className="stat-label">{label}</span>
      </div>
      <div className="stat-value">{value}</div>
      {hint && <span className="stat-change text-gray-500">{hint}</span>}
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white px-3 py-2">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm font-semibold tabular-nums text-gray-900">{value}</p>
    </div>
  );
}

function LevyCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums text-gray-900">{money(value)}</p>
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="card py-14 text-center">
      <BarChart3 className="mx-auto h-9 w-9 text-gray-300" />
      <p className="mt-2 text-sm text-gray-500">{message}</p>
    </div>
  );
}
