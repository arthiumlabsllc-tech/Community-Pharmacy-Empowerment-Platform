'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { PatientFormModal, type Patient } from '@/components/patients/patient-form-modal';
import { api } from '@/lib/api';
import {
  Search,
  Plus,
  Phone,
  User,
  FileText,
  ChevronRight,
  Pill,
} from 'lucide-react';

const COMMON_CONDITIONS = [
  'Hypertension',
  'Type 2 Diabetes',
  'Asthma',
  'Malaria',
  'Sickle Cell Disease',
  'Epilepsy',
  'HIV/AIDS',
  'Arthritis',
];

function getAge(dob: string | null) {
  if (!dob) return null;
  const age = Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  return Number.isFinite(age) && age >= 0 ? `${age} yrs` : null;
}

export default function PatientsPage() {
  const { isAuthenticated } = useAuthStore();
  const hydrated = useHydrated();
  const router = useRouter();

  const [patients, setPatients] = useState<Patient[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [condition, setCondition] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [formOpen, setFormOpen] = useState(false);

  const debouncedSearch = useDebouncedValue(search, 400);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  // The dashboard's "Add Patient" button links here with ?new=1.
  // Read from window.location rather than useSearchParams() so the page can
  // still be statically rendered without a Suspense boundary.
  useEffect(() => {
    if (hydrated && isAuthenticated && new URLSearchParams(window.location.search).get('new') === '1') {
      setFormOpen(true);
    }
  }, [hydrated, isAuthenticated]);

  const loadPatients = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (condition) params.set('condition', condition);

      const response = await api.get(`/patients?${params.toString()}`);
      setPatients(response.data || []);
      setTotal(response.pagination?.total || 0);
      setTotalPages(response.pagination?.totalPages || 1);
    } catch {
      toast.error('Failed to load patients');
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, condition]);

  useEffect(() => {
    if (hydrated && isAuthenticated) loadPatients();
  }, [hydrated, isAuthenticated, loadPatients]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, condition]);

  const closeForm = () => {
    setFormOpen(false);
    if (new URLSearchParams(window.location.search).get('new') === '1') router.replace('/patients');
  };

  if (!hydrated || !isAuthenticated) return null;

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Patients</h1>
            <p className="text-gray-500 mt-1">
              {total > 0 ? `${total.toLocaleString()} patient${total === 1 ? '' : 's'} on record` : 'Manage patient records and health data'}
            </p>
          </div>
          <button className="btn-primary btn-sm" onClick={() => setFormOpen(true)}>
            <Plus className="w-4 h-4" />
            Register Patient
          </button>
        </div>

        {/* Search & Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-4 py-2.5 flex-1 sm:max-w-md">
            <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
            <input
              type="text"
              placeholder="Search by name, NHIS number, or phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 text-sm outline-none bg-transparent"
            />
          </div>
          <select
            className="select sm:w-56"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
          >
            <option value="">All conditions</option>
            {COMMON_CONDITIONS.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
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
              <h3 className="text-lg font-semibold text-gray-600">
                {search || condition ? 'No patients match your filters' : 'No patients found'}
              </h3>
              <p className="text-gray-400 mt-1">
                {search || condition
                  ? 'Try a different name, NHIS number or condition.'
                  : 'Register your first patient to get started.'}
              </p>
              {!search && !condition && (
                <button className="btn-primary btn-sm mt-4" onClick={() => setFormOpen(true)}>
                  <Plus className="w-4 h-4" />
                  Register Patient
                </button>
              )}
            </div>
          ) : (
            patients.map((patient) => {
              const age = getAge(patient.date_of_birth);
              const allergies = patient.allergies || [];

              return (
                <button
                  key={patient.id}
                  type="button"
                  onClick={() => router.push(`/patients/${patient.id}`)}
                  className="card hover:shadow-md cursor-pointer transition-shadow group text-left w-full"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-11 h-11 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0">
                        <span className="text-primary-700 font-semibold">
                          {patient.first_name?.[0]}{patient.last_name?.[0]}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-semibold text-gray-900 group-hover:text-primary-600 transition-colors truncate">
                          {patient.first_name} {patient.last_name}
                        </h3>
                        <div className="flex items-center gap-2 text-xs text-gray-500">
                          {age && <span>{age}</span>}
                          {age && <span>•</span>}
                          <span className="capitalize">{patient.gender}</span>
                        </div>
                      </div>
                    </div>
                    <ChevronRight className="w-5 h-5 text-gray-300 group-hover:text-primary-500 flex-shrink-0" />
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

                  {allergies.length > 0 && (
                    <div className="mt-3 flex items-start gap-1.5 text-xs text-red-700 bg-red-50 rounded-lg px-2 py-1.5">
                      <Pill className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      <span className="truncate">Allergic to: {allergies.join(', ')}</span>
                    </div>
                  )}

                  {patient.chronic_conditions && patient.chronic_conditions.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {patient.chronic_conditions.map((item, i) => (
                        <span key={i} className="badge-info text-2xs capitalize">
                          {item}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2">
            <button
              className="btn-secondary btn-sm"
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1 || loading}
            >
              Previous
            </button>
            <span className="text-sm text-gray-600 px-3">
              Page {page} of {totalPages}
            </span>
            <button
              className="btn-secondary btn-sm"
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page === totalPages || loading}
            >
              Next
            </button>
          </div>
        )}
      </div>

      <PatientFormModal
        open={formOpen}
        onClose={closeForm}
        onSaved={(saved) => {
          closeForm();
          if (search || condition) {
            // Keep the current filter but make sure the new record is visible.
            loadPatients();
          } else {
            router.push(`/patients/${saved.id}`);
          }
        }}
      />
    </DashboardLayout>
  );
}
