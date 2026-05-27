# Organic-content agent removal — 2026-05-27

## What was removed and why

The legacy `organic_content` agent (multi-week-old marketing-advisor mode + UI surfaces in Advisor.tsx + its twice-weekly cron + blog-auto-publish chain) was retired in favor of the unified `organic-orchestrator` + worker pipeline + `/admin/seo-agent` dashboard. See PRs **#95, #96, #97, #98** for the staged retirement (cron → UI panel hide → function 410 → and now this PR, the code cleanup).

This directory is the **backup snapshot** of the removed code, kept here for ~3-6 months as a reference / rollback option before being deleted entirely.

## Files

| File | Source path | Lines | What it was |
|---|---|---|---|
| `marketing-advisor.organic-blocks.bak.ts` | `supabase/functions/marketing-advisor/index.ts` | 1119 | `runOrganicAgent` (~1025 lines) + `generateSceneDescription` helper (dead at extraction time) |
| `marketing-advisor.enrichment.bak.ts` | `supabase/functions/marketing-advisor/enrichment.ts` | 519 | The whole `enrichment.ts` module — IG post enrichment (Haiku adapt-not-reject pattern), only imported by `runOrganicAgent` |
| `Advisor.organic-content.bak.tsx` | `dashboard/src/pages/Advisor.tsx` | 1155 | Five interfaces (`PostToPublish`, `GoogleOrganicRec`, `AdditionalSlide`, `EnrichedPost`, `OrganicReport`) + three components (`CarouselControls`, `PostPublishingControls`, `OrganicPanel`) |

## How to restore (if anyone ever needs to)

These `.bak.ts` / `.bak.tsx` files are NOT compilable — they're pure extractions with no surrounding context. Restoration requires:

1. **marketing-advisor cleanup reversal:**
   - Copy `enrichment.bak.ts` back to `supabase/functions/marketing-advisor/enrichment.ts`
   - Splice the two functions in `organic-blocks.bak.ts` back into `marketing-advisor/index.ts` (find the surrounding context via `git log -p` on the removal commit)
   - Re-add the import: `import { enrichPostsForPublishing } from "./enrichment.ts";`
   - Replace the `else if (agentArg === "organic_content")` 410 branch with the original `else { result = await runOrganicAgent(...) ... }`
   - Re-add `organic_content` to `NEW_AGENTS` and `OLD_AGENTS` arrays

2. **Advisor.tsx cleanup reversal:**
   - Splice the interfaces back at their original line ranges (~114, ~150, ~169, ~178, ~205)
   - Splice the three components back (~1145, ~1413, ~1757)
   - Restore the `organicPanel` const + the JSX render block (was around line 4440)
   - Re-add `organic_content` to the `agent_type` union (line ~58), the `report` union (~61), `STYLES` (~470), `buildTriageQueue` signature + call sites, `ALL_AGENT_TYPES`, state-init objects
   - Re-add the `blogState` + `allProducts` state hooks, `writeBlogPost` + `generateBanner` functions, and the `woo_products` fetch
   - Re-add `Leaf` to the lucide-react imports

3. **Crons + dispatch:**
   - Re-schedule `organic-content-twice-weekly` + `blog-auto-publish-twice-weekly` (see migrations `20260523_organic_agent_twice_weekly_cron.sql` and the unschedule migration `20260528_disable_blog_auto_publish_cron.sql`)
   - Confirm `runAdvisor('organic_content')` callsites in dashboard pages

## Easier alternative

`git log --all -p archive/2026-05-27-organic-content-removal/` will show the full extracted content in any future clone. And `git log -p -- supabase/functions/marketing-advisor/enrichment.ts` will show the file's full history before deletion — git keeps it forever even after deletion.

## Why kept locally instead of relying on git only?

Two reasons:
1. **Discoverability** — someone reading the repo in 6 months wonders "where did the IG approval flow go?" The archive directory is named clearly; git history requires knowing the commit to look at.
2. **The user's explicit ask** — "remove old code and keep it for a while in a backup file". This is that file.

## Slated deletion

If nothing has triggered a restore by **2026-12-01** (≈6 months from removal), delete this directory. Git history will retain the full code indefinitely.
