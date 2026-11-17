import { ReactNode, KeyboardEvent, useRef } from 'react'
import { formatPercent } from '../../lib/utils'
import './cockpit.css'

// Small building blocks for the plan cockpit and its channel tabs, on the
// CoffeeFlow system (/.interface-design/system.md): one KPI card split by
// hairlines, status as dots and tags, quiet segmented controls, olive only for
// action and "where you are". Status tones are the system's danger / warn / ok.

export type Tone = 'danger' | 'warn' | 'ok' | 'neutral'

// Thin wrappers over the shared base classes (.dot, .notice in src/index.css).
const DOT: Record<Tone, string> = { danger: 'dot-danger', warn: 'dot-warn', ok: 'dot-ok', neutral: '' }

export function Dot({ tone = 'neutral', className = '' }: { tone?: Tone; className?: string }) {
  return <span aria-hidden="true" className={`dot ${DOT[tone]} ${className}`} />
}

const NOTICE: Record<Tone, string> = { danger: 'notice-danger', warn: 'notice-warn', ok: 'notice-ok', neutral: '' }

/** A real message (error, missing connection). Soft tint, hairline border, no side stripe. */
export function Notice({ tone = 'neutral', icon, title, children }: {
  tone?: Tone; icon?: ReactNode; title?: ReactNode; children?: ReactNode
}) {
  return (
    <div role={tone === 'danger' ? 'alert' : undefined} className={`notice ${NOTICE[tone]} text-[13px] leading-relaxed`}>
      {icon && <span className="mt-0.5 shrink-0 [&>svg]:w-4 [&>svg]:h-4" aria-hidden="true">{icon}</span>}
      <div className="min-w-0">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}
      </div>
    </div>
  )
}

// ── KPI strip: one card split by hairlines, 4 across, 2×2 on phones ──────────
export function Kpis({ children, cols = 4, label }: { children: ReactNode; cols?: 3 | 4; label: string }) {
  const grid = cols === 3 ? 'grid-cols-3' : 'grid-cols-2 lg:grid-cols-4'
  return (
    <section aria-label={label} className={`grid ${grid} card-flush overflow-hidden`}>
      {children}
    </section>
  )
}

/**
 * One figure. `change` is a % against the previous period; `goodWhen="down"`
 * for costs (CPA), so a rise reads as bad; `"none"` when a rise is neither
 * (spend). `size="sm"` for secondary rows.
 */
export function Kpi({ label, value, unit, note, change, changeLabel = 'לעומת החודש הקודם', goodWhen = 'up', loading, size = 'md' }: {
  label: string; value: ReactNode; unit?: string; note?: ReactNode
  change?: number; changeLabel?: string; goodWhen?: 'up' | 'down' | 'none'; loading?: boolean; size?: 'md' | 'sm'
}) {
  const judged = goodWhen !== 'none' && change !== undefined && change !== 0
  const good = judged && ((change! > 0) === (goodWhen === 'up'))
  const bad  = judged && !good
  return (
    <div className={`${size === 'sm' ? 'px-3.5 lg:px-5 py-3.5' : 'px-5 py-4 lg:py-[18px]'} border-surface-200 -ms-px -mt-px border-s border-t min-w-0`}>
      <p className="text-[13px] text-surface-500 truncate">{label}</p>
      {loading ? (
        <span aria-hidden="true" className={`block mt-2 rounded bg-surface-100 ${size === 'sm' ? 'h-5 w-16' : 'h-7 w-24'}`} />
      ) : (
        <p className={`num text-surface-900 font-medium tracking-[-0.02em] leading-tight mt-1 ${size === 'sm' ? 'text-lg lg:text-xl' : 'text-2xl lg:text-[28px]'}`}>
          {value}
          {unit && <span className="text-sm font-normal text-surface-500 ms-1 tracking-normal">{unit}</span>}
        </p>
      )}
      {!loading && change !== undefined && (
        <p className={`num text-[12.5px] mt-1 ${good ? 'text-ok' : bad ? 'text-danger' : 'text-surface-500'}`}>
          <span dir="ltr" className="font-medium">{formatPercent(change)}</span>
          <span className="text-surface-500"> {changeLabel}</span>
        </p>
      )}
      {!loading && note && <p className="text-[12.5px] text-surface-500 mt-1 num">{note}</p>}
    </div>
  )
}

// ── Segmented control (sort / filter). Buttons with aria-pressed. ───────────
export function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: NoInfer<T>) => void; options: { id: NoInfer<T>; label: ReactNode }[]; label: string
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-surface-100">
      {options.map(o => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[13px] font-medium whitespace-nowrap transition-[background-color,color,transform] duration-150 active:scale-[0.97] cursor-pointer ${
            value === o.id
              ? 'bg-white text-surface-900 ring-1 ring-surface-200'
              : 'text-surface-600 [@media(hover:hover)]:hover:text-surface-900'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── Tabs (underline, olive = where you are). Arrow keys move between tabs. ──
export function Tabs<T extends string>({ value, onChange, tabs, label, idPrefix }: {
  value: T; onChange: (v: NoInfer<T>) => void; tabs: readonly { id: NoInfer<T>; label: string }[]; label: string; idPrefix: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  function onKey(e: KeyboardEvent, i: number) {
    // RTL: ArrowLeft moves forward (to the next tab on the left).
    const step = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0
    let next = -1
    if (step) next = (i + step + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next < 0) return
    e.preventDefault()
    onChange(tabs[next].id)
    refs.current[next]?.focus()
  }
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-surface-200 overflow-x-auto -mx-4 px-4 lg:mx-0 lg:px-0 [scrollbar-width:none]">
      {tabs.map((t, i) => {
        const on = value === t.id
        return (
          <button
            key={t.id}
            ref={el => { refs.current[i] = el }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-selected={on}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={e => onKey(e, i)}
            className={`relative h-11 px-3 text-sm whitespace-nowrap transition-colors duration-150 cursor-pointer ${
              on ? 'text-brand-600 font-semibold' : 'text-surface-500 font-medium [@media(hover:hover)]:hover:text-surface-900'
            }`}
          >
            {t.label}
            <span aria-hidden="true" className={`absolute inset-x-2 -bottom-px h-0.5 rounded-full ${on ? 'bg-brand-600' : 'bg-transparent'}`} />
          </button>
        )
      })}
    </div>
  )
}

/** Header of a tab / section: h2 + one muted line, actions on the other side. */
export function SectionHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold text-surface-900">{title}</h2>
        {sub && <p className="text-[13px] text-surface-500 mt-0.5 num">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Card with a 52px head (title + meta / controls) and a flush body. */
export function CardHead({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="card-head flex-wrap gap-y-2 py-2.5">
      <h3 className="text-[15px] font-semibold text-surface-900">{title}</h3>
      {children}
    </div>
  )
}

// Recharts on the system: olive for the series, warm greys for structure.
export const CHART = {
  olive: '#3D4A2E',
  oliveSoft: '#B8C2A2',
  grey: '#A3A79C',
  grid: '#E6E3DB',
  tick: { fontSize: 11, fill: '#7A7F73' },
  tooltip: {
    contentStyle: { background: '#fff', border: '1px solid #E6E3DB', borderRadius: 8, fontSize: 12, boxShadow: '0 8px 24px rgba(28,33,26,0.10)', direction: 'rtl' as const },
    labelStyle: { color: '#7A7F73', marginBottom: 2 },
    itemStyle: { color: '#1C211A', padding: 0 },
    cursor: { fill: '#F1EFE9' },
  },
}

/** Legend swatch for a chart card head. */
export function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] text-surface-500">
      <span aria-hidden="true" className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  )
}

export const TH = 'px-4 py-2.5 text-[12.5px] font-medium text-surface-500 whitespace-nowrap'
export const TD = 'px-4 py-3 num'
