'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { Calendar, Plus, Clock, Video, MessageSquare, User } from 'lucide-react';

export default function ConsultationsPage() {
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
            <h1 className="text-2xl font-bold text-gray-900">Consultations</h1>
            <p className="text-gray-500 mt-1">Schedule and manage patient consultations</p>
          </div>
          <button className="btn-primary btn-sm">
            <Plus className="w-4 h-4" />
            New Consultation
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
          {(['upcoming', 'completed', 'cancelled'] as const).map((tab) => (
            <button
              key={tab}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                tab === 'upcoming' ? 'bg-white shadow text-primary-700' : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Consultations List */}
        <div className="space-y-3">
          {[
            { id: 1, patient: 'Kofi Appiah', type: 'video', time: '10:00 AM', date: 'Today', reason: 'Diabetes follow-up' },
            { id: 2, patient: 'Akosua Darko', type: 'in_person', time: '11:30 AM', date: 'Today', reason: 'Asthma medication review' },
            { id: 3, patient: 'Efua Owusu', type: 'chat', time: '2:00 PM', date: 'Today', reason: 'Blood pressure check' },
            { id: 4, patient: 'Yaw Boateng', type: 'in_person', time: '9:00 AM', date: 'Tomorrow', reason: 'Malaria follow-up' },
          ].map((consult) => (
            <div key={consult.id} className="card flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-11 h-11 rounded-full bg-primary-50 flex items-center justify-center">
                  <User className="w-5 h-5 text-primary-600" />
                </div>
                <div>
                  <div className="font-semibold text-gray-900">{consult.patient}</div>
                  <div className="text-sm text-gray-500">{consult.reason}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <Clock className="w-3.5 h-3.5 text-gray-400" />
                    <span className="text-xs text-gray-500">{consult.date} at {consult.time}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {consult.type === 'video' && <Video className="w-5 h-5 text-blue-500" />}
                {consult.type === 'chat' && <MessageSquare className="w-5 h-5 text-purple-500" />}
                {consult.type === 'in_person' && <Calendar className="w-5 h-5 text-green-500" />}
                <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 capitalize">
                  {consult.type.replace('_', ' ')}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </DashboardLayout>
  );
}
