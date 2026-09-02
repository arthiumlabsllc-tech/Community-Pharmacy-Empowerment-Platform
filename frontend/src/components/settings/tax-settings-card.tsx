'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertTriangle, Loader2, Percent, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { usePermissions } from '@/hooks/use-permissions';

interface TaxSettingsData {
  vat_registered: boolean;
  pricing_mode: 'inclusive' | 'exclusive';
  rates: Partial<Record<'vat' | 'nhil' | 'getfund', number>> | null;
  rate_labels?: string[];
  /**
   * Already a percentage (20 for the standard 15 + 2.5 + 2.5 burden), not a
   * fraction — GET /pharmacies/tax-settings multiplies by 100 server-side.
   */
  effective_standard_rate?: number;
  registration_threshold_ghs?: number;
}

/** PUT returns what it stored, which is a different shape to GET. */
interface TaxSettingsSaved {
  tax: {
    vat_registered?: boolean;
    pricing_mode?: string;
    rates?: Partial<Record<'vat' | 'nhil' | 'getfund', number>> | null;
  };
  effective_rates: Partial<Record<'vat' | 'nhil' | 'getfund', number>> | null;
  rate_labels?: string[];
}

/**
 * Ghana tax configuration for the till (Value Added Tax Act, 2025 — Act 1151).
 *
 * Two things are genuinely the pharmacy's decision and both live here:
 *
 * - **VAT registration.** Below the GHS 750,000 turnover threshold a pharmacy
 *   must not charge VAT, NHIL or the GETFund levy at all. Above it, it must.
 *   Turning this off stops every levy being charged, so it is owner-only and
 *   the consequence is spelled out on the card rather than hidden behind a
 *   toggle.
 * - **Pricing mode.** Ghanaian retail prices are advertised tax-inclusive, so
 *   inclusive is the default. Exclusive adds the levies on top of the shelf
 *   price, which would overcharge a customer against the ticket.
 *
 * The rates themselves are shown read-only: they are set by law, and letting a
 * pharmacy type in 5% VAT would produce an under-declared return.
 */
export function TaxSettingsCard() {
  const { canManageTaxSettings } = usePermissions();

  const [data, setData] = useState<TaxSettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [vatRegistered, setVatRegistered] = useState(true);
  const [pricingMode, setPricingMode] = useState<'inclusive' | 'exclusive'>('inclusive');
  const [confirmingOff, setConfirmingOff] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<{ success: boolean; data: TaxSettingsData }>(
        '/pharmacies/tax-settings'
      );
      setData(response.data);
      setVatRegistered(response.data.vat_registered !== false);
      setPricingMode(response.data.pricing_mode === 'exclusive' ? 'exclusive' : 'inclusive');
    } catch (error: any) {
      toast.error(error?.message || 'Failed to load tax settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(next: { vat_registered: boolean; pricing_mode: 'inclusive' | 'exclusive' }) {
    setSaving(true);
    try {
      const response = await api.put<{ success: boolean; message: string; data: TaxSettingsSaved }>(
        '/pharmacies/tax-settings',
        next
      );
      // Read the values back out of what the server actually stored rather than
      // what was sent: the PUT reply is shaped differently to GET, and echoing
      // the request would show a state the server may have normalised away.
      const stored = response.data.tax || {};
      const registered = stored.vat_registered !== false;
      const mode = stored.pricing_mode === 'exclusive' ? 'exclusive' : 'inclusive';

      setVatRegistered(registered);
      setPricingMode(mode);
      setData((previous) =>
        previous
          ? {
              ...previous,
              vat_registered: registered,
              pricing_mode: mode,
              rates: response.data.effective_rates ?? previous.rates,
              rate_labels: response.data.rate_labels ?? previous.rate_labels,
            }
          : previous
      );
      setConfirmingOff(false);
      toast.success(response.message || 'Tax settings saved');
    } catch (error: any) {
      toast.error(error?.message || 'Failed to save tax settings');
      // Revert the toggle so the screen does not claim a state the server rejected.
      load();
    } finally {
      setSaving(false);
    }
  }

  const threshold = data?.registration_threshold_ghs ?? 750000;
  const effective = data?.effective_standard_rate;
  const rateLabels = data?.rate_labels ?? [];
  const dirty =
    vatRegistered !== (data?.vat_registered !== false) ||
    pricingMode !== (data?.pricing_mode === 'exclusive' ? 'exclusive' : 'inclusive');

  return (
    <div className="card">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <Percent className="h-5 w-5 text-primary-500" />
        Ghana tax (Act 1151)
      </h2>
      <p className="mb-4 text-sm text-gray-500">
        Applied to every sale at the till. The rates are set by law and cannot be edited here.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading tax settings…</span>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Rates, read-only */}
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-500">
              <ShieldCheck className="h-3.5 w-3.5" />
              Statutory rates on standard-rated stock
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {(rateLabels.length > 0
                ? rateLabels
                : ['VAT 15%', 'NHIL 2.5%', 'GETFund Levy 2.5%']
              ).map((label) => (
                <span key={label} className="badge-neutral">
                  {label}
                </span>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-500">
              All three are charged on the same taxable value
              {typeof effective === 'number'
                ? `, an effective ${effective % 1 === 0 ? effective.toFixed(0) : effective.toFixed(1)}% on standard-rated goods`
                : ''}
              . Medicines in Chapter 30 of the Harmonised System are exempt under the First
              Schedule; toiletries, cosmetics, devices and food are standard rated. Classification
              is set per product in Inventory.
            </p>
          </div>

          {/* VAT registration */}
          <label
            className={`flex items-start gap-3 rounded-xl border p-3 ${
              vatRegistered ? 'border-gray-200' : 'border-red-200 bg-red-50'
            } ${canManageTaxSettings ? 'cursor-pointer' : 'opacity-70'}`}
          >
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-gray-300 text-primary-600"
              checked={vatRegistered}
              disabled={!canManageTaxSettings || saving}
              onChange={(event) => {
                if (event.target.checked) {
                  setVatRegistered(true);
                  setConfirmingOff(false);
                } else {
                  // Turning VAT off is a serious change: make the consequence
                  // explicit before it can be saved.
                  setConfirmingOff(true);
                }
              }}
            />
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">
                This pharmacy is VAT registered
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                Registration is mandatory above GHS {threshold.toLocaleString()} annual turnover.
                Turn this off only if the pharmacy is below the threshold and not registered.
              </p>

              {confirmingOff && (
                <div className="mt-2 rounded-lg border border-red-300 bg-white p-3">
                  <p className="flex items-start gap-1.5 text-xs font-medium text-red-800">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    <span>
                      No VAT, NHIL or GETFund levy will be charged on <strong>any</strong> sale,
                      including standard-rated stock such as toiletries and devices. The VAT report
                      will keep showing this warning. If the pharmacy is in fact registered, this
                      produces an under-declared return.
                    </span>
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      className="btn-danger btn-sm"
                      disabled={saving}
                      onClick={() => {
                        setVatRegistered(false);
                        setConfirmingOff(false);
                      }}
                    >
                      I understand — we are not registered
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => setConfirmingOff(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </label>

          {/* Pricing mode */}
          <div>
            <p className="label">Shelf pricing</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  {
                    value: 'inclusive',
                    title: 'Tax included in the price',
                    body: 'The shelf price is what the customer pays. Tax is declared from inside it. This is how Ghanaian retail prices are advertised.',
                  },
                  {
                    value: 'exclusive',
                    title: 'Tax added on top',
                    body: 'The levies are added to the shelf price at the till, so the customer pays more than the ticket shows. Only use this if your prices are genuinely net.',
                  },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={!canManageTaxSettings || saving}
                  onClick={() => setPricingMode(option.value)}
                  className={`rounded-xl border-2 p-3 text-left transition ${
                    pricingMode === option.value
                      ? 'border-primary-500 bg-primary-50'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  } ${canManageTaxSettings ? '' : 'cursor-not-allowed opacity-70'}`}
                >
                  <p className="text-sm font-medium text-gray-900">{option.title}</p>
                  <p className="mt-0.5 text-xs text-gray-500">{option.body}</p>
                </button>
              ))}
            </div>
          </div>

          {canManageTaxSettings ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-primary btn-sm"
                disabled={saving || !dirty || confirmingOff}
                onClick={() => save({ vat_registered: vatRegistered, pricing_mode: pricingMode })}
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Save tax settings
              </button>
              {!dirty && <span className="text-xs text-gray-400">No changes</span>}
              {confirmingOff && (
                <span className="text-xs text-red-600">Confirm the warning above first</span>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-500">
              Only the pharmacy owner can change tax settings. Changes here affect every sale
              recorded at the till.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
