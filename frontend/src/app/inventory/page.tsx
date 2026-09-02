'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { api } from '@/lib/api';
import {
  Search, Plus, AlertTriangle, Calendar,
  ChevronDown, Upload, Edit2, Trash2,
} from 'lucide-react';
import toast from 'react-hot-toast';

interface InventoryItem {
  id: string;
  product_name: string;
  product_code: string;
  category: string;
  quantity: number;
  unit_price: number;
  cost_price: number;
  expiry_date: string;
  reorder_level: number;
  requires_prescription: boolean;
}

export default function InventoryPage() {
  const { isAuthenticated } = useAuthStore();
  const router = useRouter();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'all' | 'low-stock' | 'expiring'>('all');

  useEffect(() => {
    if (!isAuthenticated) router.replace('/login');
  }, [isAuthenticated, router]);

  useEffect(() => {
    loadInventory();
  }, [activeTab]);

  if (!isAuthenticated) return null;

  const loadInventory = async () => {
    setLoading(true);
    try {
      const endpoint = activeTab === 'low-stock' ? '/inventory/low-stock' :
                       activeTab === 'expiring' ? '/inventory/expiring' :
                       '/inventory?limit=50';
      const response = await api.get(endpoint);
      setItems(activeTab === 'all' ? response.data : response.data);
    } catch (error) {
      toast.error('Failed to load inventory');
    } finally {
      setLoading(false);
    }
  };

  const getStatus = (item: InventoryItem) => {
    const expDate = new Date(item.expiry_date);
    const daysToExpiry = Math.ceil((expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

    if (daysToExpiry <= 0) return { label: 'Expired', class: 'badge-danger' };
    if (daysToExpiry <= 30) return { label: 'Expiring Soon', class: 'badge-warning' };
    if (item.quantity <= item.reorder_level) return { label: 'Low Stock', class: 'badge-warning' };
    if (item.quantity === 0) return { label: 'Out of Stock', class: 'badge-danger' };
    return { label: 'In Stock', class: 'badge-success' };
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
            <button className="btn-secondary btn-sm" onClick={() => toast.success('CSV template downloaded')}>
              <Upload className="w-4 h-4" />
              Bulk Upload
            </button>
            <button className="btn-primary btn-sm" onClick={() => setShowAddModal(true)}>
              <Plus className="w-4 h-4" />
              Add Item
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
          {(['all', 'low-stock', 'expiring'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab ? 'bg-white shadow text-primary-700' : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              {tab === 'all' ? 'All Items' : tab === 'low-stock' ? 'Low Stock' : 'Expiring Soon'}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-4 py-3 max-w-md">
          <Search className="w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by name, code, or category..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 text-sm outline-none"
          />
        </div>

        {/* Table */}
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th>Quantity</th>
                <th>Unit Price</th>
                <th>Expiry Date</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="text-center py-8">
                  <div className="spinner mx-auto" />
                  <p className="text-sm text-gray-500 mt-2">Loading inventory...</p>
                </td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-12">
                  <Package className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500">No items found</p>
                </td></tr>
              ) : (
                items.filter(item =>
                  !search ||
                  item.product_name.toLowerCase().includes(search.toLowerCase()) ||
                  item.product_code.toLowerCase().includes(search.toLowerCase()) ||
                  (item.category || '').toLowerCase().includes(search.toLowerCase())
                ).map((item) => {
                  const status = getStatus(item);
                  return (
                    <tr key={item.id}>
                      <td>
                        <div>
                          <div className="font-medium text-gray-900">{item.product_name}</div>
                          <div className="text-xs text-gray-500">{item.product_code}</div>
                        </div>
                      </td>
                      <td>{item.category || '-'}</td>
                      <td>
                        <span className={`font-semibold ${item.quantity <= item.reorder_level ? 'text-red-600' : ''}`}>
                          {item.quantity}
                        </span>
                      </td>
                      <td>GHS {Number(item.unit_price).toFixed(2)}</td>
                      <td className="text-sm">{new Date(item.expiry_date).toLocaleDateString()}</td>
                      <td><span className={status.class}>{status.label}</span></td>
                      <td>
                        <div className="flex gap-1">
                          <button className="p-2 rounded-lg hover:bg-gray-100 text-gray-500">
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button className="p-2 rounded-lg hover:bg-red-50 text-red-500">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardLayout>
  );
}

function Package(props: any) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m7.5 4.27 9 5.15" /><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" />
    </svg>
  );
}
