// Monthly AI spend warning. The strategist skips its weekly run once
// month-to-date spend reaches BUDGET_CEILING_USD; this warns the owner
// before that happens, so a skipped audit is never a surprise.

export interface BudgetFinding {
  severity: 'WARN' | 'ERROR'
  category: 'budget'
  message:  string
  context:  Record<string, unknown>
}

export function budgetFinding(mtdUsd: number, ceilingUsd: number, alertShare: number): BudgetFinding | null {
  if (!Number.isFinite(mtdUsd) || !(ceilingUsd > 0)) return null
  const share = mtdUsd / ceilingUsd
  if (share < alertShare) return null
  const atCeiling = share >= 1
  return {
    severity: atCeiling ? 'ERROR' : 'WARN',
    category: 'budget',
    message: atCeiling
      ? `AI spend this month is $${mtdUsd.toFixed(2)}, at the $${ceilingUsd} cap: the strategist's weekly SEO audit is skipped until next month or until the cap is raised.`
      : `AI spend this month is $${mtdUsd.toFixed(2)}, ${Math.round(share * 100)}% of the $${ceilingUsd} cap. At the cap the strategist's weekly SEO audit is skipped.`,
    context: { mtd_usd: Number(mtdUsd.toFixed(2)), ceiling_usd: ceilingUsd, share: Number(share.toFixed(3)) },
  }
}
