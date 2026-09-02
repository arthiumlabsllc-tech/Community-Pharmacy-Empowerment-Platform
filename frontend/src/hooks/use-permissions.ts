'use client';

import { useAuthStore } from '@/store/auth-store';

/**
 * Client-side mirror of the backend's `authorize()` role checks.
 * Hiding an action the API would reject keeps the UI honest — the server
 * remains the source of truth.
 */
export function usePermissions() {
  const role = useAuthStore((state) => state.user?.role);

  const isOwner = role === 'pharmacy_owner';
  const isPharmacist = role === 'pharmacist';
  const isStaff = role === 'staff';
  const isSuperAdmin = role === 'super_admin';

  return {
    role,
    isOwner,
    isPharmacist,
    isStaff,
    isSuperAdmin,
    // Inventory writes: pharmacy_owner + pharmacist (see authorize() on POST/PUT /inventory)
    canEditInventory: isOwner || isPharmacist,
    // Inventory deletes are owner-only (see authorize() on DELETE /inventory/:id)
    canDeleteInventory: isOwner,
    // Staff directory + performance reporting: owner and pharmacist only
    // (see authorize() on GET /pharmacies/staff and /staff-performance)
    canViewStaff: isOwner || isPharmacist,
    canManageStaff: isOwner,
    canManageSubscription: isOwner,
  };
}
