import { RECALL_VERIFY_PATH, writeRecallVerifySql } from '../src/utils/recall-verify-sql';
import { emitHarness } from './emit-harness';

/**
 * Regenerates database/tests/004_recall_verify.sql from the recall query
 * builders, so the SQL the harness runs is the SQL the API sends.
 *
 * Run this after changing backend/src/utils/recall-queries.ts. The file it
 * writes is not a hand-maintained copy: backend/src/__tests__/recall-sql.test.ts
 * re-renders it on every run and fails when the committed copy is stale, so
 * forgetting to regenerate is a broken build rather than a quietly wrong recall.
 *
 *   cd backend && npm run recall:emit
 */
emitHarness({
  label: 'a recall returns',
  target: RECALL_VERIFY_PATH,
  write: writeRecallVerifySql,
  sources: ['backend/src/utils/recall-queries.ts'],
});
