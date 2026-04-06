import { useState } from 'react'
import { subDays, subMonths } from 'date-fns'
import { Calendar, ChevronDown } from 'lucide-react'
import { DateRange } from '../../lib/types'
import { formatDate } from '../../lib/utils'

interface Props {
  value: DateRange
  onChange: (range: DateRange) => void
}

const PRESETS = [
  { label: '7 ימים אחרונים', getDates: () => ({ from: subDays(new Date(), 6), to: new Date() }) },
  { label: '30 ימים אחרונים', getDates: () => ({ from: subDays(new Date(), 29), to: new Date() }) },
  { label: '3 חודשים אחרונים', getDates: () => ({ from: subMonths(new Date(), 3), to: new Date() }) },
  { label: '6 חודשים אחרונים', getDates: () => ({ from: subMonths(new Date(), 6), to: new Date() }) },
]

export function DateRangePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 card-sm hover:bg-surface-50 transition-colors text-sm"
      >
        <Calendar size={14} className="text-surface-400" />
        <span className="text-surface-700">
          {formatDate(value.from)} – {formatDate(value.to)}
        </span>
        <ChevronDown size={14} className="text-surface-400" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 bg-white rounded-xl border border-surface-200 shadow-lg z-50 p-2 min-w-[200px]">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              onClick={() => {
                onChange(preset.getDates())
                setOpen(false)
              }}
              className="w-full text-right text-sm px-3 py-2 rounded-lg hover:bg-surface-50 text-surface-700 transition-colors"
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
