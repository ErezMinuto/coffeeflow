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
        <div className="animate-pulse space-y-3">
          <div className="h-3 bg-surface-100 rounded w-2/3" />
          <div className="h-8 bg-surface-100 rounded w-1/2" />
          <div className="h-3 bg-surface-100 rounded w-1/3" />
        </div>
      </div>
    )
  }

  return (
    <div className={`card hover:shadow-md transition-shadow ${className}`}>
      <p className="text-sm text-surface-500 font-medium mb-2">{label}</p>
      <p className="text-3xl font-display font-semibold text-surface-900 mb-3">
        {prefix && <span className="text-lg text-surface-400 mr-1">{prefix}</span>}
        {typeof value === 'number' ? formatNumber(value) : value}
        {suffix && <span className="text-lg text-surface-400 ml-1">{suffix}</span>}
      </p>
      {change !== undefined && (
        <div className={`flex items-center gap-1 text-xs font-medium ${
          isPositive ? 'text-green-600' : isNegative ? 'text-red-500' : 'text-surface-400'
        }`}>
          {isPositive ? <TrendingUp size={12} /> : isNegative ? <TrendingDown size={12} /> : <Minus size={12} />}
          <span>{formatPercent(change)} vs תקופה קודמת</span>
        </div>
      )}
    </div>
  )
}
