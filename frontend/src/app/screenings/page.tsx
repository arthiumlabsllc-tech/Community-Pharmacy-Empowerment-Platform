'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { Activity, Plus, AlertTriangle, User, TrendingUp } from 'lucide-react';

export default function ScreeningsPage() {
  const { isAuthenticated } = useAuthStore();
  const hydrated = useHydrated();
  const router = useRouter();

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  if (!hydrated || !isAuthenticated) return null;

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Health Screenings</h1>
            <p className="text-gray-500 mt-1">Record and monitor patient health vitals</p>
          </div>
          <button className="btn-primary btn-sm">
            <Plus className="w-4 h-4" />
            Record Screening
          </button>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="card text-center">
            <Activity className="w-8 h-8 text-primary-500 mx-auto mb-2" />
            <div className="text-2xl font-bold">248</div>
            <div className="text-xs text-gray-500 mt-1">Total Screenings</div>
          </div>
          <div className="card text-center">
            <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
            <div className="text-2xl font-bold text-red-700">12</div>
            <div className="text-xs text-gray-500 mt-1">High Risk</div>
          </div>
          <div className="card text-center">
            <TrendingUp className="w-8 h-8 text-blue-500 mx-auto mb-2" />
            <div className="text-2xl font-bold text-blue-700">35</div>
            <div className="text-xs text-gray-500 mt-1">This Week</div>
          </div>
          <div className="card text-center">
            <User className="w-8 h-8 text-purple-500 mx-auto mb-2" />
            <div className="text-2xl font-bold text-purple-700">8</div>
            <div className="text-xs text-gray-500 mt-1">Referred to Clinic</div>
          </div>
        </div>

        {/* Recent Screenings */}
        <h2 className="text-lg font-semibold">Recent Screenings</h2>
        <div className="space-y-3">
          {[
            { patient: 'Kofi Appiah', type: 'Blood Pressure', value: '145/92', risk: 'high', date: 'Today, 9:30 AM' },
            { patient: 'Akosua Darko', type: 'Blood Sugar', value: '6.8 mmol/L', risk: 'moderate', date: 'Today, 10:15 AM' },
            { patient: 'Efua Owusu', type: 'BMI', value: '28.5', risk: 'moderate', date: 'Yesterday' },
            { patient: 'Yaw Boateng', type: 'Blood Pressure', value: '120/80', risk: 'low', date: 'Yesterday' },
            { patient: 'Kwesi Adu', type: 'Temperature', value: '37.2°C', risk: 'low', date: '2 days ago' },
          ].map((screening, i) => (
            <div key={i} className="card flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                  screening.risk === 'high' ? 'bg-red-50' :
                  screening.risk === 'moderate' ? 'bg-yellow-50' : 'bg-green-50'
                }`}>
                  <Activity className={`w-5 h-5 ${
                    screening.risk === 'high' ? 'text-red-500' :
                    screening.risk === 'moderate' ? 'text-yellow-500' : 'text-green-500'
                  }`} />
                </div>
                <div>
                  <div className="font-semibold text-gray-900">{screening.patient}</div>
                  <div className="text-sm text-gray-500">{screening.type}</div>
                </div>
              </div>
              <div className="text-right">
                <div className="font-semibold">{screening.value}</div>
                <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${
                  screening.risk === 'high' ? 'bg-red-100 text-red-700' :
                  screening.risk === 'moderate' ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'
                }`}>
                  {screening.risk}
                </span>
                <div className="text-xs text-gray-400 mt-1">{screening.date}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </DashboardLayout>
  );
}
