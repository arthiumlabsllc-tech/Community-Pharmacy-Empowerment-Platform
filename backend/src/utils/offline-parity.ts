import fs from 'fs';
import path from 'path';
import {
  computeSaleTax,
  round2,
  toVatTreatment,
  type PricingMode,
  type TaxRates,
} from './ghana-tax';

/**
 * The parity contract between the two pricers.
 *
 * `frontend/src/lib/offline/pricing.ts` decides what a customer owes while the
 * pharmacy has no connection. This module decides what the SAME basket should
 * have come to, using the real engine, and the two are compared against a
 * shared fixture of worked examples.
 *
 * Two consumers:
 *   - backend/src/__tests__/offline-parity.test.ts, which fails if the server
 *     engine moves away from the stored expectations;
 *   - scripts/emit-parity-vectors.ts, which regenerates those expectations.
 *
 * Both go through `expectedForVector`, so the generator and the test cannot
 * disagree with each other about what "correct" means.
 */

export interface ParityVectorItem {
  quantity: number;
  unitPrice: number;
  /** Deliberately a string, not VatTreatment: one vector feeds it junk. */
  vatTreatment: string;
}

export interface ParityVectorSettings {
  vatRegistered: boolean;
  pricingMode: string;
  rates: Partial<TaxRates> | null;
}

export interface ParityExpectation {
  lineTotals: number[];
  amountsDue: number[];
  subtotal: number;
  grandTotal: number;
  /** The figures the offline pricer deliberately does NOT produce. */
  taxableBase: number;
  exemptAmount: number;
  vat: number;
  nhil: number;
  getfund: number;
  totalTax: number;
}

export interface ParityVector {
  id: string;
  description: string;
  settings: ParityVectorSettings;
  items: ParityVectorItem[];
  expected: ParityExpectation | null;
}

export interface ParityFile {
  readme: string[];
  engine: string;
  generatedBy: string;
  vectors: ParityVector[];
}

/**
 * Resolved from __dirname rather than process.cwd() so the path is correct
 * whether this runs from src under ts-node, from dist after a build, or from
 * jest with a different working directory.
 */
export const VECTORS_PATH = path.resolve(
  __dirname,
  '../../../frontend/src/lib/offline/pricing-vectors.json'
);

export function loadParityFile(): ParityFile {
  const raw = fs.readFileSync(VECTORS_PATH, 'utf8');
  const parsed = JSON.parse(raw) as ParityFile;

  if (!Array.isArray(parsed.vectors) || parsed.vectors.length === 0) {
    throw new Error(`${VECTORS_PATH} contains no vectors`);
  }
  return parsed;
}

export function loadParityVectors(): ParityVector[] {
  return loadParityFile().vectors;
}

/**
 * Runs one vector through the real engine.
 *
 * The line total reproduces buildLine's no-discount path in pos.routes.ts:
 * `gross = round2(quantity * unitPrice)`, `discountAmount = 0`,
 * `lineTotal = round2(gross - 0)`. A discounted basket is not representable
 * here because the offline pricer refuses one outright — reproducing
 * distributeDiscount on the device is exactly the duplication this contract
 * exists to avoid.
 */
export function expectedForVector(vector: ParityVector): ParityExpectation {
  const lines = vector.items.map((item) => {
    const quantity = Math.floor(Number(item.quantity));
    const unitPrice = Number(item.unitPrice);

    return {
      lineTotal: round2(quantity * unitPrice),
      vatTreatment: toVatTreatment(item.vatTreatment),
    };
  });

  const pricingMode: PricingMode =
    vector.settings.pricingMode === 'exclusive' ? 'exclusive' : 'inclusive';

  const tax = computeSaleTax(lines, {
    pricingMode,
    rates: vector.settings.rates,
    vatRegistered: vector.settings.vatRegistered,
  });

  return {
    lineTotals: lines.map((line) => line.lineTotal),
    amountsDue: tax.lines.map((line) => line.grossTotal),
    subtotal: tax.subtotal,
    grandTotal: tax.grandTotal,
    taxableBase: tax.taxableBase,
    exemptAmount: tax.exemptAmount,
    vat: tax.vat,
    nhil: tax.nhil,
    getfund: tax.getfund,
    totalTax: tax.totalTax,
  };
}
