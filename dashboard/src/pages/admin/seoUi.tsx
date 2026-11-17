import React from 'react'
import { RefreshCw } from 'lucide-react'

// Small presentational pieces shared by the organic agent panels, so the
// queue, chat, inbox, metrics and brief read as one tool. Styles live in
// seo-agent.css (scoped under .seo-agent). No data logic here.

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'brand'

// Shared .tag / .dot from index.css (#548). The base has no olive dot, so
// `dot-brand` is defined in seo-agent.css.
export function Tag({ tone = 'neutral', title, mono, children }: { tone?: Tone; title?: string; mono?: boolean; children: React.ReactNode }) {
  return <span className={`tag shrink-0${tone === 'neutral' ? '' : ` tag-${tone}`}${mono ? ' font-mono font-medium text-[11.5px]' : ''}`} title={title}>{children}</span>
}

export function Dot({ tone = 'neutral' }: { tone?: Tone }) {
  return <span className={`dot${tone === 'neutral' ? '' : ` dot-${tone}`}`} aria-hidden="true" />
}

/** Dot + label, for a state that should read quietly in a row. */
export function Status({ tone, label, title }: { tone: Tone; label: string; title?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-surface-700 shrink-0" title={title}>
      <Dot tone={tone} />{label}
    </span>
  )
}

/** Panel header: 52px, 15px/600 title, muted meta, actions at the far end. */
export function PanelHead({ title, meta, children }: { title: React.ReactNode; meta?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="min-h-[52px] px-4 py-1.5 flex items-center gap-3 border-b border-surface-200 shrink-0">
      <h2 className="text-[15px] font-semibold text-surface-900 flex items-center gap-2 min-w-0">{title}</h2>
      {meta && <span className="text-[12.5px] text-surface-500 num truncate">{meta}</span>}
      {children && <div className="ms-auto flex items-center gap-1 shrink-0">{children}</div>}
    </header>
  )
}

export function RefreshButton({ onClick, spinning, disabled, title }: { onClick: () => void; spinning?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="icon-btn" title={title ?? 'רענון'} aria-label={title ?? 'רענון'}>
      <RefreshCw size={16} aria-hidden="true" className={spinning ? 'animate-spin' : ''} />
    </button>
  )
}

/** Static placeholder rows while the first load is in flight. */
export function LoadingRows({ rows = 3, label = 'טוען' }: { rows?: number; label?: string }) {
  return (
    <div className="p-4 space-y-5" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-2">
          <div className="skel" style={{ width: `${70 - i * 12}%` }} />
          <div className="skel" style={{ width: `${45 + i * 9}%` }} />
        </div>
      ))}
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-8 text-center text-[13px] leading-relaxed text-surface-500">{children}</div>
}

/** Same stamp the panels always showed (UTC, minute precision). */
export function stamp(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ')
}
