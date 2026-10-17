// KPI card
export interface KPIData {
  label: string
  value: string | number
  change?: number       // percentage vs previous period
  prefix?: string
  suffix?: string
  platform?: 'meta' | 'google' | 'all'
}

export interface DateRange {
  from: Date
  to: Date
}
