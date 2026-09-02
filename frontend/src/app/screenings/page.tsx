'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { Modal } from '@/components/ui/modal';
import { PatientSelect, PatientOption } from '@/components/ui/patient-select';
import { api } from '@/lib/api';
import {
  Activity, Plus, AlertTriangle, User, TrendingUp, Search, Loader2, Stethoscope,
} from 'lucide-react';
import toast from 'react-hot-toast';

interface Screening {
  id: string;
  patient_id: string;
  patient_name: string;
  type: string;
  systolic: number | null;
  diastolic: number | null;
  value: string;
  unit: string;
  risk_level: string;
  notes: string | null;
  referred_to_clinic: boolean;
  referral_clinic: string | null;
  recorded_by_name: string;
  recorded_at: string;
}

interface Summary {
  total: number;
  this_week: number;
  referred_to_clinic: number;
  high_risk: number;
  by_risk: Record<string, number>;
}

const SCREENING_TYPES = [
  { key: 'blood_pressure', label: 'Blood Pressure', unit: 'mmHg' },
  { key: 'blood_sugar', label: 'Blood Sugar', unit: 'mmol/L' },
  { key: 'bmi', label: 'BMI', unit: 'kg/m²' },
  { key: 'weight', label: 'Weight', unit: 'kg' },
  { key: 'temperature', label: 'Temperature', unit: '°C' },
  { key: 'heart_rate', label: 'Heart Rate', unit: 'bpm' },
];

const riskBadge = (risk: string) => {
  switch (risk) {
    case 'critical':
    case 'high':
      return 'badge-danger';
    case 'moderate':
      return 'badge-warning';
    default:
      return 'badge-success';
  }
};

const formatValue = (s: Screening) =>
  s.type === 'blood_pressure' && s.systolic && s.diastolic
    ? `${s.systolic}/${s.diastolic}`
    : `${Number(s.value)} ${s.unit}`;

const typeLabel = (key: string) =>
  SCREENING_TYPES.find((t) => t.key === key)?.label || key;

export default function ScreeningsPage() {
  const { isAuthenticated } = useAuthStore();
  const hydrated = useHydrated();
  const router = useRouter();

  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [riskFilter, setRiskFilter] = useState('');
  const [showModal, setShowModal] = useState(false);

  const debouncedSearch = useDebouncedValue(search, 400);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '25' });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (riskFilter) params.set('risk_level', riskFilter);

      const [listResponse, summaryResponse] = await Promise.all([
        api.get(`/screenings?${params.toString()}`),
        api.get('/screenings/summary'),
      ]);
      setScreenings(listResponse.data || []);
      setSummary(summaryResponse.data);
    } catch {
      toast.error('Failed to load screenings');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, riskFilter]);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  useEffect(() => {
    if (hydrated && isAuthenticated) load();
  }, [hydrated, isAuthenticated, load]);

  if (!hydrated || !isAuthenticated) return null;

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Health Screenings</h1>
            <p className="text-gray-500 mt-1">Record and monitor patient health vitals</p>
          </div>
          <button className="btn-primary btn-sm" onClick={() => setShowModal(true)}>
            <Plus className="w-4 h-4" />
            Record Screening
          </button>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="card text-center">
            <Activity className="w-8 h-8 text-primary-500 mx-auto mb-2" />
            <div className="text-2xl font-bold">{summary?.total ?? '—'}</div>
            <div className="text-xs text-gray-500 mt-1">Total Screenings</div>
          </div>
          <div className="card text-center">
            <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
            <div className="text-2xl font-bold text-red-700">{summary?.high_risk ?? '—'}</div>
            <div className="text-xs text-gray-500 mt-1">High or Critical Risk</div>
          </div>
          <div className="card text-center">
            <TrendingUp className="w-8 h-8 text-blue-500 mx-auto mb-2" />
            <div className="text-2xl font-bold text-blue-700">{summary?.this_week ?? '—'}</div>
            <div className="text-xs text-gray-500 mt-1">This Week</div>
          </div>
          <div className="card text-center">
            <User className="w-8 h-8 text-purple-500 mx-auto mb-2" />
            <div className="text-2xl font-bold text-purple-700">{summary?.referred_to_clinic ?? '—'}</div>
            <div className="text-xs text-gray-500 mt-1">Referred to Clinic</div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-4 py-3 flex-1 max-w-md">
            <Search className="w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by patient name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 text-sm outline-none"
            />
          </div>
          <select
            className="select sm:w-56"
            value={riskFilter}
            onChange={(e) => setRiskFilter(e.target.value)}
          >
            <option value="">All risk levels</option>
            <option value="low">Low risk</option>
            <option value="moderate">Moderate risk</option>
            <option value="high">High risk</option>
            <option value="critical">Critical risk</option>
          </select>
        </div>

        {/* Screenings */}
        <h2 className="text-lg font-semibold">Screenings</h2>
        <div className="space-y-3">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="card animate-pulse">
                <div className="h-4 bg-gray-200 rounded w-1/3 mb-3" />
                <div className="h-3 bg-gray-100 rounded w-1/4" />
              </div>
            ))
          ) : screenings.length === 0 ? (
            <div className="card empty-state">
              <Stethoscope className="w-16 h-16 text-gray-300 mb-4" />
              <h3 className="text-lg font-semibold text-gray-600">No screenings recorded</h3>
              <p className="text-gray-400 mt-1">Record a patient&apos;s vitals to start tracking their health</p>
            </div>
          ) : (
            screenings.map((screening) => (
              <div key={screening.id} className="card flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex items-center gap-4 min-w-0">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                    screening.risk_level === 'critical' || screening.risk_level === 'high' ? 'bg-red-50' :
                    screening.risk_level === 'moderate' ? 'bg-yellow-50' : 'bg-green-50'
                  }`}>
                    <Activity className={`w-5 h-5 ${
                      screening.risk_level === 'critical' || screening.risk_level === 'high' ? 'text-red-500' :
                      screening.risk_level === 'moderate' ? 'text-yellow-500' : 'text-green-500'
                    }`} />
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold text-gray-900 truncate">{screening.patient_name}</div>
                    <div className="text-sm text-gray-500">{typeLabel(screening.type)}</div>
                    {screening.referred_to_clinic && (
                      <div className="text-xs text-purple-600 mt-0.5">
                        Referred{screening.referral_clinic ? ` to ${screening.referral_clinic}` : ''}
                      </div>
                    )}
                  </div>
                </div>
                <div className="text-right sm:flex-shrink-0">
                  <div className="font-semibold">{formatValue(screening)}</div>
                  <span className={`${riskBadge(screening.risk_level)} capitalize`}>
                    {screening.risk_level}
                  </span>
                  <div className="text-xs text-gray-400 mt-1">
                    {new Date(screening.recorded_at).toLocaleString()} · {screening.recorded_by_name}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <RecordScreeningModal
        open={showModal}
        onClose={() => setShowModal(false)}
        onSaved={() => { setShowModal(false); load(); }}
      />
    </DashboardLayout>
  );
}

// ============ RECORD SCREENING MODAL ============
function RecordScreeningModal({
  open, onClose, onSaved,
}: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [type, setType] = useState('blood_pressure');
  const [systolic, setSystolic] = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [value, setValue] = useState('');
  const [notes, setNotes] = useState('');
  const [referred, setReferred] = useState(false);
  const [referralClinic, setReferralClinic] = useState('');
  const [saving, setSaving] = useState(false);

  const selectedType = SCREENING_TYPES.find((t) => t.key === type);
  const isBloodPressure = type === 'blood_pressure';

  const reset = () => {
    setPatient(null);
    setType('blood_pressure');
    setSystolic('');
    setDiastolic('');
    setValue('');
    setNotes('');
    setReferred(false);
    setReferralClinic('');
  };

  const save = async () => {
    if (!patient) return toast.error('Select a patient');

    const numericValue = isBloodPressure ? Number(systolic) : Number(value);
    if (!numericValue || numericValue <= 0) {
      return toast.error(isBloodPressure ? 'Enter a valid systolic reading' : 'Enter a valid reading');
    }
    if (isBloodPressure && (!Number(diastolic) || Number(diastolic) <= 0)) {
      return toast.error('Enter a valid diastolic reading');
    }

    setSaving(true);
    try {
      await api.post('/screenings', {
        patient_id: patient.id,
        type,
        systolic: isBloodPressure ? Number(systolic) : undefined,
        diastolic: isBloodPressure ? Number(diastolic) : undefined,
        value: numericValue,
        unit: selectedType?.unit || '',
        notes: notes || undefined,
        referred_to_clinic: referred,
        referral_clinic: referred ? referralClinic || undefined : undefined,
      });
      toast.success('Screening recorded');
      reset();
      onSaved();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to record screening');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Record Health Screening"
      description="Risk level is calculated automatically from the reading"
      footer={
        <>
          <button className="btn-secondary btn-sm" onClick={() => { reset(); onClose(); }} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
            Save Screening
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <PatientSelect value={patient} onChange={setPatient} />

        <div>
          <label className="label">Screening type</label>
          <select
            className="select"
            value={type}
            onChange={(e) => { setType(e.target.value); setValue(''); setSystolic(''); setDiastolic(''); }}
          >
            {SCREENING_TYPES.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
        </div>

        {isBloodPressure ? (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Systolic (mmHg)</label>
              <input
                className="input"
                type="number"
                min={1}
                placeholder="120"
                value={systolic}
                onChange={(e) => setSystolic(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Diastolic (mmHg)</label>
              <input
                className="input"
                type="number"
                min={1}
                placeholder="80"
                value={diastolic}
                onChange={(e) => setDiastolic(e.target.value)}
              />
            </div>
          </div>
        ) : (
          <div>
            <label className="label">Reading ({selectedType?.unit})</label>
            <input
              className="input"
              type="number"
              step="0.1"
              min={0}
              placeholder={`Value in ${selectedType?.unit}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
        )}

        <div>
          <label className="label">Notes</label>
          <textarea
            className="input"
            rows={2}
            placeholder="Optional clinical notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <label className="flex items-center justify-between p-3 rounded-lg bg-gray-50 cursor-pointer">
          <span className="text-sm text-gray-700">Refer patient to a clinic</span>
          <input
            type="checkbox"
            className="w-5 h-5 rounded text-primary-500"
            checked={referred}
            onChange={(e) => setReferred(e.target.checked)}
          />
        </label>

        {referred && (
          <div>
            <label className="label">Referral clinic</label>
            <input
              className="input"
              placeholder="e.g. Osu Government Clinic"
              value={referralClinic}
              onChange={(e) => setReferralClinic(e.target.value)}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
