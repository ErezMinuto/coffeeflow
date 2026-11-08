// Age budget for a freshness check, in hours. A source that follows the shop's
// week can set:
//   saturday_max_age_hours: Minuto closes Friday afternoon and the watchdog
//     runs Saturday morning, often before the first sale of Shabbat.
//   sunday_max_age_hours: the last sale is usually Saturday evening and the
//     first on Sunday often comes after the 08:00 UTC (10:00 Israel) run.
//     On 2026-11-08 the gap was 16.3h with the sync healthy.

function israelWeekday(at: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' }).format(at)
}

export function isSaturdayInIsrael(at: Date): boolean {
  return israelWeekday(at) === 'Sat'
}

export function freshnessBudgetHours(
  src: { max_age_hours: number; saturday_max_age_hours?: number; sunday_max_age_hours?: number },
  at: Date,
): number {
  const day = israelWeekday(at)
  if (day === 'Sat' && src.saturday_max_age_hours !== undefined) return src.saturday_max_age_hours
  if (day === 'Sun' && src.sunday_max_age_hours !== undefined) return src.sunday_max_age_hours
  return src.max_age_hours
}
