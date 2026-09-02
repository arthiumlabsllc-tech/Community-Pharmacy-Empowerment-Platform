'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { api } from '@/lib/api';
import {
  Search, Plus, Phone, User, Calendar,
  Heart, FileText, Activity, ChevronRight,
} from 'lucide-react';
import toast from 'react-hot-toast';

interface Patient {
  id: string;
  first_name: string;
  last_name: string;
  nhis_number: string | null;
  phone: string;
  gender: string;
  date_of_birth: string;
  chronic_conditions: string[];
  allergies: string[];
  created_at: string;
}

export default function PatientsPage() {
  const { isAuthenticated } = useAuthStore();
  const router = useRouter();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const loadPatients = async () => {
    setLoading(true);
    try {
      const response = await api.get(`/patients?page=${page}&limit=20&search=${search}`);
      setPatients(response.data);
      setTotalPages(response.pagination?.totalPages || 1);
    } catch (error) {
      toast.error('Failed to load patients');
    } finally {
      setLoading(false);
    }
  };

  const getAge = (dob: string) => {
    if (!dob) return 'N/A';
    const age = Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    return `${age} yrs`;
  };

  useEffect(() => {
    if (!isAuthenticated) router.replace('/login');
  }, [isAuthenticated, router]);

  useEffect(() => {
    loadPatients();
  }, [page, search]);

  if (!isAuthenticated) return null;

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Patients</h1>
            <p className="text-gray-500 mt-1">Manage patient records and health data</p>
          </div>
          <button className="btn-primary btn-sm">
            <Plus className="w-4 h-4" />
            Register Patient
          </button>
        </div>

        {/* Search & Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-4 py-3 flex-1 max-w-md">
            <Search className="w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by name, NHIS number, or phone..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="flex-1 text-sm outline-none"
            />
          </div>
        </div>

        {/* Patient Cards (mobile-friendly) */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {loading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="card animate-pulse">
                <div className="h-4 bg-gray-200 rounded w-3/4 mb-3" />
                <div className="h-3 bg-gray-100 rounded w-1/2 mb-2" />
                <div className="h-3 bg-gray-100 rounded w-2/3" />
              </div>
            ))
          ) : patients.length === 0 ? (
            <div className="col-span-full empty-state">
              <User className="w-16 h-16 text-gray-300 mb-4" />
              <h3 className="text-lg font-semibold text-gray-600">No patients found</h3>
              <p className="text-gray-400 mt-1">Register your first patient to get started</p>
            </div>
          ) : (
            patients.map((patient) => (
              <div key={patient.id} className="card hover:shadow-md cursor-pointer transition-shadow group">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-full bg-primary-50 flex items-center justify-center">
                      <span className="text-primary-700 font-semibold">
                        {patient.first_name[0]}{patient.last_name[0]}
                      </span>
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 group-hover:text-primary-600 transition-colors">
                        {patient.first_name} {patient.last_name}
                      </h3>
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        <span>{getAge(patient.date_of_birth)}</span>
                        <span>•</span>
                        <span className="capitalize">{patient.gender}</span>
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="w-5 h-5 text-gray-300 group-hover:text-primary-500" />
                </div>

                <div className="mt-3 space-y-1.5">
                  {patient.nhis_number && (
                    <div className="flex items-center gap-2 text-xs text-gray-600">
                      <FileText className="w-3.5 h-3.5 text-gray-400" />
                      <span>NHIS: {patient.nhis_number}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-xs text-gray-600">
                    <Phone className="w-3.5 h-3.5 text-gray-400" />
                    <span>{patient.phone}</span>
                  </div>
                </div>

                {patient.chronic_conditions && patient.chronic_conditions.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {patient.chronic_conditions.map((condition, i) => (
                      <span key={i} className="badge-info text-2xs capitalize">
                        {condition}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2">
            <button
              className="btn-secondary btn-sm"
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1}
            >
              Previous
            </button>
            <span className="text-sm text-gray-600 px-3">
              Page {page} of {totalPages}
            </span>
            <button
              className="btn-secondary btn-sm"
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page === totalPages}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
