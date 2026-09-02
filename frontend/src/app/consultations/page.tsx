'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { Modal } from '@/components/ui/modal';
import { PatientSelect, type PatientOption } from '@/components/ui/patient-select';
import { api } from '@/lib/api';
import {
  Calendar,
  Plus,
  Clock,
  Video,
  MessageSquare,
  Phone,
  CalendarCheck,
  XCircle,
  PlayCircle,
  CheckCircle2,
  StickyNote,
} from 'lucide-react';

interface Consultation {
  id: string;
  patient_id: string;
  patient_name: string;
  pharmacist_name: string;
  type: string;
  status: string;
  scheduled_at: string;
  started_at: string | null;
  ended_at: string | null;
  reason: string;
  notes: string | null;
  follow_up_date: string | null;
  video_room_id: string | null;
}

interface ConsultationSummary {
  total: number;
  today: number;
  upcoming: number;
  by_status: Record<string, number>;
  by_type: { type: string; count: number }[];
}

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'scheduled', label: 'Upcoming' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'no_show', label: 'No-show' },
];

const TYPE_OPTIONS = [
  { key: 'in_person', label: 'In person', Icon: CalendarCheck, color: 'text-green-600 bg-green-50' },
  { key: 'video', label: 'Video call', Icon: Video, color: 'text-blue-600 bg-blue-50' },
  { key: 'chat', label: 'Chat', Icon: MessageSquare, color: 'text-purple-600 bg-purple-50' },
  { key: 'phone', label: 'Phone', Icon: Phone, color: 'text-amber-600 bg-amber-50' },
];

function typeMeta(type: string) {
  return TYPE_OPTIONS.find((t) => t.key === type) || TYPE_OPTIONS[0];
}

function statusBadge(status: string) {
  switch (status) {
    case 'completed':
      return 'badge-success';
    case 'in_progress':
      return 'badge-info';
    case 'cancelled':
    case 'no_show':
      return 'badge-danger';
    default:
      return 'badge-warning';
  }
}

function statusLabel(status: string) {
  return status.replace('_', '-');
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const isToday = date.toDateString() === today.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  if (isToday) return `Today at ${time}`;
  if (isTomorrow) return `Tomorrow at ${time}`;
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} at ${time}`;
}

/** Converts a Date into the `YYYY-MM-DDTHH:mm` format datetime-local inputs expect. */
function toLocalInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function ConsultationsPage() {
  const { isAuthenticated } = useAuthStore();
  const hydrated = useHydrated();
  const router = useRouter();

  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [summary, setSummary] = useState<ConsultationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [showNewModal, setShowNewModal] = useState(false);
  const [detail, setDetail] = useState<Consultation | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (status) params.set('status', status);
      if (typeFilter) params.set('type', typeFilter);

      const [listResponse, summaryResponse] = await Promise.all([
        api.get(`/consultations?${params.toString()}`),
        api.get('/consultations/summary'),
      ]);

      setConsultations(listResponse.data || []);
      setTotalPages(listResponse.pagination?.totalPages || 1);
      setSummary(summaryResponse.data || null);
    } catch {
      toast.error('Failed to load consultations');
    } finally {
      setLoading(false);
    }
  }, [page, status, typeFilter]);

  useEffect(() => {
    if (hydrated && isAuthenticated) load();
  }, [hydrated, isAuthenticated, load]);

  useEffect(() => {
    setPage(1);
  }, [status, typeFilter]);

  const updateStatus = async (consultation: Consultation, nextStatus: string) => {
    setBusyId(consultation.id);
    try {
      const payload: Record<string, unknown> = { status: nextStatus };
      if (nextStatus === 'in_progress') payload.started_at = new Date().toISOString();
      if (nextStatus === 'completed' || nextStatus === 'cancelled') payload.ended_at = new Date().toISOString();

      await api.put(`/consultations/${consultation.id}`, payload);
      toast.success(`Consultation marked ${statusLabel(nextStatus)}`);
      setDetail(null);
      await load();
    } catch {
      toast.error('Failed to update consultation');
    } finally {
      setBusyId(null);
    }
  };

  if (!hydrated || !isAuthenticated) return null;

  const byStatus = summary?.by_status || {};

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Consultations</h1>
            <p className="text-gray-500 mt-1">Schedule and manage patient consultations</p>
          </div>
          <button className="btn-primary btn-sm" onClick={() => setShowNewModal(true)}>
            <Plus className="w-4 h-4" />
            New Consultation
          </button>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="stat-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Today</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{summary?.today ?? 0}</p>
              </div>
              <Calendar className="w-9 h-9 text-primary-600 opacity-20" />
            </div>
          </div>
          <div className="stat-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Upcoming</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{summary?.upcoming ?? 0}</p>
              </div>
              <Clock className="w-9 h-9 text-blue-600 opacity-20" />
            </div>
          </div>
          <div className="stat-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Completed</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{byStatus.completed ?? 0}</p>
              </div>
              <CheckCircle2 className="w-9 h-9 text-green-600 opacity-20" />
            </div>
          </div>
          <div className="stat-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Cancelled</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">
                  {(byStatus.cancelled ?? 0) + (byStatus.no_show ?? 0)}
                </p>
              </div>
              <XCircle className="w-9 h-9 text-red-500 opacity-20" />
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-full sm:w-fit overflow-x-auto">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setStatus(tab.key)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                  tab.key === status ? 'bg-white shadow text-primary-700' : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <select
            className="select sm:w-48"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="">All types</option>
            {TYPE_OPTIONS.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
        </div>

        {/* Consultations List */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="spinner" />
          </div>
        ) : consultations.length === 0 ? (
          <div className="empty-state">
            <Calendar className="w-12 h-12 text-gray-300 mx-auto" />
            <h3 className="mt-3 text-sm font-semibold text-gray-900">No consultations found</h3>
            <p className="mt-1 text-sm text-gray-500">
              Schedule a consultation to get started.
            </p>
            <button className="btn-primary btn-sm mt-4" onClick={() => setShowNewModal(true)}>
              <Plus className="w-4 h-4" />
              New Consultation
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {consultations.map((consult) => {
              const meta = typeMeta(consult.type);
              const Icon = meta.Icon;
              const isBusy = busyId === consult.id;

              return (
                <div key={consult.id} className="card flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <button
                    type="button"
                    className="flex items-center gap-4 text-left flex-1 min-w-0"
                    onClick={() => setDetail(consult)}
                  >
                    <div className={`w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 ${meta.color}`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-900 truncate">{consult.patient_name}</div>
                      <div className="text-sm text-gray-500 truncate">{consult.reason}</div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <Clock className="w-3.5 h-3.5 text-gray-400" />
                        <span className="text-xs text-gray-500">{formatWhen(consult.scheduled_at)}</span>
                        <span className="text-xs text-gray-400">· {consult.pharmacist_name}</span>
                      </div>
                    </div>
                  </button>

                  <div className="flex items-center gap-2 sm:flex-shrink-0">
                    <span className={`${statusBadge(consult.status)} capitalize`}>
                      {statusLabel(consult.status)}
                    </span>
                    {consult.status === 'scheduled' && (
                      <button
                        className="btn-ghost btn-sm"
                        disabled={isBusy}
                        onClick={() => updateStatus(consult, 'in_progress')}
                      >
                        <PlayCircle className="w-4 h-4" />
                        Start
                      </button>
                    )}
                    {(consult.status === 'scheduled' || consult.status === 'in_progress') && (
                      <button
                        className="btn-secondary btn-sm"
                        disabled={isBusy}
                        onClick={() => updateStatus(consult, 'completed')}
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        Complete
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <button
              className="btn-secondary btn-sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <span className="text-sm text-gray-500">Page {page} of {totalPages}</span>
            <button
              className="btn-secondary btn-sm"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        )}
      </div>

      <NewConsultationModal
        open={showNewModal}
        onClose={() => setShowNewModal(false)}
        onCreated={async () => {
          setShowNewModal(false);
          await load();
        }}
      />

      <ConsultationDetailModal
        consultation={detail}
        busy={busyId === detail?.id}
        onClose={() => setDetail(null)}
        onStatusChange={updateStatus}
        onNotesSaved={async (id, notes) => {
          setConsultations((prev) => prev.map((c) => (c.id === id ? { ...c, notes } : c)));
          setDetail((prev) => (prev && prev.id === id ? { ...prev, notes } : prev));
        }}
      />
    </DashboardLayout>
  );
}

function NewConsultationModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const defaultTime = () => {
    const next = new Date();
    next.setHours(next.getHours() + 1, 0, 0, 0);
    return toLocalInputValue(next);
  };

  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [type, setType] = useState('in_person');
  const [scheduledAt, setScheduledAt] = useState(defaultTime);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  const patientInvalid = touched && !patient;
  const reasonInvalid = touched && reason.trim().length === 0;
  const timeInvalid = touched && !scheduledAt;

  const reset = () => {
    setPatient(null);
    setType('in_person');
    setScheduledAt(defaultTime());
    setReason('');
    setNotes('');
    setFollowUp('');
    setTouched(false);
  };

  const handleSubmit = async () => {
    setTouched(true);
    if (!patient || !reason.trim() || !scheduledAt) return;

    setSubmitting(true);
    try {
      await api.post('/consultations', {
        patient_id: patient.id,
        type,
        scheduled_at: new Date(scheduledAt).toISOString(),
        reason: reason.trim(),
        notes: notes.trim() || undefined,
        follow_up_date: followUp || undefined,
      });
      toast.success('Consultation scheduled');
      reset();
      onCreated();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to schedule consultation');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { if (!submitting) { reset(); onClose(); } }}
      title="New consultation"
      description="Book a patient consultation with a pharmacist"
      footer={
        <>
          <button className="btn-secondary btn-sm" onClick={() => { reset(); onClose(); }} disabled={submitting}>
            Cancel
          </button>
          <button className="btn-primary btn-sm" onClick={handleSubmit} disabled={submitting}>
            {submitting && <div className="spinner" />}
            Schedule consultation
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <PatientSelect value={patient} onChange={setPatient} invalid={patientInvalid} />

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Consultation type</label>
            <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPE_OPTIONS.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Date &amp; time</label>
            <input
              type="datetime-local"
              className={`input ${timeInvalid ? 'input-error' : ''}`}
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="label">Reason for consultation</label>
          <input
            type="text"
            className={`input ${reasonInvalid ? 'input-error' : ''}`}
            placeholder="e.g. Diabetes medication review"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {reasonInvalid && <p className="text-xs text-red-600 mt-1">A reason is required</p>}
        </div>

        <div>
          <label className="label">Notes (optional)</label>
          <textarea
            className="input"
            rows={3}
            placeholder="Anything the pharmacist should know beforehand"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div>
          <label className="label">Follow-up date (optional)</label>
          <input
            type="date"
            className="input"
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

function ConsultationDetailModal({
  consultation,
  busy,
  onClose,
  onStatusChange,
  onNotesSaved,
}: {
  consultation: Consultation | null;
  busy: boolean;
  onClose: () => void;
  onStatusChange: (consultation: Consultation, status: string) => void;
  onNotesSaved: (id: string, notes: string) => void;
}) {
  const [notes, setNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);

  useEffect(() => {
    setNotes(consultation?.notes || '');
  }, [consultation]);

  if (!consultation) return null;

  const meta = typeMeta(consultation.type);
  const Icon = meta.Icon;

  const saveNotes = async () => {
    setSavingNotes(true);
    try {
      await api.put(`/consultations/${consultation.id}`, { notes: notes.trim() });
      toast.success('Notes saved');
      onNotesSaved(consultation.id, notes.trim());
    } catch {
      toast.error('Failed to save notes');
    } finally {
      setSavingNotes(false);
    }
  };

  return (
    <Modal
      open={!!consultation}
      onClose={onClose}
      title={consultation.patient_name}
      description={`${meta.label} consultation · ${formatWhen(consultation.scheduled_at)}`}
      size="lg"
      footer={
        <>
          <button className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>Close</button>
          {consultation.status === 'scheduled' && (
            <>
              <button
                className="btn-danger btn-sm"
                disabled={busy}
                onClick={() => onStatusChange(consultation, 'cancelled')}
              >
                <XCircle className="w-4 h-4" />
                Cancel
              </button>
              <button
                className="btn-ghost btn-sm"
                disabled={busy}
                onClick={() => onStatusChange(consultation, 'in_progress')}
              >
                <PlayCircle className="w-4 h-4" />
                Start
              </button>
            </>
          )}
          {consultation.status === 'in_progress' && (
            <button
              className="btn-primary btn-sm"
              disabled={busy}
              onClick={() => onStatusChange(consultation, 'completed')}
            >
              <CheckCircle2 className="w-4 h-4" />
              Mark completed
            </button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <div className={`w-11 h-11 rounded-full flex items-center justify-center ${meta.color}`}>
            <Icon className="w-5 h-5" />
          </div>
          <div>
            <span className={`${statusBadge(consultation.status)} capitalize`}>
              {statusLabel(consultation.status)}
            </span>
            <p className="text-sm text-gray-500 mt-1">Pharmacist: {consultation.pharmacist_name}</p>
          </div>
        </div>

        <dl className="grid sm:grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">Reason</dt>
            <dd className="text-gray-900 font-medium mt-0.5">{consultation.reason}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Scheduled</dt>
            <dd className="text-gray-900 font-medium mt-0.5">
              {new Date(consultation.scheduled_at).toLocaleString([], {
                day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            </dd>
          </div>
          {consultation.started_at && (
            <div>
              <dt className="text-gray-500">Started</dt>
              <dd className="text-gray-900 font-medium mt-0.5">
                {new Date(consultation.started_at).toLocaleString([], { hour: '2-digit', minute: '2-digit' })}
              </dd>
            </div>
          )}
          {consultation.follow_up_date && (
            <div>
              <dt className="text-gray-500">Follow-up</dt>
              <dd className="text-gray-900 font-medium mt-0.5">
                {new Date(consultation.follow_up_date).toLocaleDateString([], {
                  day: 'numeric', month: 'short', year: 'numeric',
                })}
              </dd>
            </div>
          )}
        </dl>

        <div>
          <label className="label flex items-center gap-1.5">
            <StickyNote className="w-3.5 h-3.5" />
            Consultation notes
          </label>
          <textarea
            className="input"
            rows={5}
            placeholder="Record findings, advice given and any referrals..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={consultation.status === 'cancelled'}
          />
          <div className="flex justify-end mt-2">
            <button
              className="btn-secondary btn-sm"
              onClick={saveNotes}
              disabled={savingNotes || notes.trim() === (consultation.notes || '')}
            >
              {savingNotes && <div className="spinner" />}
              Save notes
            </button>
          </div>
        </div>

        {consultation.video_room_id && (
          <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
            Video room: <span className="font-mono">{consultation.video_room_id}</span>
            <br />
            Live video streaming is not connected yet — video provider integration is pending.
          </p>
        )}
      </div>
    </Modal>
  );
}
