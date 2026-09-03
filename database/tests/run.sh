#!/usr/bin/env bash
# Applies init.sql and every migration to a throwaway database, then runs the
# verification harness. Exits non-zero on the first failure.
set -uo pipefail

PSQL="psql -v ON_ERROR_STOP=1 -U postgres -d pharmacy -q"
fail=0

run() {
  local label="$1" file="$2"
  if out=$($PSQL -f "$file" 2>&1); then
    echo "OK   $label"
  else
    echo "FAIL $label"
    echo "$out" | tail -20
    fail=1
  fi
}

run "init.sql"                 /tmp/init.sql
run "001_pos.sql"              /tmp/001.sql
run "002_offline_sync.sql"     /tmp/002.sql
run "003_inventory_batches.sql" /tmp/003.sql
# A migration the user pastes by hand will sometimes be pasted twice.
run "003 applied a second time" /tmp/003.sql
run "003_verify.sql"           /tmp/verify.sql
# Both of these are generated from the query builders — see recall:emit and
# alerts:emit. Every harness rolls back, so re-running one for its notices
# cannot disturb the next.
run "004_recall_verify.sql"    /tmp/004_recall_verify.sql
run "005_stock_alerts_verify.sql" /tmp/005_stock_alerts_verify.sql

echo "---- notices from the harnesses ----"
for harness in /tmp/verify.sql /tmp/004_recall_verify.sql /tmp/005_stock_alerts_verify.sql; do
  echo "== $(basename "$harness")"
  $PSQL -f "$harness" 2>&1 >/dev/null | grep -E "NOTICE|ERROR" || true
done

exit $fail
