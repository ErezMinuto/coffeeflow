// ============================================================================
// Artisan coverage — is the roastery watcher still alive?
// ============================================================================
//
// Artisan profiles are PUSHED from the roastery computer, so there is no cron
// to watch and no schedule to compare against — scripts/artisan-watch.mjs just
// stops if that machine reboots, the folder moves, or Autosave gets unticked.
// Nobody would notice: roasts keep being logged, they quietly stop carrying
// charge/drop temperatures.
//
// A flat max_age_hours on artisan_profiles (the EXPECTED_FRESH_DATA pattern) is
// the wrong check here — it would fire every time Minuto simply doesn't roast
// for a few days. The real signal is CONDITIONAL: roasts were logged, but no
// profile came with them.
//
// Kept pure and separate from index.ts so the thresholds can be tested without
// standing up the whole watchdog. See artisan_coverage_test.ts.

export interface CoverageFinding {
  severity: 'WARN' | 'ERROR';
  category: 'artisan_coverage';
  message: string;
  context: Record<string, unknown>;
}

export interface CoverageInput {
  /** Roasts logged inside the window — only `artisan_uuid` matters. */
  recentRoasts: Array<{ artisan_uuid?: string | null }>;
  /** Profiles that arrived but were never attached, older than the grace period. */
  orphans: Array<{ beans?: string | null }>;
  windowHours: number;
  staleAfterDays: number;
}

/**
 * Below this many roasts there is not enough signal to tell a dead watcher
 * from a slow week, so we say nothing rather than cry wolf.
 */
export const MIN_ROASTS_FOR_BLACKOUT = 3;

/** Partial coverage is only meaningful once there are enough roasts to divide. */
export const MIN_ROASTS_FOR_RATIO = 5;

/** Below this share of roasts covered, something is systematically not matching. */
export const MIN_COVERAGE_RATIO = 0.5;

export function artisanCoverageFindings(input: CoverageInput): CoverageFinding[] {
  const { recentRoasts, orphans, windowHours, staleAfterDays } = input;
  const findings: CoverageFinding[] = [];

  const total = recentRoasts.length;
  const withData = recentRoasts.filter(r => r.artisan_uuid).length;

  // Total blackout — the watcher is the prime suspect.
  if (total >= MIN_ROASTS_FOR_BLACKOUT && withData === 0) {
    findings.push({
      severity: 'ERROR',
      category: 'artisan_coverage',
      message:
        `Artisan is not reaching the roast log — ${total} roasts in the last ${windowHours}h and NOT ONE carries ` +
        `charge/drop temperatures. The watcher on the roastery computer is probably not running (see docs/artisan.md).`,
      context: { window_hours: windowHours, roasts: total, with_artisan: 0 },
    });
  } else if (total >= MIN_ROASTS_FOR_RATIO && withData / total < MIN_COVERAGE_RATIO) {
    // Profiles ARE arriving, so the watcher is alive — they just aren't matching.
    findings.push({
      severity: 'WARN',
      category: 'artisan_coverage',
      message:
        `Artisan covered only ${withData}/${total} roasts in the last ${windowHours}h. Profiles are arriving but not ` +
        `matching — most likely a bean name typed in Artisan that no origin answers to. Attach one from the roasting ` +
        `page with "זכור את השם הזה" to teach it.`,
      context: { window_hours: windowHours, roasts: total, with_artisan: withData },
    });
  }

  // Profiles that arrived but were never claimed are real readings sitting
  // unused — and a standing hint that a bean alias is still missing.
  if (orphans.length > 0) {
    const beans = [...new Set(orphans.map(o => o.beans).filter(Boolean))].slice(0, 5);
    findings.push({
      severity: 'WARN',
      category: 'artisan_coverage',
      message:
        `${orphans.length} Artisan profile(s) older than ${staleAfterDays} days are still unattached` +
        `${beans.length ? ` (beans: ${beans.join(', ')})` : ''}. Their temperatures are recorded but on no roast.`,
      context: { unattached: orphans.length, older_than_days: staleAfterDays, beans },
    });
  }

  return findings;
}
