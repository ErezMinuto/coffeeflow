// Age budget for a freshness check, in hours. A source that follows the shop's
// week can set saturday_max_age_hours: Minuto closes Friday afternoon and the
// watchdog runs Saturday morning, often before the first sale of Shabbat.

export function isSaturdayInIsrael(at: Date): boolean {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' }).format(at) === 'Sat'
}

export function freshnessBudgetHours(
  src: { max_age_hours: number; saturday_max_age_hours?: number },
  at: Date,
): number {
  return src.saturday_max_age_hours !== undefined && isSaturdayInIsrael(at)
    ? src.saturday_max_age_hours
    : src.max_age_hours
}
