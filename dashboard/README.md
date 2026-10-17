# Minuto Marketing Dashboard

מערכת מעקב שיווקית לMinuto Coffee — Meta (Instagram אורגני + Ads) ו-Google אורגני.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Environment variables
```bash
cp .env.example .env.local
# Fill in your values
```

### 3. Supabase
Schema lives in the repo-root `supabase/migrations/`; the dashboard has no project of its own.

### 4. Deploy Edge Functions
```bash
supabase functions deploy meta-exchange-token
supabase functions deploy meta-sync
supabase functions deploy google-exchange-token
supabase functions deploy google-sync
```

### 5. Set Edge Function secrets
```bash
supabase secrets set META_APP_SECRET=xxx
supabase secrets set GOOGLE_CLIENT_SECRET=xxx
supabase secrets set GOOGLE_CUSTOMER_ID=123-456-7890
# After you receive it:
supabase secrets set GOOGLE_DEVELOPER_TOKEN=xxx
```

### 6. Run locally
```bash
npm run dev
```

## Project Structure

```
src/
├── components/        # BrainChat, DraftCampaignDrawer
│   └── shared/        # Sidebar, KPICard, DateRangePicker, NeedsYou, ErrorBoundary
├── pages/
│   ├── UnifiedPlan.tsx   # /plan — home page (marketing cockpit)
│   ├── MetaOrganic.tsx / MetaAds.tsx / GoogleOrganic.tsx  # tabs inside /plan
│   ├── Marketing.jsx     # /marketing — email
│   ├── Reels.tsx
│   ├── Settings.tsx
│   ├── OAuthCallback.tsx
│   └── admin/            # /admin/seo-agent
└── lib/
```

Edge functions and migrations live in the repo-root `supabase/`.

## Connection Flow

1. Go to `/settings`
2. Click "חבר" next to Meta → OAuth → token saved to Supabase
3. Click "סנכרן" to pull data
4. Google Ads: same flow, but requires Developer Token first

## Google Ads Developer Token

Apply at: https://ads.google.com → Tools → API Center
Takes 1-3 business days. Once approved, add via:
```bash
supabase secrets set GOOGLE_DEVELOPER_TOKEN=your_token
```
