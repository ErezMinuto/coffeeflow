# Minuto Marketing Dashboard

מערכת מעקב שיווקית לMinuto Coffee — Meta (Instagram אורגני + Ads) ו-Google Ads.

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

### 3. Supabase — run migration
```bash
# In Supabase dashboard → SQL Editor
# Run: supabase/migrations/001_initial.sql
```

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
├── components/
│   └── shared/        # KPICard, Sidebar, DateRangePicker, ConnectionStatus
├── pages/
│   ├── Overview.tsx   # Main dashboard
│   ├── MetaOrganic.tsx
│   ├── MetaAds.tsx
│   ├── GoogleAds.tsx
│   ├── Settings.tsx
│   └── OAuthCallback.tsx
└── lib/
    ├── supabase.ts
    ├── types.ts
    └── utils.ts

supabase/
├── functions/
│   ├── meta-exchange-token/
│   ├── meta-sync/
│   ├── google-exchange-token/
│   └── google-sync/
└── migrations/
    └── 001_initial.sql
```

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
