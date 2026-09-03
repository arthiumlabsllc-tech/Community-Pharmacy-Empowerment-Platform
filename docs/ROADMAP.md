# Roadmap

Where the platform actually stands, and what is next. Written to be checked
against the code rather than trusted — every claim here names the file or the
table it came from.

Last verified: backend `tsc` clean, 405 tests passing (11 suites); frontend
`tsc` clean, 433 tests passing (15 suites), `next build` producing 20 routes
with `/patients/[id]` server-rendered on demand. Production probed live on
2026-09-03.

---

## In flight: the frontend is moving from Cloudflare Pages to Vercel

Cloudflare Pages could not deploy this app reliably. `0f73eb2` added
`/patients/[id]`, the first dynamically rendered route, and every build from
that commit onward failed the `next-on-pages` edge-runtime gate — so
`https://community-pharmacy-empowerment-platform.pages.dev` froze on
**`197da45`**, the commit immediately before it, while seven later commits sat
undeployed on GitHub. Established against the live site rather than assumed:

| Evidence | What it pinned down |
|---|---|
| `/staff` and `/patients/<uuid>` → 404 | both added in `0f73eb2` |
| `/register`, `/pos`, `/sales`, `/reports` → 404 | added in `1089fbb` |
| `/sync` → 404 | added in `4798aa3` |
| `/recall` → 404 | added in `7eaec59` |
| 8 sidebar items live against 14 in `dashboard-layout.tsx` | the 6 missing are exactly the 6 that 404 |
| dashboard renders `GHS 2,450`, `1,247`, `CLM-2024-0156` | literals that appear nowhere in current source |
| deployed `sw.js` is 3,227 bytes | the repo's is 215 lines and references `/pos` |

`ba2daf5` satisfied the gate, but the deeper problem is that the gate only ever
reported in the Cloudflare log, and the adapter cannot run on Windows at all
(`vercel build` dies on `EPERM: symlink`), so no commit could be checked before
pushing it. Vercel removes the adapter entirely — it runs plain `next build`,
the same command that runs locally, so a failure is reproducible here. See "Why
this project moved off Cloudflare Pages" in `docs/DEPLOYMENT.md`.

**Vercel Git integration is connected** and has built `ba2daf5`: Vercel CLI
59.3.0, Next.js 15.5.25 detected, `npm run build` executed inside the
`frontend` workspace. The Cloudflare coupling is now removed:

| Removed | Was |
|---|---|
| `export const runtime = 'edge'` | `frontend/src/app/patients/[id]/page.tsx` |
| `@cloudflare/next-on-pages`, `wrangler` | `frontend/package.json` and the root lockfile — 59 packages pruned |
| `pages:build`, `pages:dev`, `pages:deploy` | replaced by `deploy: vercel --prod` |
| `output: undefined` | `frontend/next.config.js` |
| `frontend/public/_redirects` | a Cloudflare/Netlify SPA-fallback convention Vercel does not interpret |

Verified after the removal: frontend `tsc` clean, `next build` producing the
same 20 routes with the edge-runtime warning gone, 433 tests still passing.

### Outstanding

1. **Commit and push the removal**, so the next Vercel build carries it.
2. **`NEXT_PUBLIC_API_URL` must be set on the Vercel project.** It is inlined
   into the client bundle at build time; without it `frontend/src/lib/api.ts`
   falls back to `http://localhost:5000/api` and every request fails while the
   pages still load — which reads as a broken backend. It is the only
   environment variable the frontend reads.
3. **`CORS_ORIGIN` on Render must be updated** to the new `.vercel.app` URL, or
   the browser blocks the login request.
4. **Record the Vercel URL** here and in `docs/DEPLOYMENT.md`.
5. **Delete the Cloudflare Pages project** once Vercel is confirmed working, so
   the stale `pages.dev` build stops being reachable and mistaken for
   production.

Cost caveat worth stating plainly: Vercel's Hobby tier is **non-commercial use
only** and this is a B2B SaaS, whereas Cloudflare Pages permitted commercial
use for free. Budget Vercel Pro ($20/mo) at first revenue.

---

## Database: the migrations are applied

This was the previous blocker and it is cleared. Verified against the live API,
not taken on trust:

| Migration | Evidence |
|---|---|
| `001_pos.sql` | `GET /api/pos/sales` returns 200, and its query joins `sale_payments` — a table `database/init.sql` does not create |
| `003_inventory_batches.sql` | `GET /api/inventory/recall` returns 200 with a payload; that handler returns 501 with `RECALL_NEEDS_003` whenever `hasBatchTables()` is false |
| `002_offline_sync.sql` | **Not independently confirmed.** `idempotency_keys` is only reached after validation passes, and proving it would mean writing to production. Inferred from the other two, applied in the same pass |

Also verified live: `/health` 200 in 0.85s; `demo@pharmacy.com` returns a real
`pharmacy_owner` JWT; CORS answers the Pages origin with credentials; and all
thirteen deployed JS chunks carry the Render API URL with no `localhost`
anywhere in them. **The backend is not the problem.**

The code still degrades honestly if a migration is ever missing — batch and
recall endpoints return `501` naming the migration, the UI catches that status
and explains what is missing and what still works, and the notification bell
falls back to deriving alerts from the stock figures it can still read. `003` is
safe to re-run: its backfill skips any product that already has a batch, so it
will not duplicate stock.

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
