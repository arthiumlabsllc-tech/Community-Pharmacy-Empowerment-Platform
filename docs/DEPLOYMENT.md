# Deployment Guide — Vercel + Render + Supabase

## $0 Production Testing Stack

| Component       | Service              | Free Tier                          |
|-----------------|----------------------|------------------------------------|
| Frontend        | **Vercel**           | 100GB bandwidth, 6,000 build min/mo |
| Backend         | **Render.com**       | Free web service                   |
| PostgreSQL      | **Supabase**         | 500MB database, 1GB storage        |
| Redis (cache)   | **Upstash**          | 10,000 commands/day                |
| File Storage    | **Supabase Storage** | 1GB included                       |

---

## Step 1: Supabase (Database) — 5 minutes

1. Go to https://supabase.com → **Sign up** with GitHub
2. Click **New Project**
   - Name: `pharmacy-platform`
   - Choose a strong database password (save it!)
   - Region: closest to your users (e.g., `West US` or `West EU`)
3. Once the project is ready, go to **SQL Editor**
4. Click **New Query** → Paste the entire contents of `database/init.sql` → Click **Run**
5. Verify tables were created — go to **Table Editor** and you should see 15 tables
6. Go to **Storage** → **New Bucket** → Name it `prescriptions` → Make it **Public**
7. Go to **Project Settings → Database → Connection String**
   - Copy the **Transaction** mode connection string (looks like `postgresql://...pooler.supabase.com:6543`)
   - Also copy the **Direct** connection string for seeding

---

## Step 2: Upstash (Redis) — 2 minutes

1. Go to https://upstash.com → **Sign up** with GitHub
2. Click **Create Database**
   - Name: `pharmacy-cache`
   - Region: same as your Render service
   - Select **Free** plan
3. Copy the connection details from the dashboard:
   - `REDIS_URL`: `rediss://default:<your-token>@<your-endpoint>`

---

## Step 3: Render.com (Backend) — 5 minutes

1. Push your code to a **GitHub repository**
2. Go to https://render.com → **Sign up** with GitHub
3. Click **New → Web Service**
4. **Connect** your GitHub repository
5. Configure the service:
   - **Name**: `pharmacy-platform-api`
   - **Region**: same as your Upstash Redis
   - **Root Directory**: `backend`
   - **Runtime**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `node dist/server.js`
   - **Plan**: `Free`
   - **Health Check Path**: `/health`

6. Add **Environment Variables** (click "Add Environment Variable" for each):

   | Key | Value |
   |-----|-------|
   | `NODE_ENV` | `production` |
   | `PORT` | `5000` |
   | `DATABASE_URL` | *(paste from Supabase Step 1)* |
   | `REDIS_URL` | *(paste from Upstash Step 2)* |
   | `JWT_SECRET` | *(generate: https://generate-secret.vercel.app/64)* |
   | `JWT_REFRESH_SECRET` | *(generate: https://generate-secret.vercel.app/64)* |
   | `CORS_ORIGIN` | `https://your-project.vercel.app` *(set after the Vercel deploy — Step 6)* |

7. Click **Create Web Service**
8. Wait for the build to complete, then visit `https://pharmacy-platform-api.onrender.com/health`
9. You should see: `{"status":"healthy","timestamp":"...","version":"1.0.0"}`

---

## Step 4: Seed Demo Data — 2 minutes

Run the seed script locally, pointing at your Supabase database:

```bash
cd backend
npm install
DATABASE_URL="your_supabase_direct_connection_string" npx ts-node src/database/seed.ts
```

Or open **Supabase SQL Editor** and run the INSERT statements from `backend/src/database/seed.ts` directly.

**Demo credentials after seeding:** `demo@pharmacy.com` / `Demo@1234`

---

## Step 5: Vercel (Frontend) — 5 minutes

Vercel is the first-party host for Next.js. There is no adapter between the
framework and the platform, so the build Vercel runs is the build you run
locally (`npm run build`) and a failure is reproducible on your own machine.

### Option A: Git Integration (in use — auto-deploys on push)

1. Go to https://vercel.com → **Sign up / Log in with GitHub**
2. Click **Add New… → Project**
3. **Import** the GitHub repository
4. Configure the build:
   - **Project name**: `pharmacy-platform` *(becomes the `.vercel.app` subdomain)*
   - **Framework Preset**: `Next.js` *(auto-detected)*
   - **Root Directory**: `frontend` — **required**, see the monorepo note below
   - **Build / Output / Install Command**: leave all three at their defaults
5. Add **Environment Variables** *before* the first build:

   | Key | Value | Environments |
   |-----|-------|--------------|
   | `NEXT_PUBLIC_API_URL` | `https://<your-api>.onrender.com/api` | Production, Preview |

   `NEXT_PUBLIC_*` values are inlined into the client bundle **at build time**.
   A variable added after a build does not reach it — redeploy afterwards. If it
   is missing, `frontend/src/lib/api.ts` falls back to
   `http://localhost:5000/api` and every request the deployed site makes fails
   while the site itself still loads, which reads as a broken backend.

   This is the only environment variable the frontend reads.

6. Click **Deploy**

### Option B: CLI Deploy

```bash
npm install -g vercel
cd frontend
vercel login
vercel env add NEXT_PUBLIC_API_URL production   # paste the Render API URL
vercel --prod
```

Run the CLI from `frontend/`, not the repo root: Vercel treats the directory it
is invoked from as the Root Directory, and still finds the workspace lockfile at
the repo root on its own. Prefer Option A — a CLI deploy is a one-off and does
not redeploy on push.

### Monorepo note

This repository uses npm workspaces (`backend`, `frontend`) with a **single
`package-lock.json` at the root** and none inside `frontend/`. That is a
supported Vercel layout, and two mistakes break it:

- Setting Root Directory to the repo root makes Vercel build both workspaces,
  including the Express backend, which Vercel cannot serve as a long-running
  process.
- Adding a second lockfile inside `frontend/` desynchronises it from the root
  one. Install from the repo root and let the workspaces hoist.

The backend stays on Render. Vercel hosts the frontend only.

### Why this project moved off Cloudflare Pages

Kept as history, because the failure mode is invisible from the code and will
look like nonsense if the hosting is ever moved back.

Cloudflare Pages serves Next.js through `@cloudflare/next-on-pages`, which
converts the build to Workers and **fails the entire deploy** if any route is
rendered on demand without an edge runtime declaration:

```
⚡️ ERROR: Failed to produce a Cloudflare Pages build from the project.
⚡️ 	The following routes were not configured to run with the Edge Runtime:
⚡️ 	  - /patients/[id]
```

Nineteen of the twenty routes are prerendered static (`○`) because they are
client-rendered pages behind no dynamic segment. `/patients/[id]` is the one
server-rendered route (`ƒ`), and adding it silently held production at the
previous commit while seven later commits sat undeployed on GitHub. Three
properties made that expensive rather than merely annoying:

- **It only ever reported in the Cloudflare build log.** `next build` passed,
  so nothing on a development machine distinguished a deployable commit from a
  broken one.
- **`next-on-pages` cannot run on Windows.** It shells out through `npm`, and
  the `vercel build` it invokes dies on `EPERM: operation not permitted,
  symlink` without Developer Mode or elevation.
- **`nodejs_compat` is never checked at build time.** The adapter only copies a
  fallback page to `cdn-cgi/errors/no-nodejs_compat.html`, so a missing
  compatibility flag produces a green build and a broken runtime.

The adapter is also deprecated upstream — Cloudflare's own install output says
`Please use the OpenNext adapter instead`.

None of this applies on Vercel. `/patients/[id]` is an ordinary Node serverless
function, and a new dynamic segment, `route.ts` handler, or `cookies()` /
`headers()` call needs no declaration of any kind.

**If the hosting is ever moved back to Cloudflare**, every non-static route
needs `export const runtime = 'edge'`, and `dynamic = 'force-static'` is *not*
a substitute — it prerenders one shell with empty params and serves it for every
value of `[id]`, and these pages read the id from `useParams()`, so every
patient would silently share one page.

---

## Step 6: Update CORS on Backend

After the Vercel deploy completes, go back to Render. The backend only accepts
the origin it is told to, so a new frontend URL means a new `CORS_ORIGIN` —
without it the browser blocks the login request and the site looks broken even
though both halves are running.

1. Go to your Render service → **Environment**
2. Update `CORS_ORIGIN` to your Vercel URL:
   `https://pharmacy-platform.vercel.app`
3. Click **Save Changes** — Render will auto-redeploy
4. Confirm it took by sending the new origin and checking it is echoed back:

   ```bash
   curl -i -H "Origin: https://pharmacy-platform.vercel.app" \
     https://<your-api>.onrender.com/api/auth/login
   ```

   The response should carry a matching `access-control-allow-origin` and
   `access-control-allow-credentials: true`.

---

## Your Live URLs

After all steps:

| Service | URL |
|---------|-----|
| **Frontend** | `https://<project>.vercel.app` *(Vercel → your project → Domains)* |
| **Backend API** | `https://community-pharmacy-empowerment-platform.onrender.com/api` |
| **API Health** | `https://community-pharmacy-empowerment-platform.onrender.com/health` |
| **Database** | Managed by Supabase (dashboard access only) |

The old Cloudflare Pages URL, `https://community-pharmacy-empowerment-platform.pages.dev`,
still resolves and still serves a stale build. Delete the Pages project once
Vercel is confirmed working, or the two will drift apart and it will not be
obvious which one anyone is looking at.

---

## Known Free-Tier Limitations

| Service | Limitation | Impact | Workaround |
|---------|-----------|--------|------------|
| **Render** | Spins down after 15min idle | First request takes ~30s | Use a cron ping service (e.g., cron-job.org) |
| **Supabase** | 500MB database, pauses after 7 days idle | Enough for MVP testing | Log in weekly to keep active |
| **Upstash** | 10K commands/day | ~100 active users | Sufficient for testing |
| **Vercel** | Hobby tier is **non-commercial use only**; 100GB bandwidth, 6,000 build min/mo | Fine for testing, but a paid Pro seat is required before charging customers | Budget Vercel **Pro** ($20/mo) at first revenue. Cloudflare Pages permitted commercial use on its free tier — revisit if this becomes the deciding cost |

### Keep Render Awake (Optional)

Use a free uptime monitor to ping your API every 10 minutes:
- https://cron-job.org → Create a free cron job
- URL: `https://pharmacy-platform-api.onrender.com/health`
- Interval: Every 10 minutes

---

## Upgrading to Production

When you outgrow the free tier:

| Milestone | Upgrade To | Est. Cost |
|-----------|-----------|-----------|
| First paying pharmacy (Vercel Hobby forbids commercial use) | Vercel **Pro** | $20/mo |
| 50+ pharmacies, need always-on | Render **Starter** ($7/mo) | $7/mo |
| 500+ pharmacies, more DB space | Supabase **Pro** ($25/mo) | $25/mo |
| 1000+ pharmacies, full scale | AWS EC2 + RDS + ElastiCache | $150+/mo |

The code is Docker-ready — just change the deployment target.
