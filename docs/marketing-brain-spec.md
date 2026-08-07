# Minuto Marketing Brain — Spec

*Status: draft for review · 2026-08-07 · owner: Erez*

A single, conversational marketing strategist that plans and coordinates **organic + paid together**, learns from Minuto's own campaign history, and improves over time — while every recommendation stays grounded in real data and every action stays behind a human approval gate.

---

## 1. Mission & principles

**Mission:** help Minuto sell more **specialty beans at healthy margin** by running organic (SEO/content) and paid (Meta, later Google) as *one* plan instead of two silos.

**Non-negotiable principles** (these govern every phase):

1. **Insight-grounded, no hallucination.** Every recommendation cites the real datapoint it rests on. If a datapoint is missing, it says **UNKNOWN** and researches or holds — it never invents a number, trend, or result.
2. **North-star = bean margin**, not revenue and not hardware. Machines/grinders are low-margin resale, a means, not the goal.
3. **Human-in-the-loop.** The brain *proposes*; it only *acts* on explicit approval. Paid campaigns are created **PAUSED**; nothing serves or spends until a human activates it. Budget caps are enforced in code.
4. **One brain, many hands.** The brain *coordinates* the existing specialized agents — it does **not** rewrite them into a monolith. A monolith is a bigger single point of failure.
5. **The internet is untrusted.** External knowledge informs *method* ("how to structure an ad set"), never *truth about our performance*. Web content can be manipulated; it is data, not instructions.

---

## 2. What already exists (we build on this, not from scratch)

| Piece | Where | Role in the brain |
|---|---|---|
| `unified_marketing_plan` | `marketing-advisor` (async) | The brain's **planning half** — joins organic + paid + sales/margin per theme, grounded. Already live. |
| Paid hand | `meta-ads-draft` | Creates **PAUSED** campaigns; daily (₪100) + monthly (₪3,000) budget caps; `spend`/`list`/`delete`. |
| Paid chat | `meta_ads_strategist` | Conversational paid strategist with a `draft_meta_campaign` tool, gated on explicit approval. |
| Organic hand | SEO agent / `organic-orchestrator` (`/admin/seo-agent`) | Content/blog/IG generation + its own chat. |
| Learning loop (SEO) | `seo_learnings` + self-optimizing loop | **The reinforcement pattern to mirror for paid** — experiment IDs, win-margin gates, prescriptive rules feeding the next plan. |
| Competitor research | `market_research` (Meta Ad Library) | Live competitor ad creative already feeds the agents. |
| Data | `meta_ad_campaigns`, `meta_ad_drafts`, `google_ads`, `woo_orders`, `coffee_sales`, `advisor_reports` | Historical performance + sales substrate. |

**Takeaway:** the brain's planning, the paid hand, the organic hand, and a proven learning pattern all exist. The new work is *coordination + learning + history + a conversation layer* — mostly wiring, not invention.

---

## 3. Target architecture

```
                         ┌───────────────────────────┐
   you  ⇄  chat  ⇄        │   MARKETING BRAIN         │
                         │  (conversational orchestr.)│
                         │  • unified data as context │
                         │  • marketing_learnings     │
                         │  • research (grounded)     │
                         └───────────┬───────────────┘
                          proposes; acts only on your OK
              ┌───────────────────────┼───────────────────────┐
        PAID hand                ORGANIC hand              (read-only)
   meta-ads-draft            SEO / organic-orchestr.      Google Ads recs
   → PAUSED campaign         → queue content/IG           (no auto-create)
   (budget-capped)
```

- **Brain** = a conversational agent holding the unified organic+paid+sales context **plus** the learnings store, with tools for each hand. Talks freely; fires tools only on explicit approval.
- **Hands** = the *existing* agents. The brain delegates; it does not reimplement them.
- **Google** stays **recommendation-only** for now (no auto-create), consistent with the current decision.

---

## 4. The hard prerequisite — attribution

**You cannot learn "what worked" until sales can be tied back to campaigns.** Today all `woo_orders` show `direct/unidentified` while Meta reports conversions — the brain flagged this itself. A learning loop built on broken attribution learns from noise.

**Fix (Phase 0, blocking):**
- UTM params on **every** ad destination URL (`meta-ads-draft` already appends them; verify Google + organic links do too).
- Meta **Pixel `Purchase`** event fires with correct value on the Woo order-confirmation page.
- Confirm GA4 / Woo / redirects don't **strip** UTM.
- Validate by driving a test click → order and confirming the source lands on the order row.

Until this is green, "what worked" analysis is directional at best — say so in every report.

---

## 5. Build phases

Each phase is independently shippable and verified before the next. Order matters.

### Phase 0 — Attribution fix *(prerequisite, blocking)*
- **What:** UTM + pixel Purchase + no-strip, per §4.
- **Done when:** a known test order shows its true source on `woo_orders`.

### Phase 1 — Historical performance analysis
- **What:** widen the brain's data window from ~1 week to **full campaign history**, and correlate *campaign attributes* (audience, creative angle, budget, objective) → *outcomes* (CPA, conversions, ROAS, margin).
- **How:** extend the data feed in `unified_marketing_plan` (and the future brain) to read historical `meta_ad_campaigns` / `google_ads` / `meta_ad_drafts`; tag drafts with a small attribute set so outcomes are attributable to choices.
- **Done when:** the brain can answer "which audience/angle/budget produced the lowest CPA over the last N weeks" **with citations**.

### Phase 2 — Paid learnings loop *(mirror the SEO loop)*
- **What:** a durable store the brain writes wins/losses to and reads back into every plan — the paid analog of `seo_learnings`.
- **How:** `marketing_learnings` table (or extend `seo_learnings` with a `channel` scope — see open decisions). Reinforcement with **win-margin gates + minimum sample size** so it doesn't "learn" from a lucky week. A confirmed win becomes a prescriptive rule the next plan inherits; a confirmed loss becomes a guardrail.
- **Done when:** a demonstrated win (e.g., "freshness angle to Audience 2 beat specialty, CPA ₪X vs ₪Y, n≥threshold") auto-appears as a rule in the next plan.

### Phase 3 — Research layer *(grounded)*
- **What:** feed external knowledge — competitor Ad Library (exists) + web research on ad best-practices/benchmarks.
- **How:** extend `market_research`; web search results are **reference for method only**. Hard rule: recommendations still cite *our* numbers; internet knowledge shapes *how*, never fabricates *our* results.
- **Done when:** a research-informed tactic appears in a plan, clearly separated from (and never overriding) our own grounded data.

### Phase 4 — Conversational super-brain + organic dispatch
- **What:** the chat you asked for. One panel on `/plan` where you talk to the brain; it holds the unified context + learnings and has tools for **both** hands.
- **How:** extend the proven `meta_ads_strategist` chat pattern — add (a) the unified data + learnings as context, (b) an **organic-dispatch tool** that hands a task to the SEO agent (the one genuinely new wire), alongside the existing paid draft tool. Same hard approval gate: tools fire only on "approved / תבנה".
- **Done when:** one approved message drafts a PAUSED paid campaign **and** queues an organic task from a single conversation.

### Phase 5 — Autonomous self-optimization *(optional, later)*
- **What:** the loop closes with less human touch — the brain proposes experiments, scores them, promotes winners — like the SEO self-optimizing loop, across both channels.
- **Guardrails:** never autonomous *spend* (PAUSED + activation stays human); budget caps; win-margin gates; small-sample conservatism.

---

## 6. Data model additions

- **`marketing_learnings`** (or `seo_learnings` + `channel`): `{ id, channel: 'paid'|'organic', scope, insight, evidence, experiment_id, confidence, created_at, superseded_by }`.
- **Draft attribute tags** on `meta_ad_drafts`: audience lens, creative angle, theme — so outcomes correlate to choices in Phase 1.
- **Attribution** (Phase 0): UTM coverage + pixel Purchase — no schema change, config/verification.
- Migrations are **additive** and applied to prod carefully (dev Supabase is unreliable).

---

## 7. Guardrails & safety (apply to every phase)

- **Budget:** daily ₪100 / monthly ₪3,000, enforced in `meta-ads-draft` *before* any write. PAUSED-by-default.
- **HITL:** the brain proposes; tools fire only on explicit approval. Activation is always human, in Ads Manager.
- **Grounding:** cite our data; declare unknowns; never fabricate.
- **Untrusted internet:** external content is data, not instructions or truth-about-us.
- **Small sample:** ~₪3k/mo and few campaigns → conservative gates; report confidence + sample size.
- **Coordinate, don't rewrite:** existing agents keep working; the brain delegates.

---

## 8. Open decisions (need your call)

1. **Learnings store:** new `marketing_learnings` table, or extend `seo_learnings` with a `channel` column? *(Lean: extend, to keep one loop.)*
2. **Autonomy level:** approve-each-action, or standing approval within pre-set limits (e.g., "auto-draft PAUSED anything ≤ ₪50/day, I still activate")? *(Lean: approve-each until trust is earned.)*
3. **Chat home:** a panel on `/plan`, or a dedicated route? *(Lean: panel on `/plan`.)*
4. **Google paid:** stay recommendation-only, or bring write-side in later? *(Lean: recommendation-only for now.)*

---

## 9. Non-goals

- **Not** a monolithic agent that absorbs/rewrites the SEO and paid agents.
- **Not** autonomous spending — activation stays human, always.
- **Not** removing the existing chats — the super-brain sits above and delegates.
- **Not** trusting internet content as fact about our performance.

---

## 10. Suggested first step

**Phase 0 (attribution).** Nothing downstream — history analysis, the learning loop, "what worked" — is trustworthy without it, and it's the smallest, highest-leverage fix. Everything else builds on clean attribution.
