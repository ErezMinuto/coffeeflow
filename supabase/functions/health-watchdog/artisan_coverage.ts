// ============================================================================
// Artisan coverage — is the roastery watcher still alive?
// ============================================================================
//
// The Artisan file is uploaded by hand onto each roast record, so there is no
// process to watch — only a habit. If the step gets skipped, roasts keep being
// logged and quietly stop carrying charge/drop temperatures.
//
// This is therefore a REMINDER, not a failure alarm: nothing is broken, someone
// just has files left to upload. It never reports ERROR.
//
// A flat max_age_hours on artisan_profiles (the EXPECTED_FRESH_DATA pattern)
// would be wrong here — it fires every time Minuto simply doesn't roast for a
// few days. The signal has to be CONDITIONAL: roasts were logged without one.
//
// Kept pure and separate from index.ts so the thresholds can be tested without
// standing up the whole watchdog. See artisan_coverage_test.ts.

export interface CoverageFinding {
  severity: 'WARN';
  category: 'artisan_coverage';
  message: string;
  context: Record<string, unknown>;
}

export interface CoverageInput {
  /** Roasts logged inside the window — only `artisan_uuid` matters. */
  recentRoasts: Array<{ artisan_uuid?: string | null }>;
  windowHours: number;
}

/**
 * Below this many roasts there is not enough signal to tell a skipped habit
 * from a slow week, so we say nothing rather than nag.
 */
export const MIN_ROASTS_FOR_BLACKOUT = 3;

/** Partial coverage is only meaningful once there are enough roasts to divide. */
export const MIN_ROASTS_FOR_RATIO = 5;

/** Below this share of roasts covered, something is systematically not matching. */
export const MIN_COVERAGE_RATIO = 0.5;

export function artisanCoverageFindings(input: CoverageInput): CoverageFinding[] {
  const { recentRoasts, windowHours } = input;
  const findings: CoverageFinding[] = [];

  const total = recentRoasts.length;
  const withData = recentRoasts.filter(r => r.artisan_uuid).length;

  if (total >= MIN_ROASTS_FOR_BLACKOUT && withData === 0) {
    findings.push({
      severity: 'WARN',
      category: 'artisan_coverage',
      message:
        `No Artisan file has been uploaded for any of the last ${total} roasts (${windowHours}h). Their charge and ` +
        `drop temperatures are missing from the roast log — upload each roast's .alog from the roasting page.`,
      context: { window_hours: windowHours, roasts: total, with_artisan: 0 },
    });
  } else if (total >= MIN_ROASTS_FOR_RATIO && withData / total < MIN_COVERAGE_RATIO) {
    findings.push({
      severity: 'WARN',
      category: 'artisan_coverage',
      message:
        `Only ${withData} of the last ${total} roasts (${windowHours}h) have an Artisan file. The rest are missing ` +
        `their charge and drop temperatures.`,
      context: { window_hours: windowHours, roasts: total, with_artisan: withData },
    });
  }

  return findings;
}
