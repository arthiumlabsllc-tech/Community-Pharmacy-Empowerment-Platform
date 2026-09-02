'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Users, Package, Loader2, CornerDownLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

interface PatientHit {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  nhis_number: string | null;
}

interface InventoryHit {
  id: string;
  product_name: string;
  generic_name: string | null;
  quantity: number;
  unit_price: string | number;
}

interface Result {
  key: string;
  group: 'patient' | 'inventory';
  title: string;
  detail: string;
  href: string;
}

const PER_GROUP = 5;

/**
 * Top-bar search across the two record types staff actually look up mid-task:
 * patients and stock. Results are grouped and each one deep-links to the page
 * that owns it, so nothing here is a dead control.
 */
export function GlobalSearch() {
  const router = useRouter();
  const hydrated = useHydrated();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const debouncedTerm = useDebouncedValue(term.trim(), 300);

  const search = useCallback(async () => {
    if (!debouncedTerm) {
      setResults([]);
      return;
    }

    setLoading(true);
    try {
      const query = encodeURIComponent(debouncedTerm);
      const [patientResponse, inventoryResponse] = await Promise.allSettled([
        api.get(`/patients?limit=${PER_GROUP}&search=${query}`),
        api.get(`/inventory?limit=${PER_GROUP}&search=${query}`),
      ]);

      const merged: Result[] = [];

      if (patientResponse.status === 'fulfilled') {
        const patients: PatientHit[] = patientResponse.value.data || [];
        patients.forEach((patient) => {
          merged.push({
            key: `patient-${patient.id}`,
            group: 'patient',
            title: `${patient.first_name} ${patient.last_name}`,
            detail: patient.nhis_number
              ? `NHIS ${patient.nhis_number} · ${patient.phone}`
              : patient.phone,
            href: `/patients/${patient.id}`,
          });
        });
      }

      if (inventoryResponse.status === 'fulfilled') {
        const items: InventoryHit[] = inventoryResponse.value.data || [];
        items.forEach((item) => {
          merged.push({
            key: `inventory-${item.id}`,
            group: 'inventory',
            title: item.product_name,
            detail: `${item.generic_name ? item.generic_name + ' · ' : ''}${item.quantity} in stock · GHS ${Number(item.unit_price).toFixed(2)}`,
            href: `/inventory?q=${encodeURIComponent(item.product_name)}`,
          });
        });
      }

      setResults(merged);
      setActiveIndex(0);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [debouncedTerm]);

  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    search();
  }, [hydrated, isAuthenticated, search]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Cmd/Ctrl+K focuses the field from anywhere in the dashboard
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', handleShortcut);
    return () => document.removeEventListener('keydown', handleShortcut);
  }, []);

  const goTo = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (results.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const result = results[activeIndex];
      if (result) goTo(result.href);
    }
  };

  const groups: { key: Result['group']; label: string; icon: typeof Users }[] = [
    { key: 'patient', label: 'Patients', icon: Users },
    { key: 'inventory', label: 'Inventory', icon: Package },
  ];

  return (
    <div ref={containerRef} className="relative w-40 sm:w-72">
      <div
        className={`flex items-center gap-2 bg-gray-100 rounded-xl px-3 py-2 transition-shadow ${
          open ? 'ring-2 ring-primary-200 bg-white' : ''
        }`}
      >
        <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search patients, stock..."
          aria-label="Search patients and inventory"
          className="bg-transparent text-sm outline-none w-full placeholder:text-gray-400"
        />
        {loading && <Loader2 className="w-3.5 h-3.5 text-gray-400 animate-spin flex-shrink-0" />}
        {!loading && (
          <kbd className="hidden md:inline-flex items-center px-1.5 py-0.5 rounded border border-gray-200 bg-white text-[10px] font-medium text-gray-400 flex-shrink-0">
            Ctrl K
          </kbd>
        )}
      </div>

      {open && debouncedTerm && (
        <div className="absolute left-0 z-40 mt-2 w-[340px] max-w-[calc(100vw-2rem)] bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden animate-fade-in">
          {loading && results.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Searching...
            </div>
          ) : results.length === 0 ? (
            <div className="py-8 px-4 text-center text-sm text-gray-500">
              No patients or products match &ldquo;{debouncedTerm}&rdquo;
            </div>
          ) : (
            <div className="max-h-[380px] overflow-y-auto">
              {groups.map((group) => {
                const groupResults = results.filter((result) => result.group === group.key);
                if (groupResults.length === 0) return null;
                const GroupIcon = group.icon;

                return (
                  <div key={group.key}>
                    <div className="flex items-center gap-1.5 px-4 pt-2.5 pb-1 text-2xs font-semibold uppercase tracking-wide text-gray-400">
                      <GroupIcon className="w-3 h-3" />
                      {group.label}
                    </div>
                    {groupResults.map((result) => {
                      const index = results.indexOf(result);
                      return (
                        <button
                          key={result.key}
                          type="button"
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => goTo(result.href)}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 text-left ${
                            index === activeIndex ? 'bg-primary-50' : 'hover:bg-gray-50'
                          }`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-gray-900 truncate">
                              {result.title}
                            </span>
                            <span className="block text-xs text-gray-500 truncate">
                              {result.detail}
                            </span>
                          </span>
                          {index === activeIndex && (
                            <CornerDownLeft className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
