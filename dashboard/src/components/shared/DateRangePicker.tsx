import { useEffect, useRef, useState } from 'react'
import { subDays, subMonths } from 'date-fns'
import { Calendar, ChevronDown } from 'lucide-react'
import { DateRange } from '../../lib/types'
import { formatDate } from '../../lib/utils'
import './cockpit.css'

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
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Close on Escape (focus back to the trigger) and on a click outside.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus() } }
    const onDown = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown) }
  }, [open])

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="true"
        aria-expanded={open}
        className="btn-secondary w-full lg:w-auto justify-between"
      >
        <span className="inline-flex items-center gap-2">
          <Calendar size={16} aria-hidden="true" className="text-surface-500" />
          <span className="num" dir="ltr">{formatDate(value.from)} – {formatDate(value.to)}</span>
        </span>
        <ChevronDown size={16} aria-hidden="true" className={`text-surface-500 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          className="cockpit-pop absolute left-0 top-full mt-1.5 z-50 min-w-[200px] p-1 bg-white rounded-[10px] border border-surface-200 shadow-[0_8px_24px_rgba(28,33,26,0.10)] origin-top-left"
        >
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => {
                onChange(preset.getDates())
                setOpen(false)
              }}
              className="w-full text-right text-sm h-9 px-3 rounded-lg text-surface-700 transition-colors duration-150 [@media(hover:hover)]:hover:bg-surface-100 [@media(hover:hover)]:hover:text-surface-900 cursor-pointer"
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
