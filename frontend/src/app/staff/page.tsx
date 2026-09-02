'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { usePermissions } from '@/hooks/use-permissions';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import {
  UserCog,
  Plus,
  ShieldCheck,
  Copy,
  KeyRound,
  Stethoscope,
  Heart,
  Calendar,
  FileText,
} from 'lucide-react';

interface StaffMember {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  role: string;
  avatar_url: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

interface StaffPerformance {
  id: string;
  first_name: string;
  last_name: string;
  role: string;
  is_active: boolean;
  prescriptions_filled: number;
  screenings_recorded: number;
  consultations_held: number;
}

const ROLE_LABEL: Record<string, string> = {
  pharmacy_owner: 'Pharmacy owner',
  pharmacist: 'Pharmacist',
  staff: 'Sales / cashier',
  super_admin: 'Platform admin',
};

const ROLE_BADGE: Record<string, string> = {
  pharmacy_owner: 'badge-success',
  pharmacist: 'badge-info',
  staff: 'badge-neutral',
  super_admin: 'badge-warning',
};

/** What each role can actually do, mirroring the backend authorize() checks. */
const ROLE_CAPABILITIES = [
  {
    role: 'Pharmacy owner',
    can: ['Everything, including staff roles and subscription billing', 'Add and remove stock', 'Delete inventory items'],
  },
  {
    role: 'Pharmacist',
    can: ['Dispense prescriptions and record screenings', 'Add and update stock', 'Edit pharmacy profile', 'Manage consultations'],
    cannot: ['Change staff roles', 'Delete inventory items', 'Change the subscription plan'],
  },
  {
    role: 'Sales / cashier',
    can: ['View inventory, patients and dashboards', 'Record screenings and consultations', 'Submit NHIS claims'],
    cannot: ['Add, edit or delete stock', 'Manage staff', 'Change pharmacy or subscription settings'],
  },
];

const PERIOD_OPTIONS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 365, label: 'Last 12 months' },
];

export default function StaffPage() {
  const { isAuthenticated, user } = useAuthStore();
  const hydrated = useHydrated();
  const router = useRouter();
  const { canManageStaff, canViewStaff } = usePermissions();

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [performance, setPerformance] = useState<StaffPerformance[]>([]);
  const [period, setPeriod] = useState(30);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [created, setCreated] = useState<{ name: string; email: string; password: string } | null>(null);
  const [pendingToggle, setPendingToggle] = useState<StaffMember | null>(null);
  const [toggling, setToggling] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (hydrated && !isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  // The API rejects cashier-level users, so send them back rather than showing
  // a page full of failed requests.
  useEffect(() => {
    if (hydrated && isAuthenticated && !canViewStaff) router.replace('/');
  }, [hydrated, isAuthenticated, canViewStaff, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [staffRes, performanceRes] = await Promise.allSettled([
        api.get('/pharmacies/staff'),
        api.get(`/pharmacies/staff-performance?period=${period}`),
      ]);
      if (staffRes.status === 'fulfilled') setStaff(staffRes.value.data || []);
      else toast.error('Failed to load staff');
      if (performanceRes.status === 'fulfilled') setPerformance(performanceRes.value.data || []);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    if (hydrated && isAuthenticated && canViewStaff) load();
  }, [hydrated, isAuthenticated, canViewStaff, load]);

  const changeRole = async (member: StaffMember, role: string) => {
    if (role === member.role) return;
    setBusyId(member.id);
    try {
      await api.put(`/pharmacies/staff/${member.id}`, { role });
      toast.success(`${member.first_name} is now a ${ROLE_LABEL[role]}`);
      await load();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to change role');
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async () => {
    if (!pendingToggle) return;
    setToggling(true);
    try {
      await api.put(`/pharmacies/staff/${pendingToggle.id}`, { is_active: !pendingToggle.is_active });
      toast.success(
        pendingToggle.is_active
          ? `${pendingToggle.first_name}'s access has been suspended`
          : `${pendingToggle.first_name}'s access has been restored`
      );
      setPendingToggle(null);
      await load();
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update staff member');
    } finally {
      setToggling(false);
    }
  };

  if (!hydrated || !isAuthenticated || !canViewStaff) return null;

  const performanceById = new Map(performance.map((row) => [row.id, row]));
  const activeCount = staff.filter((member) => member.is_active).length;

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-fade-in">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Staff Management</h1>
            <p className="text-gray-500 mt-1">
              {staff.length > 0
                ? `${activeCount} of ${staff.length} team member${staff.length === 1 ? '' : 's'} active`
                : 'Roles, access control and performance reporting'}
            </p>
          </div>
          {canManageStaff && (
            <button className="btn-primary btn-sm" onClick={() => setAddOpen(true)}>
              <Plus className="w-4 h-4" />
              Add Staff Member
            </button>
          )}
        </div>

        {/* Team */}
        <div className="card">
          <div className="card-header">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <UserCog className="w-5 h-5 text-primary-500" />
              Team
            </h2>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="spinner" />
            </div>
          ) : staff.length === 0 ? (
            <div className="empty-state">
              <UserCog className="w-12 h-12 text-gray-300 mx-auto" />
              <h3 className="mt-3 text-sm font-semibold text-gray-900">No staff records</h3>
              <p className="mt-1 text-sm text-gray-500">Add a team member to assign roles.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {staff.map((member) => {
                const stats = performanceById.get(member.id);
                const isSelf = member.id === user?.id;
                const isBusy = busyId === member.id;

                return (
                  <div
                    key={member.id}
                    className={`p-4 rounded-xl border ${member.is_active ? 'border-gray-100' : 'border-gray-100 bg-gray-50 opacity-70'}`}
                  >
                    <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className={`w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 ${
                          member.is_active ? 'bg-primary-50' : 'bg-gray-200'
                        }`}>
                          <span className={`font-semibold text-sm ${member.is_active ? 'text-primary-700' : 'text-gray-500'}`}>
                            {member.first_name?.[0]}{member.last_name?.[0]}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-gray-900">
                              {member.first_name} {member.last_name}
                            </span>
                            {isSelf && <span className="badge-info">You</span>}
                            {!member.is_active && <span className="badge-danger">Suspended</span>}
                          </div>
                          <div className="text-xs text-gray-500 truncate">{member.email}</div>
                          {member.phone && <div className="text-xs text-gray-400">{member.phone}</div>}
                        </div>
                      </div>

                      <div className="flex flex-col sm:flex-row sm:items-center gap-3 lg:gap-4">
                        <div className="text-xs text-gray-400 lg:text-right">
                          <div>Last signed in</div>
                          <div className="text-gray-600">
                            {member.last_login_at
                              ? new Date(member.last_login_at).toLocaleDateString([], {
                                  day: 'numeric', month: 'short', year: 'numeric',
                                })
                              : 'Never'}
                          </div>
                        </div>

                        {canManageStaff ? (
                          <select
                            className="select sm:w-48"
                            value={member.role}
                            disabled={isBusy || member.role === 'pharmacy_owner'}
                            onChange={(e) => changeRole(member, e.target.value)}
                            title={
                              member.role === 'pharmacy_owner'
                                ? 'The owner role cannot be changed'
                                : 'Change this person\'s role'
                            }
                          >
                            <option value="pharmacy_owner">Pharmacy owner</option>
                            <option value="pharmacist">Pharmacist</option>
                            <option value="staff">Sales / cashier</option>
                          </select>
                        ) : (
                          <span className={ROLE_BADGE[member.role] || 'badge-neutral'}>
                            {ROLE_LABEL[member.role] || member.role}
                          </span>
                        )}

                        {canManageStaff && !isSelf && (
                          <button
                            className={member.is_active ? 'btn-danger btn-sm' : 'btn-secondary btn-sm'}
                            disabled={isBusy}
                            onClick={() => setPendingToggle(member)}
                          >
                            {member.is_active ? 'Suspend' : 'Restore'}
                          </button>
                        )}
                      </div>
                    </div>

                    {stats && (
                      <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-gray-100">
                        <MiniStat
                          icon={<FileText className="w-3.5 h-3.5" />}
                          label="Prescriptions"
                          value={stats.prescriptions_filled}
                        />
                        <MiniStat
                          icon={<Heart className="w-3.5 h-3.5" />}
                          label="Screenings"
                          value={stats.screenings_recorded}
                        />
                        <MiniStat
                          icon={<Calendar className="w-3.5 h-3.5" />}
                          label="Consultations"
                          value={stats.consultations_held}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Performance */}
        <div className="card">
          <div className="card-header">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Stethoscope className="w-5 h-5 text-primary-500" />
              Performance
            </h2>
            <select
              className="select w-44"
              value={period}
              onChange={(e) => setPeriod(parseInt(e.target.value, 10))}
            >
              {PERIOD_OPTIONS.map((option) => (
                <option key={option.days} value={option.days}>{option.label}</option>
              ))}
            </select>
          </div>

          {performance.length === 0 && !loading ? (
            <p className="text-sm text-gray-500 py-6 text-center">
              No activity recorded in this period.
            </p>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Team member</th>
                    <th>Role</th>
                    <th>Prescriptions filled</th>
                    <th>Screenings recorded</th>
                    <th>Consultations held</th>
                  </tr>
                </thead>
                <tbody>
                  {performance.map((row) => (
                    <tr key={row.id} className={row.is_active ? '' : 'opacity-60'}>
                      <td>
                        <div className="font-medium text-gray-900">
                          {row.first_name} {row.last_name}
                        </div>
                      </td>
                      <td>
                        <span className={ROLE_BADGE[row.role] || 'badge-neutral'}>
                          {ROLE_LABEL[row.role] || row.role}
                        </span>
                      </td>
                      <td className="font-semibold">{row.prescriptions_filled}</td>
                      <td className="font-semibold">{row.screenings_recorded}</td>
                      <td className="font-semibold">{row.consultations_held}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-gray-400 mt-3">
            Sales and product-profitability reporting arrive with the point-of-sale module; these figures
            cover prescriptions, screenings and consultations only.
          </p>
        </div>

        {/* RBAC reference */}
        <div className="card">
          <div className="card-header">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-primary-500" />
              What each role can do
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {ROLE_CAPABILITIES.map((entry) => (
              <div key={entry.role} className="p-4 rounded-xl bg-gray-50">
                <h3 className="text-sm font-semibold text-gray-900">{entry.role}</h3>
                <ul className="mt-2 space-y-1.5">
                  {entry.can.map((item) => (
                    <li key={item} className="text-xs text-gray-600 flex items-start gap-1.5">
                      <span className="text-green-600 mt-0.5">✓</span>
                      <span>{item}</span>
                    </li>
                  ))}
                  {(entry.cannot || []).map((item) => (
                    <li key={item} className="text-xs text-gray-500 flex items-start gap-1.5">
                      <span className="text-red-400 mt-0.5">✕</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>

      <AddStaffModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={async (result) => {
          setAddOpen(false);
          setCreated(result);
          await load();
        }}
      />

      <Modal
        open={!!created}
        onClose={() => setCreated(null)}
        title="Share these credentials"
        description="This temporary password is shown only once"
        size="sm"
        footer={
          <button className="btn-primary btn-sm" onClick={() => setCreated(null)}>
            Done
          </button>
        }
      >
        {created && (
          <div className="space-y-3 text-sm">
            <p className="text-gray-600">
              <span className="font-medium text-gray-900">{created.name}</span> can now sign in with their
              email address and the temporary password below. Ask them to change it immediately in Settings.
            </p>
            <div className="p-3 rounded-xl bg-gray-50 space-y-1.5 font-mono text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-gray-500">Email</span>
                <span className="text-gray-900 break-all">{created.email}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-gray-500 flex items-center gap-1"><KeyRound className="w-3.5 h-3.5" /> Password</span>
                <span className="text-gray-900">{created.password}</span>
              </div>
            </div>
            <button
              className="btn-secondary btn-sm w-full"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`${created.email}\n${created.password}`);
                  toast.success('Credentials copied');
                } catch {
                  toast.error('Could not access the clipboard — copy the details manually');
                }
              }}
            >
              <Copy className="w-4 h-4" />
              Copy credentials
            </button>
            <p className="text-xs text-gray-400">
              No email is sent automatically — email delivery is not connected to a provider yet.
            </p>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!pendingToggle}
        onClose={() => setPendingToggle(null)}
        onConfirm={toggleActive}
        busy={toggling}
        tone={pendingToggle?.is_active ? 'danger' : 'primary'}
        title={pendingToggle?.is_active ? 'Suspend staff access' : 'Restore staff access'}
        message={
          pendingToggle
            ? pendingToggle.is_active
              ? `${pendingToggle.first_name} ${pendingToggle.last_name} will no longer be able to sign in. Their historical records are kept.`
              : `${pendingToggle.first_name} ${pendingToggle.last_name} will be able to sign in again with their existing password.`
            : ''
        }
        confirmLabel={pendingToggle?.is_active ? 'Suspend access' : 'Restore access'}
      />
    </DashboardLayout>
  );
}

function MiniStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-gray-400">{icon}</span>
      <div>
        <div className="text-sm font-semibold text-gray-900">{value}</div>
        <div className="text-2xs text-gray-400">{label}</div>
      </div>
    </div>
  );
}

function AddStaffModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (result: { name: string; email: string; password: string }) => void;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState('staff');
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setFirstName('');
      setLastName('');
      setEmail('');
      setPhone('');
      setRole('staff');
      setTouched(false);
    }
  }, [open]);

  const errors = {
    first_name: firstName.trim() === '' ? 'First name is required' : '',
    last_name: lastName.trim() === '' ? 'Last name is required' : '',
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? '' : 'Enter a valid email address',
  };
  const hasErrors = Object.values(errors).some(Boolean);

  const handleSubmit = async () => {
    setTouched(true);
    if (hasErrors) return;

    setSubmitting(true);
    try {
      const response = await api.post('/pharmacies/staff', {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        role,
      });
      onCreated({
        name: `${firstName.trim()} ${lastName.trim()}`,
        email: email.trim(),
        password: response.data?.temp_password || '',
      });
    } catch (error: any) {
      toast.error(error?.message || 'Failed to add staff member');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { if (!submitting) onClose(); }}
      title="Add staff member"
      description="They sign in with their email and a temporary password"
      footer={
        <>
          <button className="btn-secondary btn-sm" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={handleSubmit} disabled={submitting}>
            {submitting && <div className="spinner" />}
            Create account
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="label">First name *</label>
            <input
              type="text"
              className={`input ${touched && errors.first_name ? 'input-error' : ''}`}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
            {touched && errors.first_name && (
              <p className="text-xs text-red-600 mt-1">{errors.first_name}</p>
            )}
          </div>
          <div>
            <label className="label">Last name *</label>
            <input
              type="text"
              className={`input ${touched && errors.last_name ? 'input-error' : ''}`}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
            {touched && errors.last_name && (
              <p className="text-xs text-red-600 mt-1">{errors.last_name}</p>
            )}
          </div>
        </div>

        <div>
          <label className="label">Email *</label>
          <input
            type="email"
            className={`input ${touched && errors.email ? 'input-error' : ''}`}
            placeholder="name@pharmacy.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {touched && errors.email && <p className="text-xs text-red-600 mt-1">{errors.email}</p>}
        </div>

        <div>
          <label className="label">Phone</label>
          <input
            type="tel"
            className="input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>

        <div>
          <label className="label">Role</label>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="staff">Sales / cashier — no stock or staff changes</option>
            <option value="pharmacist">Pharmacist — can manage stock and clinical records</option>
          </select>
          <p className="text-xs text-gray-400 mt-1">
            Only the pharmacy owner can be given the owner role, and it cannot be assigned here.
          </p>
        </div>
      </div>
    </Modal>
  );
}
