export type Platform = 'meta' | 'google'

export interface OAuthToken {
  platform: Platform
  access_token: string
  refresh_token?: string
  expires_at?: string
  meta?: Record<string, unknown>
}

export interface ConnectionStatus {
  platform: Platform
  connected: boolean
  last_synced?: string
  error?: string
}

// Meta organic
export interface MetaPost {
  id: string
  post_id: string
  post_type: 'post' | 'reel' | 'story'
  message?: string
  created_at: string
  reach: number
  impressions: number
  likes: number
  comments: number
  shares: number
  saves: number
  thumbnail_url?: string
}

export interface MetaInsights {
  date: string
  reach: number
  impressions: number
  follower_count: number
  profile_views: number
}

// Meta ads
export interface MetaCampaign {
  id: string
  campaign_id: string
  name: string
  status: string
  objective: string
  spend: number
  impressions: number
  clicks: number
  cpm: number
  cpc: number
  ctr: number
  conversions: number
  date: string
}

// Google Ads
export interface GoogleCampaign {
  id: string
  campaign_id: string
  name: string
  status: string
  impressions: number
  clicks: number
  cost: number
  ctr: number
  cpc: number
  conversions: number
  conversion_value: number
  roas: number
  date: string
}

// KPI card
export interface KPIData {
  label: string
  value: string | number
  change?: number       // percentage vs previous period
  prefix?: string
  suffix?: string
  platform?: Platform | 'all'
}

export interface DateRange {
  from: Date
  to: Date
}
