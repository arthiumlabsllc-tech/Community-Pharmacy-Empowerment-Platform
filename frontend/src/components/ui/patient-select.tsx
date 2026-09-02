'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, User, Check, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

export interface PatientOption {
  id: string;
  first_name: string;
  last_name: string;
  nhis_number: string | null;
  phone: string;
}

interface PatientSelectProps {
  value: PatientOption | null;
  onChange: (patient: PatientOption | null) => void;
  label?: string;
  placeholder?: string;
  invalid?: boolean;
}

/**
 * Searchable patient picker backed by GET /patients?search=.
 * Used by the claims, consultations and screenings forms.
 */
export function PatientSelect({
  value,
  onChange,
  label = 'Patient',
  placeholder = 'Search by name, NHIS number or phone...',
  invalid = false,
}: PatientSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<PatientOption[]>([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const debouncedSearch = useDebouncedValue(search, 350);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const response = await api.get(
          `/patients?limit=10&search=${encodeURIComponent(debouncedSearch)}`
        );
        if (!cancelled) setResults(response.data || []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [debouncedSearch, open]);

  // Close the dropdown when clicking outside of it
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fullName = (p: PatientOption) => `${p.first_name} ${p.last_name}`;

  if (value) {
    return (
      <div>
        <label className="label">{label}</label>
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-primary-200 bg-primary-50">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
              <span className="text-primary-700 font-semibold text-sm">
                {value.first_name?.[0]}{value.last_name?.[0]}
              </span>
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900 truncate">{fullName(value)}</div>
              <div className="text-xs text-gray-500 truncate">
                {value.nhis_number ? `NHIS: ${value.nhis_number}` : value.phone}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => { onChange(null); setSearch(''); }}
            aria-label="Clear selected patient"
            className="p-2 rounded-lg hover:bg-white text-gray-400 flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <label className="label">{label}</label>
      <div
        className={`flex items-center gap-2 bg-white border rounded-xl px-4 py-3 ${
          invalid ? 'border-red-500' : 'border-gray-300'
        }`}
        onClick={() => setOpen(true)}
      >
        <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
        <input
          type="text"
          className="flex-1 text-sm outline-none bg-transparent"
          placeholder={placeholder}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
        />
      </div>

      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg max-h-64 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-gray-500">
              <div className="spinner" /> Searching...
            </div>
          ) : results.length === 0 ? (
            <div className="py-6 text-center text-sm text-gray-500">
              No patients match &ldquo;{debouncedSearch}&rdquo;
            </div>
          ) : (
            results.map((patient) => (
              <button
                key={patient.id}
                type="button"
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 text-left border-b border-gray-50 last:border-0"
                onClick={() => {
                  onChange(patient);
                  setOpen(false);
                  setSearch('');
                }}
              >
                <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                  <User className="w-4 h-4 text-gray-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">{fullName(patient)}</div>
                  <div className="text-xs text-gray-500 truncate">
                    {patient.nhis_number ? `NHIS: ${patient.nhis_number} · ` : ''}{patient.phone}
                  </div>
                </div>
                <Check className="w-4 h-4 text-gray-300 flex-shrink-0" />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
