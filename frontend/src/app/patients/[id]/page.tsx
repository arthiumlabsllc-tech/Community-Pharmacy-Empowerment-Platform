'use client';

/**
 * Cloudflare Pages builds this through @cloudflare/next-on-pages, which can only
 * serve a non-static route on the Workers edge runtime and fails the whole
 * deploy otherwise. Every other page here is prerendered static because it is
 * client-rendered behind no dynamic segment; this one has `[id]` and no
 * generateStaticParams, so Next renders it on demand.
 *
 * Deliberately not `dynamic = 'force-static'`: that prerenders one shell with
 * empty params and serves it for every patient, and useParams() below is the
 * only thing supplying the id this page fetches with.
 */
export const runtime = 'edge';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { Modal } from '@/components/ui/modal';
import { PatientFormModal, type Patient } from '@/components/patients/patient-form-modal';
import { api } from '@/lib/api';
import {
  ArrowLeft,
  Phone,
  FileText,
  Stethoscope,
  Bell,
  Calendar,
  MapPin,
  Edit2,
  AlertTriangle,
  Heart,
  Info,
} from 'lucide-react';

interface Prescription {
  id: string;
  prescriber_name: string | null;
  prescriber_facility: string | null;
  medication_details: any[];
  diagnosis: string | null;
  status: string;
  issue_date: string;
  filled_date: string | null;
}

interface Screening {
  id: string;
  type: string;
  systolic: number | null;
  diastolic: number | null;
  value: string | number;
  unit: string;
  risk_level: string;
  notes: string | null;
  referred_to_clinic: boolean;
  referral_clinic: string | null;
  recorded_by_name: string;
  recorded_at: string;
}

interface Claim {
  id: string;
  claim_number: string | null;
  status: string;
  total_amount: string | number;
  nhis_approved_amount: string | number | null;
  patient_copay: string | number | null;
  rejection_reason: string | null;
  submitted_at: string | null;
  created_at: string;
}

interface Consultation {
  id: string;
  type: string;
  status: string;
  reason: string;
  notes: string | null;
  scheduled_at: string;
  pharmacist_name: string;
}

interface Reminder {
  id: string;
  type: string;
  title: string;
  message: string | null;
  scheduled_at: string;
  sent_at: string | null;
  status: string;
  recurrence: string | null;
}

interface OverviewStats {
  prescriptions_total: number;
  prescriptions_filled: number;
  screenings_total: number;
  claims_total: number;
  reminders_pending: number;
  last_visit: string | null;
}

interface Overview {
  patient: Patient;
  prescriptions: Prescription[];
  screenings: Screening[];
  claims: Claim[];
  consultations: Consultation[];
  reminders: Reminder[];
  stats: OverviewStats;
}

type TabKey = 'overview' | 'prescriptions' | 'screenings' | 'claims' | 'consultations' | 'reminders';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'prescriptions', label: 'Prescriptions' },
  { key: 'screenings', label: 'Screenings' },
  { key: 'claims', label: 'NHIS Claims' },
  { key: 'consultations', label: 'Consultations' },
  { key: 'reminders', label: 'Reminders' },
];

const RISK_BADGE: Record<string, string> = {
  low: 'badge-success',
  moderate: 'badge-warning',
  high: 'badge-danger',
  critical: 'badge-danger',
};

const PRESCRIPTION_BADGE: Record<string, string> = {
  pending: 'badge-warning',
  filled: 'badge-success',
  partially_filled: 'badge-info',
  cancelled: 'badge-neutral',
  expired: 'badge-danger',
};

const CLAIM_BADGE: Record<string, string> = {
  draft: 'badge-neutral',
  pending: 'badge-info',
  submitted: 'badge-info',
  resubmitted: 'badge-info',
  approved: 'badge-success',
  paid: 'badge-success',
  rejected: 'badge-danger',
};

function formatDate(value: string | null | undefined, withTime = false) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

function getAge(dob: string | null) {
  if (!dob) return null;
  const age = Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  return Number.isFinite(age) && age >= 0 ? age : null;
}

function screeningDisplay(screening: Screening) {
  if (screening.type === 'blood_pressure' && screening.systolic && screening.diastolic) {
    return `${screening.systolic}/${screening.diastolic} mmHg`;
  }
  return `${Number(screening.value)} ${screening.unit}`;
}

export default function PatientDetailPage() {
  const { isAuthenticated } = useAuthStore();
  const hydrated = useHydrated();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const patientId = params?.id;

  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<TabKey>('overview');
  const [editOpen, setEditOpen] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    try {
      const response = await api.get(`/patients/${patientId}/overview`);
      setOverview(response.data);
      setNotFound(false);
    } catch (error: any) {
      if (error?.status === 404) setNotFound(true);
      else toast.error('Failed to load patient record');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    if (hydrated && isAuthenticated) load();
  }, [hydrated, isAuthenticated, load]);

  if (!hydrated || !isAuthenticated) return null;

  const patient = overview?.patient;
  const stats = overview?.stats;
  const allergies = patient?.allergies || [];

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in">
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => router.push('/patients')}
        >
          <ArrowLeft className="w-4 h-4" />
          Back to patients
        </button>

        {loading && !overview ? (
          <div className="flex items-center justify-center py-24">
            <div className="spinner" />
          </div>
        ) : notFound || !patient ? (
          <div className="empty-state">
            <AlertTriangle className="w-12 h-12 text-gray-300 mx-auto" />
            <h3 className="mt-3 text-sm font-semibold text-gray-900">Patient not found</h3>
            <p className="mt-1 text-sm text-gray-500">
              This record does not exist or belongs to another pharmacy.
            </p>
            <button className="btn-primary btn-sm mt-4" onClick={() => router.push('/patients')}>
              Back to patients
            </button>
          </div>
        ) : (
          <>
            {/* Profile header */}
            <div className="card">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                <div className="flex items-start gap-4 min-w-0">
                  <div className="w-16 h-16 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0">
                    <span className="text-primary-700 font-bold text-xl">
                      {patient.first_name?.[0]}{patient.last_name?.[0]}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <h1 className="text-2xl font-bold text-gray-900 truncate">
                      {patient.first_name} {patient.last_name}
                    </h1>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500 mt-1">
                      {getAge(patient.date_of_birth) !== null && (
                        <span>{getAge(patient.date_of_birth)} years old</span>
                      )}
                      <span className="capitalize">{patient.gender}</span>
                      {patient.blood_type && <span>Blood type {patient.blood_type}</span>}
                      {patient.nhis_number && (
                        <span className="badge-info">NHIS: {patient.nhis_number}</span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600 mt-2">
                      <a href={`tel:${patient.phone}`} className="flex items-center gap-1.5 hover:text-primary-600">
                        <Phone className="w-3.5 h-3.5" />
                        {patient.phone}
                      </a>
                      {(patient.region || patient.district) && (
                        <span className="flex items-center gap-1.5">
                          <MapPin className="w-3.5 h-3.5 text-gray-400" />
                          {[patient.district, patient.region].filter(Boolean).join(', ')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button className="btn-secondary btn-sm" onClick={() => setEditOpen(true)}>
                    <Edit2 className="w-4 h-4" />
                    Edit
                  </button>
                  <button className="btn-primary btn-sm" onClick={() => setReminderOpen(true)}>
                    <Bell className="w-4 h-4" />
                    Add reminder
                  </button>
                </div>
              </div>

              {allergies.length > 0 && (
                <div className="mt-4 flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-100">
                  <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                  <div className="text-sm">
                    <span className="font-semibold text-red-800">Known allergies: </span>
                    <span className="text-red-700">{allergies.join(', ')}</span>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-5">
                <MiniStat label="Prescriptions" value={stats?.prescriptions_filled ?? 0} sub={`${stats?.prescriptions_total ?? 0} total`} />
                <MiniStat label="Screenings" value={stats?.screenings_total ?? 0} sub="recorded" />
                <MiniStat label="NHIS claims" value={stats?.claims_total ?? 0} sub="submitted" />
                <MiniStat label="Reminders" value={stats?.reminders_pending ?? 0} sub="pending" />
                <MiniStat
                  label="Last visit"
                  value={stats?.last_visit ? formatDate(stats.last_visit) : '—'}
                  sub="consultation"
                  small
                />
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-full overflow-x-auto">
              {TABS.map((item) => (
                <button
                  key={item.key}
                  onClick={() => setTab(item.key)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                    tab === item.key ? 'bg-white shadow text-primary-700' : 'text-gray-600 hover:text-gray-800'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {tab === 'overview' && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="card">
                  <div className="card-header">
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                      <Heart className="w-5 h-5 text-red-400" />
                      Clinical profile
                    </h2>
                  </div>
                  <dl className="space-y-3 text-sm">
                    <DetailRow label="Chronic conditions">
                      {(patient.chronic_conditions || []).length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {patient.chronic_conditions.map((condition, i) => (
                            <span key={i} className="badge-info">{condition}</span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-gray-400">None recorded</span>
                      )}
                    </DetailRow>
                    <DetailRow label="Allergies">
                      {allergies.length > 0 ? (
                        <span className="text-red-700 font-medium">{allergies.join(', ')}</span>
                      ) : (
                        <span className="text-gray-400">None recorded</span>
                      )}
                    </DetailRow>
                    <DetailRow label="Blood type">{patient.blood_type || <span className="text-gray-400">Unknown</span>}</DetailRow>
                    <DetailRow label="Address">{patient.address || <span className="text-gray-400">Not recorded</span>}</DetailRow>
                    <DetailRow label="Registered">{formatDate(patient.created_at)}</DetailRow>
                  </dl>
                </div>

                <div className="card">
                  <div className="card-header">
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                      <Phone className="w-5 h-5 text-primary-500" />
                      Contacts
                    </h2>
                  </div>
                  <dl className="space-y-3 text-sm">
                    <DetailRow label="Primary phone">
                      <a href={`tel:${patient.phone}`} className="text-primary-600 hover:underline">{patient.phone}</a>
                    </DetailRow>
                    <DetailRow label="Alternate phone">
                      {patient.alternate_phone ? (
                        <a href={`tel:${patient.alternate_phone}`} className="text-primary-600 hover:underline">
                          {patient.alternate_phone}
                        </a>
                      ) : (
                        <span className="text-gray-400">Not provided</span>
                      )}
                    </DetailRow>
                    <DetailRow label="Emergency contact">
                      {patient.emergency_contact_name ? (
                        <span>
                          {patient.emergency_contact_name}
                          {patient.emergency_contact_phone && (
                            <> · <a href={`tel:${patient.emergency_contact_phone}`} className="text-primary-600 hover:underline">{patient.emergency_contact_phone}</a></>
                          )}
                        </span>
                      ) : (
                        <span className="text-gray-400">Not provided</span>
                      )}
                    </DetailRow>
                    <DetailRow label="NHIS number">{patient.nhis_number || <span className="text-gray-400">Not enrolled</span>}</DetailRow>
                  </dl>

                  {patient.notes && (
                    <div className="mt-4 p-3 rounded-xl bg-gray-50">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">Notes</p>
                      <p className="text-sm text-gray-700 whitespace-pre-wrap">{patient.notes}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'prescriptions' && (
              <SectionCard
                title="Prescriptions"
                empty={overview!.prescriptions.length === 0}
                emptyText="No prescriptions recorded for this patient."
              >
                <div className="table-container">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Issued</th>
                        <th>Prescriber</th>
                        <th>Diagnosis</th>
                        <th>Medications</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview!.prescriptions.map((prescription) => (
                        <tr key={prescription.id}>
                          <td className="text-sm">{formatDate(prescription.issue_date)}</td>
                          <td className="text-sm">
                            <div className="text-gray-900">{prescription.prescriber_name || '—'}</div>
                            <div className="text-xs text-gray-500">{prescription.prescriber_facility || ''}</div>
                          </td>
                          <td className="text-sm">{prescription.diagnosis || '—'}</td>
                          <td className="text-sm">
                            {(prescription.medication_details || []).length === 0
                              ? '—'
                              : (prescription.medication_details || []).map((med: any, i: number) => (
                                  <div key={i} className="text-xs text-gray-600">
                                    {med.name}{med.quantity ? ` × ${med.quantity}` : ''}
                                  </div>
                                ))}
                          </td>
                          <td>
                            <span className={`${PRESCRIPTION_BADGE[prescription.status] || 'badge-neutral'} capitalize`}>
                              {prescription.status.replace('_', ' ')}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionCard>
            )}

            {tab === 'screenings' && (
              <SectionCard
                title="Health screenings"
                empty={overview!.screenings.length === 0}
                emptyText="No screenings recorded yet."
              >
                <div className="space-y-3">
                  {overview!.screenings.map((screening) => (
                    <div key={screening.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 rounded-xl border border-gray-100">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 capitalize">
                            {screening.type.replace(/_/g, ' ')}
                          </span>
                          <span className={RISK_BADGE[screening.risk_level] || 'badge-neutral'}>
                            {screening.risk_level} risk
                          </span>
                        </div>
                        <div className="text-sm text-gray-600 mt-0.5">{screeningDisplay(screening)}</div>
                        {screening.notes && <div className="text-xs text-gray-500 mt-1">{screening.notes}</div>}
                        {screening.referred_to_clinic && (
                          <div className="text-xs text-amber-700 mt-1">
                            Referred to {screening.referral_clinic || 'a clinic'}
                          </div>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 sm:text-right flex-shrink-0">
                        {formatDate(screening.recorded_at, true)}
                        <div>{screening.recorded_by_name}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}

            {tab === 'claims' && (
              <SectionCard
                title="NHIS claims"
                empty={overview!.claims.length === 0}
                emptyText="No NHIS claims submitted for this patient."
              >
                <div className="table-container">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Claim</th>
                        <th>Submitted</th>
                        <th>Amount</th>
                        <th>Approved</th>
                        <th>Copay</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview!.claims.map((claim) => (
                        <tr key={claim.id}>
                          <td className="text-sm font-mono text-xs">
                            <button
                              className="text-primary-600 hover:underline"
                              onClick={() => router.push('/claims')}
                            >
                              {claim.claim_number || '—'}
                            </button>
                          </td>
                          <td className="text-sm">{formatDate(claim.submitted_at || claim.created_at)}</td>
                          <td className="text-sm">GHS {Number(claim.total_amount).toFixed(2)}</td>
                          <td className="text-sm">
                            {claim.nhis_approved_amount != null ? `GHS ${Number(claim.nhis_approved_amount).toFixed(2)}` : '—'}
                          </td>
                          <td className="text-sm">
                            {claim.patient_copay != null ? `GHS ${Number(claim.patient_copay).toFixed(2)}` : '—'}
                          </td>
                          <td>
                            <span className={`${CLAIM_BADGE[claim.status] || 'badge-neutral'} capitalize`}>
                              {claim.status}
                            </span>
                            {claim.rejection_reason && (
                              <div className="text-xs text-red-600 mt-1 max-w-[220px]">
                                {claim.rejection_reason}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionCard>
            )}

            {tab === 'consultations' && (
              <SectionCard
                title="Consultations"
                empty={overview!.consultations.length === 0}
                emptyText="No consultations scheduled for this patient."
              >
                <div className="space-y-3">
                  {overview!.consultations.map((consultation) => (
                    <div key={consultation.id} className="p-3 rounded-xl border border-gray-100">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900">{consultation.reason}</div>
                          <div className="text-xs text-gray-500 mt-0.5 capitalize">
                            {consultation.type.replace('_', ' ')} · {consultation.pharmacist_name}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-xs text-gray-400">{formatDate(consultation.scheduled_at, true)}</span>
                          <span className={`${CLAIM_BADGE[consultation.status] || 'badge-neutral'} capitalize`}>
                            {consultation.status.replace('_', ' ')}
                          </span>
                        </div>
                      </div>
                      {consultation.notes && (
                        <p className="text-sm text-gray-600 mt-2 pt-2 border-t border-gray-50 whitespace-pre-wrap">
                          {consultation.notes}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}

            {tab === 'reminders' && (
              <SectionCard
                title="Reminders"
                empty={overview!.reminders.length === 0}
                emptyText="No reminders scheduled for this patient."
                action={
                  <button className="btn-primary btn-sm" onClick={() => setReminderOpen(true)}>
                    <Bell className="w-4 h-4" />
                    Add reminder
                  </button>
                }
              >
                <div className="flex items-start gap-2 p-3 rounded-xl bg-blue-50 mb-4">
                  <Info className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-blue-800">
                    Reminders are saved to this patient record. Automatic SMS delivery is not connected yet —
                    an SMS provider and scheduler still need to be configured.
                  </p>
                </div>
                <div className="space-y-3">
                  {overview!.reminders.map((reminder) => (
                    <div key={reminder.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 rounded-xl border border-gray-100">
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900">{reminder.title}</div>
                        {reminder.message && <div className="text-sm text-gray-600 mt-0.5">{reminder.message}</div>}
                        <div className="text-xs text-gray-400 mt-1 capitalize">
                          {reminder.type.replace(/_/g, ' ')}
                          {reminder.recurrence ? ` · repeats ${reminder.recurrence}` : ''}
                        </div>
                      </div>
                      <div className="text-xs text-gray-500 sm:text-right flex-shrink-0">
                        <div className="flex items-center gap-1.5 sm:justify-end">
                          <Calendar className="w-3.5 h-3.5 text-gray-400" />
                          {formatDate(reminder.scheduled_at, true)}
                        </div>
                        <span className={reminder.sent_at ? 'badge-success' : 'badge-warning'}>
                          {reminder.sent_at ? 'Sent' : reminder.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}
          </>
        )}
      </div>

      {patient && (
        <PatientFormModal
          open={editOpen}
          patient={patient}
          onClose={() => setEditOpen(false)}
          onSaved={async () => {
            setEditOpen(false);
            await load();
          }}
        />
      )}

      {patient && (
        <ReminderModal
          open={reminderOpen}
          patientId={patient.id}
          patientName={`${patient.first_name} ${patient.last_name}`}
          onClose={() => setReminderOpen(false)}
          onCreated={async () => {
            setReminderOpen(false);
            setTab('reminders');
            await load();
          }}
        />
      )}
    </DashboardLayout>
  );
}

function MiniStat({
  label,
  value,
  sub,
  small = false,
}: {
  label: string;
  value: string | number;
  sub: string;
  small?: boolean;
}) {
  return (
    <div className="p-3 rounded-xl bg-gray-50">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`font-bold text-gray-900 mt-0.5 ${small ? 'text-sm' : 'text-xl'}`}>{value}</p>
      <p className="text-xs text-gray-400">{sub}</p>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-gray-500 flex-shrink-0">{label}</dt>
      <dd className="text-gray-900 text-right">{children}</dd>
    </div>
  );
}

function SectionCard({
  title,
  empty,
  emptyText,
  action,
  children,
}: {
  title: string;
  empty: boolean;
  emptyText: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-header">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {empty ? (
        <div className="py-10 text-center">
          {title.toLowerCase().includes('screening') ? (
            <Stethoscope className="w-10 h-10 text-gray-200 mx-auto" />
          ) : title.toLowerCase().includes('reminder') ? (
            <Bell className="w-10 h-10 text-gray-200 mx-auto" />
          ) : title.toLowerCase().includes('consultation') ? (
            <Calendar className="w-10 h-10 text-gray-200 mx-auto" />
          ) : (
            <FileText className="w-10 h-10 text-gray-200 mx-auto" />
          )}
          <p className="text-sm text-gray-500 mt-2">{emptyText}</p>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

const REMINDER_TYPES = [
  { key: 'medication_refill', label: 'Medication refill' },
  { key: 'appointment', label: 'Appointment' },
  { key: 'screening_followup', label: 'Screening follow-up' },
  { key: 'adherence_check', label: 'Adherence check' },
  { key: 'general', label: 'General' },
];

const RECURRENCE_OPTIONS = [
  { key: '', label: 'One time' },
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
];

function ReminderModal({
  open,
  patientId,
  patientName,
  onClose,
  onCreated,
}: {
  open: boolean;
  patientId: string;
  patientName: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const defaultTime = () => {
    const next = new Date();
    next.setDate(next.getDate() + 7);
    next.setHours(9, 0, 0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}`;
  };

  const [type, setType] = useState('medication_refill');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [scheduledAt, setScheduledAt] = useState(defaultTime);
  const [recurrence, setRecurrence] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setType('medication_refill');
      setTitle('');
      setMessage('');
      setScheduledAt(defaultTime());
      setRecurrence('');
      setTouched(false);
    }
  }, [open]);

  const titleInvalid = touched && title.trim() === '';
  const timeInvalid = touched && !scheduledAt;

  const handleSubmit = async () => {
    setTouched(true);
    if (!title.trim() || !scheduledAt) return;

    setSubmitting(true);
    try {
      await api.post(`/patients/${patientId}/reminders`, {
        type,
        title: title.trim(),
        message: message.trim() || undefined,
        scheduled_at: new Date(scheduledAt).toISOString(),
        recurrence: recurrence || undefined,
      });
      toast.success(`Reminder scheduled for ${patientName}`);
      onCreated();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to create reminder');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { if (!submitting) onClose(); }}
      title="Schedule a reminder"
      description={`For ${patientName}`}
      footer={
        <>
          <button className="btn-secondary btn-sm" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={handleSubmit} disabled={submitting}>
            {submitting && <div className="spinner" />}
            Save reminder
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2 p-3 rounded-xl bg-blue-50">
          <Info className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-blue-800">
            The reminder is stored against the patient record. SMS delivery is not yet connected to a provider,
            so it will appear here but will not be sent automatically.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Reminder type</label>
            <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
              {REMINDER_TYPES.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Repeats</label>
            <select className="select" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
              {RECURRENCE_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label">Title *</label>
          <input
            type="text"
            className={`input ${titleInvalid ? 'input-error' : ''}`}
            placeholder="e.g. Refill Metformin 500mg"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          {titleInvalid && <p className="text-xs text-red-600 mt-1">A title is required</p>}
        </div>

        <div>
          <label className="label">Message</label>
          <textarea
            className="input"
            rows={3}
            placeholder="The reminder text shown to staff (and sent to the patient once SMS is connected)"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>

        <div>
          <label className="label">Due date &amp; time *</label>
          <input
            type="datetime-local"
            className={`input ${timeInvalid ? 'input-error' : ''}`}
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}
