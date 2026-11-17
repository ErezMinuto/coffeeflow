import { KPIData } from '../../lib/types'
import { formatNumber, formatPercent } from '../../lib/utils'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

interface KPICardProps extends KPIData {
  className?: string
  loading?: boolean
}

export function KPICard({ label, value, change, prefix, suffix, className = '', loading }: KPICardProps) {
  const isPositive = change !== undefined && change > 0
  const isNegative = change !== undefined && change < 0

  if (loading) {
    return (
      <div className={`card ${className}`}>
        <div className="space-y-3" aria-busy="true">
          <div className="h-3 bg-surface-100 rounded w-2/3" />
          <div className="h-8 bg-surface-100 rounded w-1/2" />
          <div className="h-3 bg-surface-100 rounded w-1/3" />
        </div>
      </div>
    )
  }

  return (
    <div className={`card ${className}`}>
      <p className="text-[13px] text-surface-500 mb-1">{label}</p>
      <p className="text-[28px] leading-tight font-medium tracking-[-0.02em] text-surface-900 mb-2 num">
        {prefix && <span className="text-lg text-surface-400 mr-1">{prefix}</span>}
        {typeof value === 'number' ? formatNumber(value) : value}
        {suffix && <span className="text-lg text-surface-400 ml-1">{suffix}</span>}
      </p>
      {change !== undefined && (
        <div className={`flex items-center gap-1 text-xs font-medium ${
          isPositive ? 'text-[#3F6B2A]' : isNegative ? 'text-[#B42318]' : 'text-surface-500'
        }`}>
          {isPositive ? <TrendingUp size={12} /> : isNegative ? <TrendingDown size={12} /> : <Minus size={12} />}
          <span>{formatPercent(change)} לעומת התקופה הקודמת</span>
        </div>
      )}
    </div>
  )
}
