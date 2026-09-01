# Deployment Guide — Cloudflare Pages + Render + Supabase

## $0 Production Testing Stack

| Component       | Service              | Free Tier                          |
|-----------------|----------------------|------------------------------------|
| Frontend        | **Cloudflare Pages** | Unlimited bandwidth, 500 builds/mo |
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
   | `CORS_ORIGIN` | `https://your-project.pages.dev` *(set after Cloudflare deploy)* |

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

## Step 5: Cloudflare Pages (Frontend) — 5 minutes

### Option A: Dashboard Deploy (Easiest)

1. Go to https://dash.cloudflare.com → **Workers & Pages**
2. Click **Create → Pages → Connect to Git**
3. Select your GitHub repository
4. Configure the build:
   - **Project name**: `pharmacy-platform`
   - **Production branch**: `main`
   - **Build system**: Select **Next.js** (or configure manually):
     - **Build command**: `npx @cloudflare/next-on-pages`
     - **Build output directory**: `.vercel/output/static`
   - **Root directory**: `frontend`
5. Add **Environment Variables** (Settings → Environment Variables):
   - `NEXT_PUBLIC_API_URL` = `https://pharmacy-platform-api.onrender.com/api`
   - `NEXT_PUBLIC_APP_NAME` = `Pharmacy Empowerment Platform`
6. Click **Save and Deploy**

### Option B: CLI Deploy

```bash
cd frontend
npm install
npm run pages:build
npx wrangler pages deploy .vercel/output/static --project-name=pharmacy-platform
```

---

## Step 6: Update CORS on Backend

After your Cloudflare Pages deploy completes, go back to Render:

1. Go to your Render service → **Environment**
2. Update `CORS_ORIGIN` to your Cloudflare Pages URL:
   `https://pharmacy-platform.pages.dev`
3. Click **Save Changes** — Render will auto-redeploy

---

## Your Live URLs

After all steps:

| Service | URL |
|---------|-----|
| **Frontend** | `https://pharmacy-platform.pages.dev` |
| **Backend API** | `https://pharmacy-platform-api.onrender.com/api` |
| **API Health** | `https://pharmacy-platform-api.onrender.com/health` |
| **Database** | Managed by Supabase (dashboard access only) |

---

## Known Free-Tier Limitations

| Service | Limitation | Impact | Workaround |
|---------|-----------|--------|------------|
| **Render** | Spins down after 15min idle | First request takes ~30s | Use a cron ping service (e.g., cron-job.org) |
| **Supabase** | 500MB database, pauses after 7 days idle | Enough for MVP testing | Log in weekly to keep active |
| **Upstash** | 10K commands/day | ~100 active users | Sufficient for testing |
| **Cloudflare** | 500 builds/month | More than enough | — |

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
| 50+ pharmacies, need always-on | Render **Starter** ($7/mo) | $7/mo |
| 500+ pharmacies, more DB space | Supabase **Pro** ($25/mo) | $25/mo |
| 1000+ pharmacies, full scale | AWS EC2 + RDS + ElastiCache | $150+/mo |

The code is Docker-ready — just change the deployment target.
