'use client';

import { useAuthStore } from '@/store/auth-store';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { StatCard } from '@/components/ui/stat-card';
import {
  Package, Users, FileText, TrendingUp,
  AlertTriangle, Clock, DollarSign, Activity,
} from 'lucide-react';

export default function DashboardPage() {
  const { user, pharmacy } = useAuthStore();

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
          <div className="flex gap-3">
            <button className="btn-primary btn-sm">
              <Package className="w-4 h-4" />
              New Sale
            </button>
            <button className="btn-secondary btn-sm">
              <Users className="w-4 h-4" />
              Add Patient
            </button>
          </div>
        </div>

        {/* KPI Stats Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            icon={<DollarSign className="w-5 h-5" />}
            label="Today&apos;s Revenue"
            value="GHS 2,450"
            change="+12%"
            changeType="positive"
            color="primary"
          />
          <StatCard
            icon={<FileText className="w-5 h-5" />}
            label="Prescriptions Filled"
            value="28"
            change="+5 today"
            changeType="positive"
            color="blue"
          />
          <StatCard
            icon={<Users className="w-5 h-5" />}
            label="Total Patients"
            value="1,247"
            change="+15 this week"
            changeType="positive"
            color="purple"
          />
          <StatCard
            icon={<AlertTriangle className="w-5 h-5" />}
            label="Low Stock Items"
            value="7"
            change="2 expiring soon"
            changeType="negative"
            color="yellow"
          />
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* NHIS Claims Summary */}
          <div className="lg:col-span-2 card">
            <div className="card-header">
              <h2 className="text-lg font-semibold">NHIS Claims</h2>
              <button className="btn-ghost btn-sm">View All</button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="text-center p-3 bg-blue-50 rounded-xl">
                <div className="text-2xl font-bold text-blue-700">15</div>
                <div className="text-xs text-blue-600 mt-1">Pending</div>
              </div>
              <div className="text-center p-3 bg-green-50 rounded-xl">
                <div className="text-2xl font-bold text-green-700">142</div>
                <div className="text-xs text-green-600 mt-1">Approved</div>
              </div>
              <div className="text-center p-3 bg-red-50 rounded-xl">
                <div className="text-2xl font-bold text-red-700">3</div>
                <div className="text-xs text-red-600 mt-1">Rejected</div>
              </div>
              <div className="text-center p-3 bg-yellow-50 rounded-xl">
                <div className="text-2xl font-bold text-yellow-700">GHS 8.2K</div>
                <div className="text-xs text-yellow-600 mt-1">Awaiting Payment</div>
              </div>
            </div>
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
                    strokeDasharray={`${72 * 2.64} ${264 - 72 * 2.64}`}
                    transform="rotate(-90 50 50)"
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-3xl font-bold text-primary-600">72</span>
                  <span className="text-xs text-gray-500">out of 100</span>
                </div>
              </div>
              <div className="mt-3">
                <span className="badge-success">Good</span>
              </div>
              <p className="text-xs text-gray-500 mt-2 text-center">
                Based on claims approval, inventory health, and patient engagement
              </p>
            </div>
          </div>
        </div>

        {/* Alerts & Quick Actions */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Expiring / Low Stock Alerts */}
          <div className="card">
            <div className="card-header">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Clock className="w-5 h-5 text-yellow-500" />
                Alerts
              </h2>
            </div>
            <div className="space-y-3">
              {[
                { text: 'Insulin Pen (NovoRapid) — Low stock (5 left)', type: 'danger' },
                { text: 'Cough Syrup (100ml) — Low stock (8 left)', type: 'warning' },
                { text: 'Chloroquine Tablets — Expiring in 30 days', type: 'warning' },
                { text: 'Blood Glucose Strips — Reorder needed', type: 'info' },
              ].map((alert, i) => (
                <div key={i} className={`flex items-start gap-3 p-3 rounded-lg ${
                  alert.type === 'danger' ? 'bg-red-50' :
                  alert.type === 'warning' ? 'bg-yellow-50' : 'bg-blue-50'
                }`}>
                  <AlertTriangle className={`w-4 h-4 mt-0.5 ${
                    alert.type === 'danger' ? 'text-red-500' :
                    alert.type === 'warning' ? 'text-yellow-500' : 'text-blue-500'
                  }`} />
                  <span className="text-sm text-gray-700">{alert.text}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Activity */}
          <div className="card">
            <div className="card-header">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Activity className="w-5 h-5 text-primary-500" />
                Recent Activity
              </h2>
            </div>
            <div className="space-y-4">
              {[
                { action: 'Prescription filled for Kofi Appiah', time: '10 min ago', icon: '💊' },
                { action: 'NHIS claim #CLM-2024-0156 approved', time: '1 hour ago', icon: '✅' },
                { action: 'New patient registered: Efua Owusu', time: '2 hours ago', icon: '👤' },
                { action: 'Stock received: Paracetamol 500mg (200 units)', time: '3 hours ago', icon: '📦' },
                { action: 'Blood pressure screening for Akosua Darko', time: '5 hours ago', icon: '🩺' },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-lg">{item.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-700 truncate">{item.action}</p>
                    <p className="text-xs text-gray-400">{item.time}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
