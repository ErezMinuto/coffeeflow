import { useEffect, useState } from 'react';

/**
 * Visual progress bar.
 * progress: 0-100
 */
export function ProgressBar({ progress = 0, label, color = '#4A7C59', height = 8 }) {
  return (
    <div style={{ width: '100%' }}>
      {label && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: '0.85rem', color: '#555' }}>{label}</span>
          <span style={{ fontSize: '0.8rem', color: '#888', fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(progress)}%
          </span>
        </div>
      )}
      <div style={{
        background: '#E8E8E0', borderRadius: 99, height, overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${Math.min(100, Math.max(0, progress))}%`,
          background: `linear-gradient(90deg, ${color}, ${color}bb)`,
          borderRadius: 99,
          transition: 'width 0.35s ease',
        }} />
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
