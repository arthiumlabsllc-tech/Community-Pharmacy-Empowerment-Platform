/* eslint-disable no-console */
import fs from 'fs';
import {
  VECTORS_PATH,
  expectedForVector,
  loadParityFile,
} from '../src/utils/offline-parity';

/**
 * Regenerates the `expected` block of every parity vector using the real Ghana
 * tax engine, and rewrites frontend/src/lib/offline/pricing-vectors.json.
 *
 * Run this after changing backend/src/utils/ghana-tax.ts. It is not a
 * convenience wrapper around a guess: the values it writes come from
 * computeSaleTax itself, so the fixture records what the server actually does.
 *
 * The frontend test then holds the offline pricer to those numbers, and
 * backend/src/__tests__/offline-parity.test.ts holds this file honest by
 * recomputing them on every run — so regenerating without a real engine change
 * is a no-op, and forgetting to regenerate after one is a failing build.
 *
 *   cd backend && npm run parity:emit
 */
function main(): void {
  const file = loadParityFile();
  const changed: string[] = [];

  for (const vector of file.vectors) {
    const expected = expectedForVector(vector);
    if (JSON.stringify(vector.expected) !== JSON.stringify(expected)) {
      changed.push(vector.id);
    }
    vector.expected = expected;
  }

  fs.writeFileSync(VECTORS_PATH, `${JSON.stringify(file, null, 2)}\n`, 'utf8');

  console.log(`Wrote ${file.vectors.length} parity vectors to ${VECTORS_PATH}`);
  if (changed.length === 0) {
    console.log('No expectations changed — the engine still agrees with the fixture.');
    return;
  }

  console.log(`Updated ${changed.length} expectation(s):`);
  for (const id of changed) {
    const vector = file.vectors.find((candidate) => candidate.id === id)!;
    console.log(`  - ${id}: grandTotal ${vector.expected?.grandTotal}`);
  }
  console.log(
    '\nIf you did not intend to change how a basket is priced, revert this file.\n' +
      'If you did, run the frontend pricing tests: they will now fail until\n' +
      'frontend/src/lib/offline/pricing.ts is brought back into agreement.'
  );
}

main();
