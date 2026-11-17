import { useEffect, useState } from 'react';

/**
 * Visual progress bar: the system meter (6px sunken track, olive fill).
 * progress: 0-100
 * `color` is still accepted so existing callers keep working, but every
 * meter is olive now (one accent; see /.interface-design/system.md).
 * The fill moves with transform (scaleX), not width, so it stays on the
 * compositor while the progress ticks every 200ms.
 */
// eslint-disable-next-line no-unused-vars
export function ProgressBar({ progress = 0, label, color, height = 6 }) {
  const pct = Math.min(100, Math.max(0, progress));
  return (
    <div className="w-full">
      {label && (
        <div className="flex items-baseline justify-between gap-3 mb-1.5">
          <span className="text-[13px] text-surface-700">{label}</span>
          <span className="text-[12.5px] text-surface-500 num">{Math.round(progress)}%</span>
        </div>
      )}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={label || undefined}
        className="w-full bg-surface-100 rounded-full overflow-hidden"
        style={{ height }}
      >
        <div
          className="h-full w-full bg-brand-600 rounded-full origin-right motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-linear"
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      </div>
    </div>
  );
}

/**
 * Animates progress from 0 → ~90% over `estimatedSeconds`,
 * then snaps to 100% when you call complete().
 *
 * Usage:
 *   const { progress, complete, reset } = useAnimatedProgress(isLoading, 15);
 *   // call complete() when the async operation finishes
 */
export function useAnimatedProgress(isActive, estimatedSeconds = 15) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!isActive) {
      setProgress(0);
      return;
    }

    setProgress(0);
    const target = 90; // never auto-fill past 90% — complete() does the last 10%
    const intervalMs = 200;
    const steps = (estimatedSeconds * 1000) / intervalMs;
    const stepSize = target / steps;

    const timer = setInterval(() => {
      setProgress(prev => {
        const next = prev + stepSize;
        if (next >= target) { clearInterval(timer); return target; }
        return next;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isActive, estimatedSeconds]);

  const complete = () => setProgress(100);
  const reset    = () => setProgress(0);

  return { progress, complete, reset };
}
