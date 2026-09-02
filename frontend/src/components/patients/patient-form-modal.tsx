'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';

export interface Patient {
  id: string;
  nhis_number: string | null;
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  gender: string;
  phone: string;
  alternate_phone: string | null;
  address: string | null;
  region: string | null;
  district: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  allergies: string[];
  chronic_conditions: string[];
  blood_type: string | null;
  notes: string | null;
  created_at: string;
}

export const GHANA_REGIONS = [
  'Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern', 'Greater Accra',
  'North East', 'Northern', 'Oti', 'Savanna', 'Upper East', 'Upper West', 'Volta',
  'Western', 'Western North',
];

const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const EMPTY_FORM = {
  first_name: '',
  last_name: '',
  phone: '',
  nhis_number: '',
  date_of_birth: '',
  gender: 'other',
  alternate_phone: '',
  address: '',
  region: '',
  district: '',
  emergency_contact_name: '',
  emergency_contact_phone: '',
  allergies: '',
  chronic_conditions: '',
  blood_type: '',
  notes: '',
};

/** Splits a comma-separated list into trimmed, non-empty entries. */
function toList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Ghanaian numbers are commonly written 0XXXXXXXXX; normalise to +233 form. */
function normalizeGhanaPhone(value: string): string {
  const digits = value.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `+233${digits.slice(1)}`;
  return digits;
}

interface PatientFormModalProps {
  open: boolean;
  patient?: Patient | null;
  onClose: () => void;
  onSaved: (patient: Patient) => void;
}

export function PatientFormModal({ open, patient, onClose, onSaved }: PatientFormModalProps) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  const isEdit = !!patient;

  useEffect(() => {
    if (!open) return;
    setTouched(false);
    if (patient) {
      setForm({
        first_name: patient.first_name || '',
        last_name: patient.last_name || '',
        phone: patient.phone || '',
        nhis_number: patient.nhis_number || '',
        date_of_birth: patient.date_of_birth ? new Date(patient.date_of_birth).toISOString().slice(0, 10) : '',
        gender: patient.gender || 'other',
        alternate_phone: patient.alternate_phone || '',
        address: patient.address || '',
        region: patient.region || '',
        district: patient.district || '',
        emergency_contact_name: patient.emergency_contact_name || '',
        emergency_contact_phone: patient.emergency_contact_phone || '',
        allergies: (patient.allergies || []).join(', '),
        chronic_conditions: (patient.chronic_conditions || []).join(', '),
        blood_type: patient.blood_type || '',
        notes: patient.notes || '',
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [open, patient]);

  const set = (field: keyof typeof EMPTY_FORM, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const errors = {
    first_name: form.first_name.trim() === '' ? 'First name is required' : '',
    last_name: form.last_name.trim() === '' ? 'Last name is required' : '',
    phone: form.phone.trim() === '' ? 'Phone number is required' : '',
    date_of_birth:
      form.date_of_birth && new Date(form.date_of_birth) > new Date()
        ? 'Date of birth cannot be in the future'
        : '',
  };
  const hasErrors = Object.values(errors).some(Boolean);

  const handleSubmit = async () => {
    setTouched(true);
    if (hasErrors) return;

    setSubmitting(true);
    try {
      const payload = {
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        phone: normalizeGhanaPhone(form.phone),
        nhis_number: form.nhis_number.trim() || null,
        date_of_birth: form.date_of_birth || null,
        gender: form.gender,
        alternate_phone: form.alternate_phone.trim() ? normalizeGhanaPhone(form.alternate_phone) : null,
        address: form.address.trim() || null,
        region: form.region || null,
        district: form.district.trim() || null,
        emergency_contact_name: form.emergency_contact_name.trim() || null,
        emergency_contact_phone: form.emergency_contact_phone.trim()
          ? normalizeGhanaPhone(form.emergency_contact_phone)
          : null,
        allergies: toList(form.allergies),
        chronic_conditions: toList(form.chronic_conditions),
        blood_type: form.blood_type || null,
        notes: form.notes.trim() || null,
      };

      const response = isEdit
        ? await api.put(`/patients/${patient!.id}`, payload)
        : await api.post('/patients', payload);

      toast.success(isEdit ? 'Patient record updated' : 'Patient registered');
      onSaved(response.data);
    } catch (error: any) {
      toast.error(error?.message || 'Failed to save patient');
    } finally {
      setSubmitting(false);
    }
  };

  const errorFor = (field: keyof typeof errors) => (touched ? errors[field] : '');

  return (
    <Modal
      open={open}
      onClose={() => { if (!submitting) onClose(); }}
      title={isEdit ? 'Edit patient' : 'Register patient'}
      description={isEdit ? 'Update the patient record' : 'Create a new patient profile'}
      size="lg"
      footer={
        <>
          <button className="btn-secondary btn-sm" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={handleSubmit} disabled={submitting}>
            {submitting && <div className="spinner" />}
            {isEdit ? 'Save changes' : 'Register patient'}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <fieldset className="space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
            Personal details
          </legend>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">First name *</label>
              <input
                type="text"
                className={`input ${errorFor('first_name') ? 'input-error' : ''}`}
                value={form.first_name}
                onChange={(e) => set('first_name', e.target.value)}
              />
              {errorFor('first_name') && <p className="text-xs text-red-600 mt-1">{errorFor('first_name')}</p>}
            </div>
            <div>
              <label className="label">Last name *</label>
              <input
                type="text"
                className={`input ${errorFor('last_name') ? 'input-error' : ''}`}
                value={form.last_name}
                onChange={(e) => set('last_name', e.target.value)}
              />
              {errorFor('last_name') && <p className="text-xs text-red-600 mt-1">{errorFor('last_name')}</p>}
            </div>
          </div>
          <div className="grid sm:grid-cols-3 gap-4">
            <div>
              <label className="label">Date of birth</label>
              <input
                type="date"
                className={`input ${errorFor('date_of_birth') ? 'input-error' : ''}`}
                value={form.date_of_birth}
                onChange={(e) => set('date_of_birth', e.target.value)}
              />
              {errorFor('date_of_birth') && (
                <p className="text-xs text-red-600 mt-1">{errorFor('date_of_birth')}</p>
              )}
            </div>
            <div>
              <label className="label">Gender</label>
              <select className="select" value={form.gender} onChange={(e) => set('gender', e.target.value)}>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="label">Blood type</label>
              <select className="select" value={form.blood_type} onChange={(e) => set('blood_type', e.target.value)}>
                <option value="">Unknown</option>
                {BLOOD_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
            Contact &amp; coverage
          </legend>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Phone number *</label>
              <input
                type="tel"
                className={`input ${errorFor('phone') ? 'input-error' : ''}`}
                placeholder="024 123 4567"
                value={form.phone}
                onChange={(e) => set('phone', e.target.value)}
              />
              {errorFor('phone') ? (
                <p className="text-xs text-red-600 mt-1">{errorFor('phone')}</p>
              ) : (
                <p className="text-xs text-gray-400 mt-1">Used for SMS refill reminders</p>
              )}
            </div>
            <div>
              <label className="label">NHIS number</label>
              <input
                type="text"
                className="input"
                placeholder="Required to submit NHIS claims"
                value={form.nhis_number}
                onChange={(e) => set('nhis_number', e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="label">Alternate phone</label>
            <input
              type="tel"
              className="input"
              value={form.alternate_phone}
              onChange={(e) => set('alternate_phone', e.target.value)}
            />
          </div>
          <div>
            <label className="label">Address</label>
            <input
              type="text"
              className="input"
              value={form.address}
              onChange={(e) => set('address', e.target.value)}
            />
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Region</label>
              <select className="select" value={form.region} onChange={(e) => set('region', e.target.value)}>
                <option value="">Select region</option>
                {GHANA_REGIONS.map((region) => (
                  <option key={region} value={region}>{region}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">District</label>
              <input
                type="text"
                className="input"
                value={form.district}
                onChange={(e) => set('district', e.target.value)}
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
            Clinical
          </legend>
          <div>
            <label className="label">Chronic conditions</label>
            <input
              type="text"
              className="input"
              placeholder="Comma separated, e.g. Hypertension, Type 2 Diabetes"
              value={form.chronic_conditions}
              onChange={(e) => set('chronic_conditions', e.target.value)}
            />
          </div>
          <div>
            <label className="label">Allergies</label>
            <input
              type="text"
              className="input"
              placeholder="Comma separated, e.g. Penicillin"
              value={form.allergies}
              onChange={(e) => set('allergies', e.target.value)}
            />
            <p className="text-xs text-gray-400 mt-1">
              Allergies are shown prominently on the patient profile to prevent dispensing errors
            </p>
          </div>
          <div>
            <label className="label">Notes</label>
            <textarea
              className="input"
              rows={3}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
            Emergency contact
          </legend>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Name</label>
              <input
                type="text"
                className="input"
                value={form.emergency_contact_name}
                onChange={(e) => set('emergency_contact_name', e.target.value)}
              />
            </div>
            <div>
              <label className="label">Phone</label>
              <input
                type="tel"
                className="input"
                value={form.emergency_contact_phone}
                onChange={(e) => set('emergency_contact_phone', e.target.value)}
              />
            </div>
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}
