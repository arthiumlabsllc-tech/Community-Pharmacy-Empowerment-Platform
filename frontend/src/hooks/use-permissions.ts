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
    // Till: anyone signed in may sell, but voiding restocks the shelf and is
    // restricted to owner + pharmacist (see authorize() on POST /pos/sales/:id/void)
    canUsePos: true,
    canVoidSale: isOwner || isPharmacist,
    // Sales reports expose cost price, margin and named staff performance
    // (see authorize() on /pos/reports)
    canViewSalesReports: isOwner || isPharmacist,
    // A recall trace is a list of named patients with their telephone numbers,
    // which is what a recall needs and what a cashier at the till has no
    // business pulling up (see authorize() on GET /inventory/recall)
    canTraceRecall: isOwner || isPharmacist,
    // Tax configuration is owner-only (see authorize() on PUT /pharmacies/tax-settings)
    canManageTaxSettings: isOwner,
  };
}
