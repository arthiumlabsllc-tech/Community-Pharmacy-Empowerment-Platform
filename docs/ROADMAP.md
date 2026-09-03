# Roadmap

Where the platform actually stands, and what is next. Written to be checked
against the code rather than trusted — every claim here names the file or the
table it came from.

Last verified: backend `tsc` clean, 405 tests passing (11 suites); frontend
`tsc` clean, 433 tests passing (15 suites), `next build` producing 20 routes
with `/patients/[id]` compiled for the edge runtime.

---

## Blocked right now: three unapplied migrations

All three below need pasting into the **Supabase SQL editor** in order, and
until they are, the newer features stay dark in production:

| Migration | What it unlocks |
|---|---|
| `database/migrations/001_pos.sql` | `sales`, `sale_items`, `sale_payments`, `inventory.vat_treatment` — every `/api/pos/*` route |
| `database/migrations/002_offline_sync.sql` | `idempotency_keys` — replay protection for writes queued during an outage |
| `database/migrations/003_inventory_batches.sql` | `inventory_batches`, `sale_item_batches`, the derived-stock triggers — batch/lot tracking, FEFO rotation, recall traceability, stock alerts |

**Deploying before migrating is safe but the features stay dark.** The code was
built to degrade honestly rather than fail confusingly: batch and recall
endpoints return `501` with a message naming the migration, the UI catches that
status and shows a panel explaining what is missing and what still works, and
the notification bell falls back to deriving alerts from the stock figures it
can still read. Nothing 500s and nothing pretends to have data it does not.

`003` is safe to re-run: its backfill skips any product that already has a
batch, so it will not duplicate stock.

A second blocker sat in the deploy rather than the data, and was more complete
than this one: Cloudflare Pages had been failing the build outright because
`/patients/[id]` did not declare the edge runtime, so **nothing committed after
`0f73eb2` had reached production at all** — not the POS, not offline selling,
not batch tracking. The export is in place and the reason is written up in
`docs/DEPLOYMENT.md`; what is not yet confirmed is a green Cloudflare build,
because `next-on-pages` cannot run on Windows.

---

## Done

| Module | Status |
|---|---|
| **POS & Payments** | Touch-optimised till, split payments, Ghana VAT under Act 1151 (in force 1 Jan 2026: VAT 15% + NHIL 2.5% + GETFund 2.5%, HS Chapter 30 pharmaceuticals exempt, GHS 750,000 threshold). Paystack MoMo/card with an honest manual fallback when the gateway is not configured. Sales history, receipts, and sales/profitability/staff/VAT-return reports. |
| **Offline-first** | Sells through an outage into a local queue with a provisional receipt, then syncs. Device pricing is held to a parity fixture the backend test suite re-verifies, so the two engines cannot drift. A review page offers retry and explicit discard — nothing is silently dropped. |
| **Inventory** | Batch/lot tracking with FEFO rotation enforced by database triggers, receive/adjust/write-off with a mandatory written reason, stock and expiry alerts written into notifications and deduped against history, and recall traceability. |
| **Recall traceability** | `/recall` answers both halves: what to take off the shelf, and who to phone. Lines are labelled as traced through the batch ledger or merely matched on a receipt's lot number, because the two are not equally trustworthy. |
| **Staff & analytics** | RBAC separating owner, pharmacist and staff, mirrored client-side in `hooks/use-permissions.ts` against each route's `authorize()`. Reports gate on the same roles server-side. |
| **Patient engagement** | Patient profiles, history, BP and blood-sugar screenings. Refill reminders exist **as data only** — see Priority 5. |

---

## Priority 5 — Real SMS

**What already exists.** The `reminders` table (`database/init.sql:505`) is
complete and ready: `scheduled_at`, `sent_at`, `status` defaulting to
`'pending'`, `recurrence`, `is_active`, and an index on `scheduled_at`. A
`NotificationChannel` enum already carries `'sms'`. Twilio credentials are
already read from the environment in `backend/src/config/index.ts`. The stock
alert writer even leaves a note that a future SMS worker should be able to say
where an alert came from.

**What does not exist.** Anything that sends one, and anything that runs on a
schedule.

> **Correct the README when doing this.** Its architecture diagram advertises
> "Background Jobs (Bull)" and its tech stack lists Bull and Prisma. Neither is
> installed: there is no queue, no cron and no worker anywhere in the backend,
> and the data layer is raw `pg`, not Prisma. `nhis.routes.ts:87` carries a
> commented-out `claimQueue.add(...)` with the note "Until that exists the claim
> only lives in this database."

**The real first step is choosing the scheduler**, because both this priority
and the next one need it and the answer constrains both:

- Redis is already in the stack for caching, so **BullMQ** is the least new
  infrastructure and gives retries, backoff and a visible delayed-job queue —
  which matters because a reminder that silently fails to send is worse than
  one that is visibly stuck.
- **node-cron in the API process** is simpler but ties sending to the web
  process's lifetime, and on Render a sleeping free-tier instance will not fire
  a timer at all.
- A **separate worker service** is the most robust and the most to operate.

Then, in order:

1. A provider client behind an interface, so the send is testable without a
   network call and a Ghanaian provider (Hubtel, Arkesel, Nalo) can be swapped
   for Twilio without touching callers. Twilio is configured but is not the
   obvious choice for Ghanaian numbers — confirm pricing and sender-ID
   registration before committing to it.
2. A worker that claims due reminders with a `FOR UPDATE SKIP LOCKED` read, so
   two workers cannot send the same reminder twice, and stamps `sent_at` and
   `status`.
3. Delivery-status handling. A reminder marked sent that was not delivered is a
   lie the pharmacy acts on — record the provider's response, and surface
   failures rather than only successes.
4. Recurrence: `recurrence` is already a column, so a monthly refill reminder
   needs to reschedule itself rather than be re-created.
5. Refill reminders derived from dispensing history, which is the engagement
   feature the module description actually promises.

---

## Priority 6 — Staff UI and real ClaimsIT

`/staff` and `/claims` pages both build and render today; this is about making
them true rather than creating them.

**Claims.** `nhis.routes.ts` records a claim in the local `nhis_claims` table
and stops there — the submission to ClaimsIT is the commented-out queue call.
The targets this module was sold on (reimbursement 45 days to under 14,
rejection 6–10% down to 1–3%) are only reachable with the real integration, and
neither can be claimed until it exists. Needs: ClaimsIT endpoint and credential
discovery, submission through whichever queue Priority 5 chose, acknowledgement
and rejection-reason handling, and a retry path that cannot double-submit a
claim.

**Staff.** The role separation and the performance reporting are real and
tested. What is missing is the management surface around them — inviting and
deactivating users, and the shift- and branch-level views a pharmacy owner
actually runs a rota with.
