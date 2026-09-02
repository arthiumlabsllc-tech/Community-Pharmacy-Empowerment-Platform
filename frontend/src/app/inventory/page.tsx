'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePermissions } from '@/hooks/use-permissions';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ItemFormModal, type InventoryItem } from '@/components/inventory/item-form-modal';
import { BulkUploadModal } from '@/components/inventory/bulk-upload-modal';
import { api } from '@/lib/api';
import {
  Search,
  Plus,
  CalendarClock,
  Package,
  Upload,
  Edit2,
  Trash2,
  Boxes,
  AlertTriangle,
} from 'lucide-react';

interface InventorySummary {
  total_items: number;
  total_units: number;
  stock_value: string | number;
  low_stock: number;
  out_of_stock: number;
  expired: number;
  expiring_30d: number;
  expiring_90d: number;
}

type TabKey = 'all' | 'low-stock' | 'expiring';

const TAB_LABEL: Record<TabKey, string> = {
  all: 'All Items',
  'low-stock': 'Low Stock',
  expiring: 'Expiring Soon',
};

function getStatus(item: InventoryItem) {
  const daysToExpiry = Math.ceil(
    (new Date(item.expiry_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );

  if (daysToExpiry < 0) return { label: 'Expired', className: 'badge-danger' };
  if (item.quantity === 0) return { label: 'Out of Stock', className: 'badge-danger' };
  if (daysToExpiry <= 30) return { label: `Expires in ${daysToExpiry}d`, className: 'badge-warning' };
  if (item.quantity <= item.reorder_level) return { label: 'Low Stock', className: 'badge-warning' };
  return { label: 'In Stock', className: 'badge-success' };
}

export default function InventoryPage() {
  const { isAuthenticated } = useAuthStore();
  const hydrated = useHydrated();
  const router = useRouter();
  const { canEditInventory, canDeleteInventory } = usePermissions();

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [summary, setSummary] = useState<InventorySummary | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [fefo, setFefo] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [formOpen, setFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<InventoryItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const debouncedSearch = useDebouncedValue(search, 400);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  // The top-bar search deep-links here with ?q=<product name>.
  // Read from window.location rather than useSearchParams() so the page can
  // still be statically rendered without a Suspense boundary.
  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    const query = new URLSearchParams(window.location.search).get('q');
    if (query) setSearch(query);
  }, [hydrated, isAuthenticated]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();

      if (activeTab === 'low-stock') {
        const response = await api.get('/inventory/low-stock');
        const rows: InventoryItem[] = response.data || [];
        setItems(fefo ? [...rows].sort(byExpiry) : rows);
        setTotalPages(1);
      } else if (activeTab === 'expiring') {
        // The endpoint already returns soonest-expiry first, which is FEFO order.
        const response = await api.get('/inventory/expiring?days=90');
        setItems(response.data || []);
        setTotalPages(1);
      } else {
        params.set('page', String(page));
        params.set('limit', '50');
        if (debouncedSearch) params.set('search', debouncedSearch);
        if (category) params.set('category', category);
        params.set('sort', fefo ? 'expiry_date' : 'product_name');
        params.set('order', fefo ? 'asc' : 'asc');

        const response = await api.get(`/inventory?${params.toString()}`);
        setItems(response.data || []);
        setTotalPages(response.pagination?.totalPages || 1);
      }
    } catch {
      toast.error('Failed to load inventory');
    } finally {
      setLoading(false);
    }
  }, [activeTab, debouncedSearch, category, page, fefo]);

  const loadMeta = useCallback(async () => {
    try {
      const [summaryResponse, categoriesResponse] = await Promise.allSettled([
        api.get('/inventory/summary'),
        api.get('/inventory/categories/list'),
      ]);
      if (summaryResponse.status === 'fulfilled') setSummary(summaryResponse.value.data);
      if (categoriesResponse.status === 'fulfilled') {
        setCategories((categoriesResponse.value.data || []).map((row: any) => row.category));
      }
    } catch {
      // Summary and categories are decorative — the table still works without them.
    }
  }, []);

  useEffect(() => {
    if (hydrated && isAuthenticated) {
      load();
      loadMeta();
    }
  }, [hydrated, isAuthenticated, load, loadMeta]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, category, activeTab]);

  const refreshAll = async () => {
    await Promise.all([load(), loadMeta()]);
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.delete(`/inventory/${pendingDelete.id}`);
      toast.success(`${pendingDelete.product_name} removed from inventory`);
      setPendingDelete(null);
      await refreshAll();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to delete item');
    } finally {
      setDeleting(false);
    }
  };

  if (!hydrated || !isAuthenticated) return null;

  const tabCounts: Record<TabKey, number | undefined> = {
    all: summary?.total_items,
    'low-stock': summary?.low_stock,
    expiring: summary?.expiring_90d,
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Inventory</h1>
            <p className="text-gray-500 mt-1">Manage your pharmacy stock and supplies</p>
          </div>
          <div className="flex gap-3">
            {canEditInventory && (
              <>
                <button className="btn-secondary btn-sm" onClick={() => setUploadOpen(true)}>
                  <Upload className="w-4 h-4" />
                  Bulk Upload
                </button>
                <button
                  className="btn-primary btn-sm"
                  onClick={() => { setEditingItem(null); setFormOpen(true); }}
                >
                  <Plus className="w-4 h-4" />
                  Add Item
                </button>
              </>
            )}
          </div>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="stat-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Products</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{summary?.total_items ?? '—'}</p>
              </div>
              <Boxes className="w-9 h-9 text-primary-600 opacity-20" />
            </div>
            <p className="text-xs text-gray-400 mt-2">{summary?.total_units ?? 0} units on hand</p>
          </div>
          <div className="stat-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Stock Value</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">
                  {summary ? `GHS ${Number(summary.stock_value).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
                </p>
              </div>
              <Package className="w-9 h-9 text-green-600 opacity-20" />
            </div>
            <p className="text-xs text-gray-400 mt-2">At current selling prices</p>
          </div>
          <div className="stat-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Needs Reorder</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{summary?.low_stock ?? '—'}</p>
              </div>
              <AlertTriangle className="w-9 h-9 text-yellow-500 opacity-20" />
            </div>
            <p className="text-xs text-gray-400 mt-2">{summary?.out_of_stock ?? 0} out of stock</p>
          </div>
          <div className="stat-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Expiry Risk</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{summary?.expiring_90d ?? '—'}</p>
              </div>
              <CalendarClock className="w-9 h-9 text-red-500 opacity-20" />
            </div>
            <p className="text-xs text-gray-400 mt-2">
              {summary?.expiring_30d ?? 0} within 30 days · {summary?.expired ?? 0} already expired
            </p>
          </div>
        </div>

        {/* Tabs + filters */}
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-full lg:w-fit overflow-x-auto">
            {(Object.keys(TAB_LABEL) as TabKey[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                  activeTab === tab ? 'bg-white shadow text-primary-700' : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                {TAB_LABEL[tab]}
                {tabCounts[tab] !== undefined && (
                  <span className="ml-1.5 text-xs text-gray-400">({tabCounts[tab]})</span>
                )}
              </button>
            ))}
          </div>

          <div className="flex flex-1 flex-col sm:flex-row gap-3">
            <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-4 py-2.5 flex-1">
              <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <input
                type="text"
                placeholder="Search by name, generic name or code..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 text-sm outline-none bg-transparent"
              />
            </div>

            {activeTab === 'all' && (
              <select className="select sm:w-44" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All categories</option>
                {categories.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            )}

            <button
              type="button"
              onClick={() => setFefo((v) => !v)}
              title="First-Expiry-First-Out: sort stock so the earliest-expiring batch is dispensed first"
              className={`btn-sm whitespace-nowrap ${fefo ? 'btn-primary' : 'btn-secondary'}`}
            >
              <CalendarClock className="w-4 h-4" />
              FEFO {fefo ? 'on' : 'off'}
            </button>
          </div>
        </div>

        {activeTab !== 'all' && search && (
          <p className="text-xs text-gray-500">
            Search applies to the full catalogue. Showing all {TAB_LABEL[activeTab].toLowerCase()} items —{' '}
            <button className="text-primary-600 underline" onClick={() => setActiveTab('all')}>
              switch to All Items
            </button>{' '}
            to filter by name.
          </p>
        )}

        {/* Table */}
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>Batch / Lot</th>
                <th>Quantity</th>
                <th>Unit Price</th>
                <th>Expiry Date</th>
                <th>Status</th>
                {(canEditInventory || canDeleteInventory) && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="text-center py-8">
                    <div className="spinner mx-auto" />
                    <p className="text-sm text-gray-500 mt-2">Loading inventory...</p>
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-12">
                    <Package className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                    <p className="text-gray-500">
                      {search || category ? 'No items match your filters' : 'No items in this view'}
                    </p>
                    {canEditInventory && !search && !category && (
                      <button
                        className="btn-primary btn-sm mt-4"
                        onClick={() => { setEditingItem(null); setFormOpen(true); }}
                      >
                        <Plus className="w-4 h-4" />
                        Add your first item
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                items.map((item) => {
                  const status = getStatus(item);
                  return (
                    <tr key={item.id}>
                      <td>
                        <div>
                          <div className="font-medium text-gray-900">{item.product_name}</div>
                          <div className="text-xs text-gray-500">
                            {item.product_code}
                            {item.generic_name ? ` · ${item.generic_name}` : ''}
                            {item.requires_prescription ? ' · Rx only' : ''}
                          </div>
                        </div>
                      </td>
                      <td className="text-sm">{item.category || '—'}</td>
                      <td className="text-sm font-mono text-xs">{item.batch_number || '—'}</td>
                      <td>
                        <span
                          className={`font-semibold ${
                            item.quantity === 0
                              ? 'text-red-600'
                              : item.quantity <= item.reorder_level
                                ? 'text-yellow-600'
                                : ''
                          }`}
                        >
                          {item.quantity}
                        </span>
                        <span className="text-xs text-gray-400 ml-1">/ {item.reorder_level}</span>
                      </td>
                      <td className="text-sm">GHS {Number(item.unit_price).toFixed(2)}</td>
                      <td className="text-sm">
                        {new Date(item.expiry_date).toLocaleDateString([], {
                          day: 'numeric', month: 'short', year: 'numeric',
                        })}
                      </td>
                      <td><span className={status.className}>{status.label}</span></td>
                      {(canEditInventory || canDeleteInventory) && (
                        <td>
                          <div className="flex gap-1">
                            {canEditInventory && (
                              <button
                                className="p-2 rounded-lg hover:bg-gray-100 text-gray-500"
                                title="Edit item"
                                aria-label={`Edit ${item.product_name}`}
                                onClick={() => { setEditingItem(item); setFormOpen(true); }}
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                            )}
                            {canDeleteInventory && (
                              <button
                                className="p-2 rounded-lg hover:bg-red-50 text-red-500"
                                title="Remove item"
                                aria-label={`Remove ${item.product_name}`}
                                onClick={() => setPendingDelete(item)}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && activeTab === 'all' && (
          <div className="flex items-center justify-between">
            <button
              className="btn-secondary btn-sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <span className="text-sm text-gray-500">Page {page} of {totalPages}</span>
            <button
              className="btn-secondary btn-sm"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        )}
      </div>

      <ItemFormModal
        open={formOpen}
        item={editingItem}
        categories={categories}
        onClose={() => { setFormOpen(false); setEditingItem(null); }}
        onSaved={async () => {
          setFormOpen(false);
          setEditingItem(null);
          await refreshAll();
        }}
      />

      <BulkUploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={async () => {
          setUploadOpen(false);
          await refreshAll();
        }}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={handleDelete}
        busy={deleting}
        title="Remove inventory item"
        message={`Remove "${pendingDelete?.product_name}" (batch ${pendingDelete?.batch_number || 'n/a'}) from inventory? The record is deactivated rather than deleted, so historical reports stay intact.`}
        confirmLabel="Remove item"
      />
    </DashboardLayout>
  );
}

/** First-Expiry-First-Out ordering: earliest expiry date first. */
function byExpiry(a: InventoryItem, b: InventoryItem) {
  return new Date(a.expiry_date).getTime() - new Date(b.expiry_date).getTime();
}
