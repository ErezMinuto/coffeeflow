// Full-size image viewer in a popup, so the list behind it stays where it was
// (owner, 2026-11-18: approval thumbnails could not be opened full size).
// One image or a carousel's slides; Esc or a click outside the image closes,
// arrow keys and the buttons move between slides.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'

export function ImageLightbox({ images, start = 0, label, onClose }: {
  images: string[]
  start?: number
  label?: string
  onClose: () => void
}) {
  const [index, setIndex] = useState(() => Math.min(Math.max(0, start), Math.max(0, images.length - 1)))
  const closeRef = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const many = images.length > 1
  const go = (step: number) => setIndex(i => (i + step + images.length) % images.length)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      // Keep Tab inside the popup while it is open.
      else if (e.key === 'Tab' && boxRef.current) {
        const f = [...boxRef.current.querySelectorAll<HTMLElement>('button, a[href]')]
        if (!f.length) return
        const first = f[0], last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
      // The dashboard is right-to-left: the left arrow moves forward.
      else if (many && e.key === 'ArrowLeft') { e.preventDefault(); go(1) }
      else if (many && e.key === 'ArrowRight') { e.preventDefault(); go(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      opener?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!images.length) return null
  const src = images[index]
  const title = label ?? 'תמונה בגודל מלא'

  return createPortal(
    <div
      ref={boxRef}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-3 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        onClick={e => { e.stopPropagation(); onClose() }}
        className="absolute top-3 end-3 inline-flex items-center justify-center w-11 h-11 rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
        aria-label="סגירה"
      >
        <X size={22} aria-hidden="true" />
      </button>

      {many && (
        <>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); go(-1) }}
            className="absolute start-2 sm:start-4 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-11 h-11 rounded-full bg-white/10 text-white hover:bg-white/20"
            aria-label="התמונה הקודמת"
          >
            <ChevronRight size={24} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); go(1) }}
            className="absolute end-2 sm:end-4 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-11 h-11 rounded-full bg-white/10 text-white hover:bg-white/20"
            aria-label="התמונה הבאה"
          >
            <ChevronLeft size={24} aria-hidden="true" />
          </button>
        </>
      )}

      <figure className="flex flex-col items-center gap-2 max-w-full max-h-full" onClick={e => e.stopPropagation()}>
        <img src={src} alt={many ? `${title}, ${index + 1} מתוך ${images.length}` : title} className="max-w-[92vw] max-h-[84dvh] object-contain rounded-md shadow-2xl" />
        <figcaption className="flex items-center gap-3 text-[13px] text-white/80">
          {many && <span className="num" dir="ltr">{index + 1} / {images.length}</span>}
          <a href={src} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-white">פתיחה בלשונית חדשה</a>
        </figcaption>
      </figure>
    </div>,
    document.body,
  )
}
