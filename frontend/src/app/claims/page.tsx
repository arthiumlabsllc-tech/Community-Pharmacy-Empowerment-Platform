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
  FileText, Search, Plus, Clock, CheckCircle, XCircle, DollarSign,
  Trash2, ShieldCheck, Loader2, ChevronRight, AlertTriangle,
} from 'lucide-react';
import toast from 'react-hot-toast';

interface Claim {
  id: string;
  claim_number: string;
  patient_id: string;
  patient_name: string;
  nhis_number: string | null;
  diagnosis_codes: string[];
  medication_details: Medication[];
  total_amount: string;
  nhis_approved_amount: string | null;
  patient_copay: string;
  status: string;
  rejection_reason: string | null;
  submitted_at: string | null;
  created_at: string;
}

interface Medication {
  name: string;
  quantity: number;
  unit_price: number;
}

interface SummaryRow {
  status: string;
  count: string;
  amount: string;
}

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'paid', label: 'Paid' },
];

const statusBadge = (status: string) => {
  switch (status) {
    case 'approved':
    case 'paid':
      return 'badge-success';
    case 'rejected':
      return 'badge-danger';
    case 'draft':
      return 'badge-neutral';
    default:
      return 'badge-info';
  }
};

export default function ClaimsPage() {
  const { isAuthenticated } = useAuthStore();
  const hydrated = useHydrated();
  const router = useRouter();

  const [claims, setClaims] = useState<Claim[]>([]);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [showNewModal, setShowNewModal] = useState(false);
  const [selectedClaim, setSelectedClaim] = useState<Claim | null>(null);

  const debouncedSearch = useDebouncedValue(search, 400);

  const loadClaims = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (status) params.set('status', status);

      const response = await api.get(`/nhis/claims?${params.toString()}`);
      setClaims(response.data || []);
      setSummary(response.summary || []);
      setTotalPages(response.pagination?.totalPages || 1);
    } catch {
      toast.error('Failed to load claims');
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, status]);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  useEffect(() => {
    if (hydrated && isAuthenticated) loadClaims();
  }, [hydrated, isAuthenticated, loadClaims]);

  useEffect(() => { setPage(1); }, [debouncedSearch, status]);

  if (!hydrated || !isAuthenticated) return null;

  const countFor = (...statuses: string[]) =>
    summary.filter((s) => statuses.includes(s.status)).reduce((sum, s) => sum + Number(s.count), 0);

  const awaitingPayment = summary
    .filter((s) => s.status === 'approved')
    .reduce((sum, s) => sum + Number(s.amount), 0);

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">NHIS Claims</h1>
            <p className="text-gray-500 mt-1">Submit and track National Health Insurance claims</p>
          </div>
          <button className="btn-primary btn-sm" onClick={() => setShowNewModal(true)}>
            <Plus className="w-4 h-4" />
            New Claim
          </button>
        </div>

        {/* ClaimsIT is not integrated, so claims never leave this database.
            Staff must not assume a claim recorded here has reached NHIA. */}
        <ClaimsIntegrationNotice />

        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="card text-center">
            <Clock className="w-8 h-8 text-blue-500 mx-auto mb-2" />
            <div className="text-2xl font-bold text-blue-700">
              {countFor('draft', 'pending', 'submitted', 'resubmitted')}
            </div>
            <div className="text-xs text-gray-500 mt-1">Awaiting Decision</div>
          </div>
          <div className="card text-center">
            <CheckCircle className="w-8 h-8 text-green-500 mx-auto mb-2" />
            <div className="text-2xl font-bold text-green-700">{countFor('approved', 'paid')}</div>
            <div className="text-xs text-gray-500 mt-1">Approved</div>
          </div>
          <div className="card text-center">
            <XCircle className="w-8 h-8 text-red-500 mx-auto mb-2" />
            <div className="text-2xl font-bold text-red-700">{countFor('rejected')}</div>
            <div className="text-xs text-gray-500 mt-1">Rejected</div>
          </div>
          <div className="card text-center">
            <DollarSign className="w-8 h-8 text-yellow-500 mx-auto mb-2" />
            <div className="text-2xl font-bold text-yellow-700">
              GHS {awaitingPayment.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </div>
            <div className="text-xs text-gray-500 mt-1">Awaiting Payment</div>
          </div>
        </div>

        {/* Status tabs */}
        <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit overflow-x-auto">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setStatus(tab.key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                status === tab.key ? 'bg-white shadow text-primary-700' : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-4 py-3 max-w-md">
          <Search className="w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by claim number, patient name or NHIS number..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 text-sm outline-none"
          />
        </div>

        {/* Claims List */}
        <div className="space-y-3">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="card animate-pulse">
                <div className="h-4 bg-gray-200 rounded w-1/3 mb-3" />
                <div className="h-3 bg-gray-100 rounded w-1/4" />
              </div>
            ))
          ) : claims.length === 0 ? (
            <div className="card empty-state">
              <FileText className="w-16 h-16 text-gray-300 mb-4" />
              <h3 className="text-lg font-semibold text-gray-600">No claims found</h3>
              <p className="text-gray-400 mt-1">Submit a claim to get started</p>
            </div>
          ) : (
            claims.map((claim) => (
              <button
                key={claim.id}
                onClick={() => setSelectedClaim(claim)}
                className="card w-full flex items-center justify-between text-left gap-4"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                    claim.status === 'approved' || claim.status === 'paid' ? 'bg-green-50' :
                    claim.status === 'rejected' ? 'bg-red-50' : 'bg-blue-50'
                  }`}>
                    <FileText className={`w-5 h-5 ${
                      claim.status === 'approved' || claim.status === 'paid' ? 'text-green-500' :
                      claim.status === 'rejected' ? 'text-red-500' : 'text-blue-500'
                    }`} />
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold text-gray-900 truncate">{claim.claim_number}</div>
                    <div className="text-sm text-gray-500 truncate">{claim.patient_name}</div>
                  </div>
                </div>
                <div className="text-right flex items-center gap-3 flex-shrink-0">
                  <div>
                    <div className="font-semibold">GHS {Number(claim.total_amount).toFixed(2)}</div>
                    <span className={statusBadge(claim.status)}>{claim.status}</span>
                  </div>
                  <ChevronRight className="w-5 h-5 text-gray-300" />
                </div>
              </button>
            ))
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2">
            <button className="btn-secondary btn-sm" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}>
              Previous
            </button>
            <span className="text-sm text-gray-600 px-3">Page {page} of {totalPages}</span>
            <button className="btn-secondary btn-sm" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages}>
              Next
            </button>
          </div>
        )}
      </div>

      <NewClaimModal
        open={showNewModal}
        onClose={() => setShowNewModal(false)}
        onCreated={() => { setShowNewModal(false); loadClaims(); }}
      />

      <ClaimDetailModal
        claim={selectedClaim}
        onClose={() => setSelectedClaim(null)}
        onUpdated={() => { setSelectedClaim(null); loadClaims(); }}
      />
    </DashboardLayout>
  );
}

// ============ CLAIMS INTEGRATION NOTICE ============
const NOTICE_DISMISSED_KEY = 'nhis-claimsit-notice-dismissed';

/**
 * Persistent reminder that claims are recorded locally only. Dismissible per
 * browser session so it is visible again on the next sign-in.
 */
function ClaimsIntegrationNotice() {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(window.sessionStorage.getItem(NOTICE_DISMISSED_KEY) === '1');
  }, []);

  if (dismissed) return null;

  const dismiss = () => {
    window.sessionStorage.setItem(NOTICE_DISMISSED_KEY, '1');
    setDismissed(true);
  };

  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200">
      <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-amber-900">NHIA ClaimsIT is not connected</p>
        <p className="text-xs text-amber-800 mt-0.5">
          Claims you create here are saved to this platform only. They are not transmitted to NHIA,
          and eligibility checks are simulated. Submit claims through your normal NHIA channel until
          the direct integration is live.
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss notice for this session"
        className="p-1.5 rounded-lg hover:bg-amber-100 text-amber-600 flex-shrink-0"
      >
        <XCircle className="w-4 h-4" />
      </button>
    </div>
  );
}

// ============ NEW CLAIM MODAL ============
function NewClaimModal({
  open, onClose, onCreated,
}: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [diagnosisInput, setDiagnosisInput] = useState('');
  const [medications, setMedications] = useState<Medication[]>([{ name: '', quantity: 1, unit_price: 0 }]);
  const [copay, setCopay] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [eligibility, setEligibility] = useState<any>(null);
  const [checkingEligibility, setCheckingEligibility] = useState(false);

  const reset = () => {
    setPatient(null);
    setDiagnosisInput('');
    setMedications([{ name: '', quantity: 1, unit_price: 0 }]);
    setCopay(0);
    setEligibility(null);
  };

  const total = medications.reduce((sum, m) => sum + Number(m.quantity) * Number(m.unit_price), 0);
  const diagnosisCodes = diagnosisInput
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  const checkEligibility = async () => {
    if (!patient?.nhis_number) {
      toast.error('This patient has no NHIS number on record');
      return;
    }
    setCheckingEligibility(true);
    try {
      const response = await api.post('/nhis/check-eligibility', { nhis_number: patient.nhis_number });
      setEligibility(response.data);
    } catch {
      toast.error('Eligibility check failed');
    } finally {
      setCheckingEligibility(false);
    }
  };

  const submit = async () => {
    if (!patient) return toast.error('Select a patient');
    if (diagnosisCodes.length === 0) return toast.error('Add at least one diagnosis code');
    if (medications.some((m) => !m.name.trim())) return toast.error('Every medication needs a name');
    if (total <= 0) return toast.error('Claim total must be greater than zero');

    setSubmitting(true);
    try {
      await api.post('/nhis/submit-claim', {
        patient_id: patient.id,
        diagnosis_codes: diagnosisCodes,
        medications,
        total_amount: total,
        patient_copay: copay,
      });
      toast.success('Claim recorded — not yet transmitted to NHIA', { duration: 6000 });
      reset();
      onCreated();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to submit claim');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="New NHIS Claim"
      description="Verify eligibility, then submit the claim for reimbursement"
      size="lg"
      footer={
        <>
          <button className="btn-secondary btn-sm" onClick={() => { reset(); onClose(); }} disabled={submitting}>
            Cancel
          </button>
          <button className="btn-primary btn-sm" onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Submit Claim
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <PatientSelect value={patient} onChange={(p) => { setPatient(p); setEligibility(null); }} />

        {patient?.nhis_number && (
          <div className="space-y-2">
            <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
              <button type="button" className="btn-secondary btn-sm" onClick={checkEligibility} disabled={checkingEligibility}>
                {checkingEligibility ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                Check NHIS Eligibility
              </button>
              {eligibility && (
                <span className={eligibility.eligible ? 'badge-success' : 'badge-danger'}>
                  {eligibility.eligible
                    ? `Eligible · ${eligibility.scheme_type} · expires ${eligibility.expiry_date}`
                    : 'Not eligible'}
                </span>
              )}
            </div>

            {/* The NHIA ClaimsIT lookup is not connected, so the result above is a
                local simulation. Say so next to it rather than letting staff treat
                it as a confirmed eligibility check. */}
            {eligibility && eligibility.verified === false && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200">
                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800">
                  {eligibility.note ||
                    'NHIA ClaimsIT is not connected yet — this result is simulated. Verify the member\u2019s card before dispensing.'}
                </p>
              </div>
            )}
          </div>
        )}

        <div>
          <label className="label">Diagnosis codes (comma separated)</label>
          <input
            className="input"
            placeholder="e.g. I10, E11.9"
            value={diagnosisInput}
            onChange={(e) => setDiagnosisInput(e.target.value)}
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label mb-0">Medications</label>
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => setMedications([...medications, { name: '', quantity: 1, unit_price: 0 }])}
            >
              <Plus className="w-4 h-4" /> Add line
            </button>
          </div>
          <div className="space-y-2">
            {medications.map((med, i) => (
              <div key={i} className="flex gap-2 items-start">
                <input
                  className="input flex-1"
                  placeholder="Medication name"
                  value={med.name}
                  onChange={(e) => {
                    const next = [...medications];
                    next[i] = { ...next[i], name: e.target.value };
                    setMedications(next);
                  }}
                />
                <input
                  className="input w-24"
                  type="number"
                  min={1}
                  placeholder="Qty"
                  value={med.quantity}
                  onChange={(e) => {
                    const next = [...medications];
                    next[i] = { ...next[i], quantity: Number(e.target.value) };
                    setMedications(next);
                  }}
                />
                <input
                  className="input w-28"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="Unit price"
                  value={med.unit_price}
                  onChange={(e) => {
                    const next = [...medications];
                    next[i] = { ...next[i], unit_price: Number(e.target.value) };
                    setMedications(next);
                  }}
                />
                <button
                  type="button"
                  className="p-3 rounded-lg hover:bg-red-50 text-red-500"
                  aria-label="Remove medication line"
                  onClick={() => setMedications(medications.filter((_, idx) => idx !== i))}
                  disabled={medications.length === 1}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Patient copay (GHS)</label>
            <input
              className="input"
              type="number"
              min={0}
              step="0.01"
              value={copay}
              onChange={(e) => setCopay(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="label">Claim total (GHS)</label>
            <input className="input bg-gray-50" value={total.toFixed(2)} readOnly />
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ============ CLAIM DETAIL MODAL ============
function ClaimDetailModal({
  claim, onClose, onUpdated,
}: { claim: Claim | null; onClose: () => void; onUpdated: () => void }) {
  const [updating, setUpdating] = useState(false);

  if (!claim) return null;

  const resubmit = async () => {
    setUpdating(true);
    try {
      await api.put(`/nhis/claims/${claim.id}`, { status: 'resubmitted' });
      toast.success('Claim resubmitted');
      onUpdated();
    } catch {
      toast.error('Failed to resubmit claim');
    } finally {
      setUpdating(false);
    }
  };

  return (
    <Modal
      open={!!claim}
      onClose={onClose}
      title={claim.claim_number}
      description={`${claim.patient_name}${claim.nhis_number ? ` · NHIS ${claim.nhis_number}` : ''}`}
      size="md"
      footer={
        claim.status === 'rejected' ? (
          <>
            <button className="btn-secondary btn-sm" onClick={onClose}>Close</button>
            <button className="btn-primary btn-sm" onClick={resubmit} disabled={updating}>
              {updating ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Resubmit Claim
            </button>
          </>
        ) : (
          <button className="btn-secondary btn-sm" onClick={onClose}>Close</button>
        )
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className={statusBadge(claim.status)}>{claim.status}</span>
          {claim.submitted_at && (
            <span className="text-xs text-gray-500">
              Submitted {new Date(claim.submitted_at).toLocaleString()}
            </span>
          )}
        </div>

        {claim.rejection_reason && (
          <div className="p-3 rounded-lg bg-red-50 text-sm text-red-700">
            <strong>Rejection reason:</strong> {claim.rejection_reason}
          </div>
        )}

        <div>
          <div className="label">Diagnosis codes</div>
          <div className="flex flex-wrap gap-1.5">
            {(claim.diagnosis_codes || []).map((code, i) => (
              <span key={i} className="badge-info">{code}</span>
            ))}
          </div>
        </div>

        <div>
          <div className="label">Medications</div>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr><th>Item</th><th>Qty</th><th>Unit Price</th><th className="text-right">Subtotal</th></tr>
              </thead>
              <tbody>
                {(claim.medication_details || []).map((med, i) => (
                  <tr key={i}>
                    <td>{med.name}</td>
                    <td>{med.quantity}</td>
                    <td>GHS {Number(med.unit_price).toFixed(2)}</td>
                    <td className="text-right">GHS {(Number(med.quantity) * Number(med.unit_price)).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="p-3 bg-gray-50 rounded-xl">
            <div className="text-xs text-gray-500">Total</div>
            <div className="font-semibold">GHS {Number(claim.total_amount).toFixed(2)}</div>
          </div>
          <div className="p-3 bg-gray-50 rounded-xl">
            <div className="text-xs text-gray-500">Copay</div>
            <div className="font-semibold">GHS {Number(claim.patient_copay).toFixed(2)}</div>
          </div>
          <div className="p-3 bg-gray-50 rounded-xl">
            <div className="text-xs text-gray-500">NHIS Approved</div>
            <div className="font-semibold">
              {claim.nhis_approved_amount ? `GHS ${Number(claim.nhis_approved_amount).toFixed(2)}` : '—'}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
