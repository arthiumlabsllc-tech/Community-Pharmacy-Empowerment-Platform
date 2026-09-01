# Community Pharmacy Empowerment Platform

A B2B SaaS platform empowering small community pharmacies in Ghana to participate in the digital health ecosystem through offline-first technology, NHIS integration, and patient engagement tools.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Frontend (Next.js PWA)              │
│  Tailwind CSS │ Zustand │ Service Worker │ i18n  │
└────────────────────┬────────────────────────────┘
                     │ REST API
┌────────────────────┴────────────────────────────┐
│           Backend (Express.js / TypeScript)       │
│  JWT Auth │ Rate Limiting │ Bull Jobs │ Multer   │
├──────────┬──────────┬──────────┬────────────────┤
│PostgreSQL│  Redis   │   S3     │  Background    │
│ (Primary)│ (Cache)  │ (Files)  │  Jobs (Bull)   │
└──────────┴──────────┴──────────┴────────────────┘
```

## Quick Start

### Prerequisites
- Node.js >= 18.0.0
- PostgreSQL 15+
- Redis 7+
- Docker & Docker Compose (optional)

### Development Setup

1. **Clone and install dependencies:**
```bash
npm install
```

2. **Set up environment variables:**
```bash
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

3. **Start infrastructure (Docker):**
```bash
npm run docker:up
```

4. **Run database migrations:**
```bash
npm run db:migrate
npm run db:seed
```

5. **Start development servers:**
```bash
npm run dev
```

Backend runs on http://localhost:5000  
Frontend runs on http://localhost:3000

### Docker Deployment

```bash
docker-compose up -d
```

## Modules

| Module | Description |
|--------|-------------|
| Pharmacy Management | Dashboard, analytics, performance scoring |
| Inventory | Stock tracking, expiry alerts, barcode scanning |
| Patient CRM | Profiles, medical history, adherence tracking |
| NHIS Integration | Eligibility checks, claims, reimbursements |
| Patient Engagement | SMS reminders, health screenings, referrals |
| Consultations | Video calls, chat, prescription generation |
| Subscriptions | Freemium/Premium/Enterprise tiers, MoMo payments |
| Admin | User management, feature flags, system analytics |

## Tech Stack

**Frontend:** Next.js 14, TypeScript, Tailwind CSS, Zustand, Workbox, Recharts  
**Backend:** Express.js, TypeScript, Prisma, Bull, JWT  
**Database:** PostgreSQL 15, Redis 7  
**Infrastructure:** Docker, GitHub Actions, Sentry  

## License

MIT - Arthium Labs LLC
