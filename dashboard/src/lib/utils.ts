import { format, subDays } from 'date-fns'
import { DateRange } from './types'

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toString()
}

export function formatCurrency(n: number, currency = '₪'): string {
  return `${currency}${n.toLocaleString('he-IL', { maximumFractionDigits: 2 })}`
}

export function formatPercent(n: number): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`
}

export function formatDate(date: Date | string): string {
  return format(new Date(date), 'dd/MM/yyyy')
}

export function getDefaultDateRange(): DateRange {
  return {
    from: subDays(new Date(), 29),
    to: new Date(),
  }
}

export function getPreviousPeriod(range: DateRange): DateRange {
  const days = Math.round((range.to.getTime() - range.from.getTime()) / (1000 * 60 * 60 * 24))
  return {
    from: subDays(range.from, days),
    to: subDays(range.to, days),
  }
}

export function formatAPIDate(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

// Meta OAuth URL
export function getMetaAuthUrl(): string {
  // Full scope set needed by meta-sync:
  //   pages_show_list           — /me/accounts (find managed Pages)
  //   pages_read_engagement     — Page metadata + insights
  //   instagram_basic           — list IG account + media
  //   instagram_manage_insights — IG post insights (reach, saves, shares)
  //   ads_read                  — campaigns + insights from the ad account
  //   business_management       — required for Business-owned ad accounts
  // Missing any of these silently zeroes out that part of the sync.
  const params = new URLSearchParams({
    client_id: import.meta.env.VITE_META_APP_ID,
    redirect_uri: `${window.location.origin}/auth/meta/callback`,
    scope: 'pages_show_list,pages_read_engagement,instagram_basic,instagram_manage_insights,ads_read,business_management',
    response_type: 'code',
    state: crypto.randomUUID(),
  })
  return `https://www.facebook.com/v18.0/dialog/oauth?${params}`
}

// Google OAuth URL
export function getGoogleAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
    redirect_uri: `${window.location.origin}/auth/google/callback`,
    scope: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/webmasters.readonly',
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    state: crypto.randomUUID(),
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}
