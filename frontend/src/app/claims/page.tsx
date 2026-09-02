'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { FileText, Search, Plus, Clock, CheckCircle, XCircle, DollarSign } from 'lucide-react';

export default function ClaimsPage() {
  const { isAuthenticated, _hasHydrated } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    if (_hasHydrated && !isAuthenticated) router.replace('/login');
  }, [isAuthenticated, _hasHydrated, router]);

  if (!_hasHydrated || !isAuthenticated) return null;

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">NHIS Claims</h1>
            <p className="text-gray-500 mt-1">Submit and track National Health Insurance claims</p>
          </div>
          <button className="btn-primary btn-sm">
            <Plus className="w-4 h-4" />
            New Claim
          </button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="card text-center">
            <Clock className="w-8 h-8 text-blue-500 mx-auto mb-2" />
            <div className="text-2xl font-bold text-blue-700">15</div>
            <div className="text-xs text-gray-500 mt-1">Pending</div>
          </div>
          <div className="card text-center">
            <CheckCircle className="w-8 h-8 text-green-500 mx-auto mb-2" />
            <div className="text-2xl font-bold text-green-700">142</div>
            <div className="text-xs text-gray-500 mt-1">Approved</div>
          </div>
          <div className="card text-center">
            <XCircle className="w-8 h-8 text-red-500 mx-auto mb-2" />
            <div className="text-2xl font-bold text-red-700">3</div>
            <div className="text-xs text-gray-500 mt-1">Rejected</div>
          </div>
          <div className="card text-center">
            <DollarSign className="w-8 h-8 text-yellow-500 mx-auto mb-2" />
            <div className="text-2xl font-bold text-yellow-700">GHS 8.2K</div>
            <div className="text-xs text-gray-500 mt-1">Awaiting Payment</div>
          </div>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-4 py-3 max-w-md">
          <Search className="w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by claim number, patient name..."
            className="flex-1 text-sm outline-none"
          />
        </div>

        {/* Claims List */}
        <div className="space-y-3">
          {[
            { id: 'CLM-2024-0156', patient: 'Kofi Appiah', amount: 125.00, status: 'approved', date: '2024-12-15' },
            { id: 'CLM-2024-0155', patient: 'Akosua Darko', amount: 85.50, status: 'pending', date: '2024-12-14' },
            { id: 'CLM-2024-0154', patient: 'Yaw Boateng', amount: 200.00, status: 'approved', date: '2024-12-13' },
            { id: 'CLM-2024-0153', patient: 'Efua Owusu', amount: 45.00, status: 'rejected', date: '2024-12-12' },
          ].map((claim) => (
            <div key={claim.id} className="card flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                  claim.status === 'approved' ? 'bg-green-50' :
                  claim.status === 'pending' ? 'bg-blue-50' : 'bg-red-50'
                }`}>
                  <FileText className={`w-5 h-5 ${
                    claim.status === 'approved' ? 'text-green-500' :
                    claim.status === 'pending' ? 'text-blue-500' : 'text-red-500'
                  }`} />
                </div>
                <div>
                  <div className="font-semibold text-gray-900">{claim.id}</div>
                  <div className="text-sm text-gray-500">{claim.patient}</div>
                </div>
              </div>
              <div className="text-right">
                <div className="font-semibold">GHS {claim.amount.toFixed(2)}</div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  claim.status === 'approved' ? 'bg-green-100 text-green-700' :
                  claim.status === 'pending' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'
                }`}>
                  {claim.status.charAt(0).toUpperCase() + claim.status.slice(1)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </DashboardLayout>
  );
}
