'use client';

import { useEffect, useRef, useState } from 'react';
import { Languages, Check, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth-store';
import { useHydrated } from '@/hooks/use-hydrated';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'tw', label: 'Twi' },
  { code: 'ee', label: 'Ewe' },
];

/**
 * Language preference picker. It writes to users.preferred_language through
 * PUT /auth/profile so the choice follows the signed-in user across devices.
 *
 * The dashboard copy itself is English-only for now — the stored preference is
 * what patient-facing communication (SMS, printed receipts) will be generated
 * in once those templates are localised.
 */
export function LanguageSelect() {
  const hydrated = useHydrated();
  const user = useAuthStore((state) => state.user);
  const updateUser = useAuthStore((state) => state.updateUser);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const current = user?.preferred_language || 'en';

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  const select = async (code: string) => {
    setOpen(false);
    if (code === current) return;

    setSaving(code);
    try {
      const response = await api.put('/auth/profile', { preferred_language: code });
      updateUser(response.data || { preferred_language: code });
      toast.success(`Language set to ${LANGUAGES.find((l) => l.code === code)?.label}`);
    } catch {
      toast.error('Could not save your language preference');
    } finally {
      setSaving(null);
    }
  };

  if (!hydrated) {
    return <div className="w-[38px] h-[38px] rounded-xl" aria-hidden />;
  }

  const activeLabel = LANGUAGES.find((language) => language.code === current)?.label ?? 'English';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={`Language: ${activeLabel}`}
        aria-expanded={open}
        className="flex items-center gap-1.5 p-2 rounded-xl hover:bg-gray-100 text-gray-600"
      >
        {saving ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Languages className="w-4 h-4" />
        )}
        <span className="hidden sm:inline text-xs font-medium">{current.toUpperCase()}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-56 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden animate-fade-in">
          <div className="px-4 py-2.5 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">Language</h2>
            <p className="text-2xs text-gray-500 mt-0.5">
              Saved to your profile. The dashboard is English only for now — this sets the language
              for patient messages.
            </p>
          </div>
          <ul className="py-1">
            {LANGUAGES.map((language) => (
              <li key={language.code}>
                <button
                  type="button"
                  onClick={() => select(language.code)}
                  disabled={saving !== null}
                  className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-gray-50 disabled:opacity-60"
                >
                  <span
                    className={`text-sm ${
                      language.code === current ? 'font-semibold text-primary-700' : 'text-gray-700'
                    }`}
                  >
                    {language.label}
                  </span>
                  {language.code === current && <Check className="w-4 h-4 text-primary-600" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
