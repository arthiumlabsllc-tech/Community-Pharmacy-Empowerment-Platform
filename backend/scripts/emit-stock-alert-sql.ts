import {
  STOCK_ALERT_VERIFY_PATH,
  writeStockAlertVerifySql,
} from '../src/utils/stock-alert-verify-sql';
import { emitHarness } from './emit-harness';

/**
 * Regenerates database/tests/005_stock_alerts_verify.sql from the notification
 * builders, so the SQL the harness runs is the SQL the API sends.
 *
 * Run this after changing backend/src/utils/stock-alerts.ts (the writer) or
 * backend/src/utils/notification-queries.ts (the reader). As with the recall
 * harness, backend/src/__tests__/stock-alerts.test.ts re-renders the file and
 * fails when the committed copy is stale.
 *
 *   cd backend && npm run alerts:emit
 */
emitHarness({
  label: 'the stock alerts and the notification reader write',
  target: STOCK_ALERT_VERIFY_PATH,
  write: writeStockAlertVerifySql,
  sources: [
    'backend/src/utils/stock-alerts.ts',
    'backend/src/utils/notification-queries.ts',
  ],
});
