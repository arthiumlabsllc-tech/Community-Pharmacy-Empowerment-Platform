'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { usePharmacyStore } from '@/store/pharmacy-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { usePermissions } from '@/hooks/use-permissions';
import { GlobalSearch } from './global-search';
import { NotificationBell } from './notification-bell';
import { LanguageSelect } from './language-select';
import {
  LayoutDashboard, Package, Users, FileText,
  Calendar, Activity, CreditCard, Settings, UserCog,
  Menu, X, LogOut,
} from 'lucide-react';

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** When set, the link is only rendered for these roles. */
  roles?: string[];
}

const navItems: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/inventory', label: 'Inventory', icon: Package },
  { href: '/patients', label: 'Patients', icon: Users },
  { href: '/claims', label: 'NHIS Claims', icon: FileText },
  { href: '/consultations', label: 'Consultations', icon: Calendar },
  { href: '/screenings', label: 'Health Screenings', icon: Activity },
  { href: '/staff', label: 'Staff', icon: UserCog, roles: ['pharmacy_owner', 'pharmacist'] },
  { href: '/subscription', label: 'Subscription', icon: CreditCard },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const ROLE_LABEL: Record<string, string> = {
  pharmacy_owner: 'Owner',
  pharmacist: 'Pharmacist',
  staff: 'Staff',
  super_admin: 'Administrator',
};

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();
  const hydrated = useHydrated();
  const { user, pharmacy, logout } = useAuthStore();
  const { role } = usePermissions();
  const fetchProfile = usePharmacyStore((state) => state.fetchProfile);
  const profileLoaded = usePharmacyStore((state) => state.loaded);

  // Load the pharmacy record once per session so the notification bell and the
  // settings page share the same stored preferences.
  useEffect(() => {
    if (hydrated && user && !profileLoaded) fetchProfile();
  }, [hydrated, user, profileLoaded, fetchProfile]);

  // Close the mobile drawer whenever the route changes
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  const visibleNavItems = navItems.filter(
    (item) => !item.roles || (role !== undefined && item.roles.includes(role))
  );

  const handleLogout = () => {
    logout();
    window.location.href = '/login';
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`fixed top-0 left-0 z-50 h-full w-[260px] bg-white border-r border-gray-200 transform transition-transform duration-200 ease-in-out lg:translate-x-0 ${
        sidebarOpen ? 'translate-x-0' : '-translate-x-full'
      }`}>
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-9 h-9 bg-primary-500 rounded-xl flex items-center justify-center">
                <span className="text-white font-bold text-lg">P</span>
              </div>
              <div>
                <div className="font-bold text-sm text-gray-900 leading-none">Pharmacy</div>
                <div className="text-2xs text-gray-500">Empowerment</div>
              </div>
            </Link>
            <button
              className="lg:hidden p-1.5 rounded-lg hover:bg-gray-100"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close navigation"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
            {visibleNavItems.map((item) => {
              const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={isActive ? 'nav-item-active' : 'nav-item'}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon className="w-5 h-5 flex-shrink-0" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>

          {/* User Card */}
          <div className="p-4 border-t border-gray-100">
            <div className="flex items-center gap-3 p-2 rounded-xl hover:bg-gray-50">
              <div className="w-9 h-9 bg-primary-100 rounded-full flex items-center justify-center flex-shrink-0">
                <span className="text-primary-700 font-semibold text-sm">
                  {user?.first_name?.[0]}{user?.last_name?.[0]}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 truncate">
                  {user?.first_name} {user?.last_name}
                </div>
                <div className="text-2xs text-gray-500 truncate">
                  {role && ROLE_LABEL[role] ? ROLE_LABEL[role] : ''}
                  {pharmacy?.name ? ` · ${pharmacy.name}` : ''}
                </div>
              </div>
              <button
                onClick={handleLogout}
                aria-label="Sign out"
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 flex-shrink-0"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="lg:ml-[260px]">
        {/* Top Bar */}
        <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-gray-200">
          <div className="flex items-center justify-between gap-3 px-4 sm:px-6 h-16">
            <div className="flex items-center gap-3 min-w-0">
              <button
                className="lg:hidden p-2 rounded-lg hover:bg-gray-100 flex-shrink-0"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open navigation"
              >
                <Menu className="w-5 h-5" />
              </button>

              <GlobalSearch />
            </div>

            <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
              <LanguageSelect />
              <NotificationBell />
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="p-4 sm:p-6 lg:p-8 max-w-7xl">
          {children}
        </main>
      </div>
    </div>
  );
}
