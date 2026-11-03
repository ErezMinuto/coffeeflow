# Image pipeline rebuild plan

Based on the research report (`research.md`, *AI brand image pipeline design*) and an audit of the current pipeline (strategist → `visual_generation` → `seo-worker-visual` QA loop → `visual-test` render → `organic-worker-instagram` → owner review).

## Why patching stopped working

The research names three structural causes. Each one matches something we measured.

| Cause (research) | What our pipeline does today |
|---|---|
| Models follow **one consistent, positive scene description**. Rules stacked in layers and "override" blocks have no documented effect. Naming a forbidden object can pull it into the image. | One image is built from about 10 layers: the agent's brief, a Gemini rewrite, the identity sections, a structured interpretation, the forced random surface ("AUTHORITATIVE"), the forbidden list, a "FINAL OVERRIDE… prior text is inspiration" block, the attempt-3 tail and the critique "AVOID" lines. They contradict each other: hands are allowed by one section and banned by the final override. The final override bans "a kettle" in a grinder scene, and says "render ONLY the bag" in a no-bag scene. |
| Models reliably fail at **pours, hands, contact and support**, and at **non-Latin label text**. No prompt fixes this. | About half of our posts are hand or pour scenes (76 of 151 since Aug 1). Every image you reported was one of these: floating dripper, two left hands, portafilter pouring onto a table. Every Dark Chocolate bag render had garbled Hebrew. |
| Teams that succeed use an **approved menu of scenes anchored on real assets**. They don't feed free-form agent briefs straight into the generator. | The strategist writes free-form briefs: "a single bean dropped into a glass of water", "a coffee leaf with dew". Your rejection reasons: "off brand" (twice), "not a logical image", "no correlation between the text and the image", "same images as yesterday". |
| Vision judges are unreliable on **absolute pass/fail**, even at temperature 0. Atomic yes/no questions, crops and majority votes are reliable. | One long rules prompt and a single verdict. The same floating-dripper image passed on some runs and failed on others. |

The conclusion: the generator should never be asked to invent a scene it can't draw. The fix is to change **what we ask for**, not to keep refining **how we ask**.

## Target architecture

```
strategist: topic + Hebrew caption ──then picks──▶ SHOT TYPE + slots (product, mood)
                          │      (no free-form scene text)
                          ▼
            shot library entry  ─ inputs: real photo(s) / bag photo
                          │      ─ fixed positive prompt skeleton (≤150 words)
                          │      ─ own yes/no QA checklist
                          ▼
   visual-test: compose ONE scene description in code → render (or edit the real photo)
                          ▼
   seo-worker-visual: per-shot checklist (describe → yes/no → crops), one pass
                      + caption/image match check → fail? evergreen library photo
                          ▼
   owner review (flagged images in queue only, not emailed) → publish
                          ▼
   log verdict + reason by shot type / prompt version → golden-set regression
```

This stays inside the existing edge functions (`visual-test`, `seo-worker-visual`, `organic-worker-instagram`). No new functions or bots.

## The shot library (first version)

Each entry is a scene the model can render reliably. It fixes the inputs, the prompt skeleton, the variables the strategist can fill and the QA checklist.

| # | Shot type | Source | Why it's safe |
|---|---|---|---|
| 1 | **Bag hero**: bag on a surface, optional beans or cup beside it | Real photo of the bag on the counter | Label is never redrawn |
| 2 | **Bar moment**: espresso pull, steaming, latte pour at the Strada X | **Edit of a real photo** (machine, hands, pitchers) | Hands and machine are real; the edit only reframes and relights |
| 3 | **Roastery**: roaster, cooling bin, beans dropping | Edit of a real photo (roaster) | Scale and anatomy are real |
| 4 | **Brew ritual**: V60, AeroPress, grinder with hands | Edit of a real photo (brewing, hands) | Pours and contact are real |
| 5 | **Finished drink still life**: cup on a surface, top-down latte art, no hands | Generated | Static, single subject, no physics |
| 6 | **Beans close-up**: roasted beans in a dish, a handful on wood | Generated + a real bean photo as reference | Static |
| 7 | **Bag + drink pairing**: bag next to a finished cup | Real photo of the bag with a cup | Static, real |

**Not in the library, so the strategist can't pick them:** fully generated hands, pours or action scenes; origin, farm and leaf scenes (off brand, and Minuto has no real origin photos); "concept" scenes like a bean in water.

## Label fidelity (bag shots): decided

**Real bag photos only** (owner decision, 2026-10-28). Bag shots (types 1 and 7) use real photos of Minuto bags on the counter, reframed and relit at most. The bag is never generated or redrawn. No new vendors (no Bria or Photoroom). A real photo has authentic Hebrew at no cost. This removes the Phase 3 bake-off.

## The prompt (Phase 2)

- Code builds **one** scene description from the shot skeleton and its variables: subject, what each object rests on or who holds it, surface, light, framing, aspect. All positive phrasing. At most one or two general exclusions, such as "no text or logos besides the bag label".
- **Delete:** the Gemini brief rewrite, the "FINAL OVERRIDE" block, the forbidden list, the "structured interpretation" block, the forced random surface (surface becomes a variable of the shot type), the attempt-3 tail, and the critique "AVOID" lines appended to retries.
- Retries generate fresh candidates from the **same** clean prompt. The prompt doesn't grow between attempts.
- Cheap model checks, run against the golden set: Gemini thinking level "high" (the default is minimal), Gemini 3 Pro Image, and the newer Nano Banana 2.1.

## QA (Phase 4)

**Owner refinement:** keep it light. One atomic checklist pass per image, no tournaments. If an image fails, fall back to an **evergreen library photo** instead of looping. Supabase edge time is limited. Which judge model (Opus, Sonnet, Haiku) is decided by the calibration step below, not assumed. Opus is the one that caught the two-left-hands case.

- **A checklist per shot type** of atomic yes/no questions. For a bar moment, for example: "Is the portafilter locked into the group head?", "Does the cup stand on the drip tray?", "Are there exactly 1 or 2 hands, one left and one right?". Questions depend on each other: no hand questions if there's no hand.
- **Describe first, then answer.** No generic "think step by step", which the research shows makes agreement with humans worse.
- **Zoomed crops** of hands, contact points and the label.
- ~~Majority of 3 votes / best of 3~~: dropped for edge-time budget (owner). Revisit only if calibration shows single-pass verdicts are unstable.
- **Caption match:** "Does this image show what the caption talks about?", which targets your "no correlation" rejection.
- **Calibrate before trusting it:** re-judge the posts you already decided on (66 published, 11 rejected) and measure agreement before the judge can reject anything on its own.

## Real photo library (Phase 5, needs you)

About 50 photos exist today (12 roaster, 13 machine, 7 hands, 8 cups, 7 brewing, 3 beans, plus bags and pitchers). One short shoot covers the gaps the library needs, about 30 phone photos:
- V60 pour with a hand on the kettle (3)
- AeroPress press (2)
- Hand grinder in use (2)
- Tamping (2)
- Latte pour (3)
- Cooling bin with beans (3)
- Beans in hand and in a dish (4)
- Bag on the bar counter, in daylight and lamp light (4)
- Cups on the drip tray (3)
- Wide bar and roastery shots for context (4)

## Evaluation and rollout

- **Phase 0: Measure and freeze (first).**
  - Golden set: about 25 past briefs, including every image you reported or rejected.
  - Stamp `prompt_version` and `shot_type` on every task.
  - A weekly approval rate by shot type, built from the review decisions you already log.
  - Park PR #453: it's another patch on the old prompt. Keep PR #432 (don't email flagged posts).
- **Phase 1:** Shot library and strategist change. **Order is caption first** (owner): the strategist picks the day's topic and writes the Hebrew caption, *then* picks the shot type that matches it and fills its variables. No free-form scene text. A rotation log puts a cooldown on recently used shot, product and surface combinations ("same images as yesterday").
- **Phase 2:** Prompt rebuild. For the generated still lifes (types 5 and 6): at most 1 reference image, aspect ratio set in the API config (already pinned), and a positive prompt of about 50 words with no negative lists or overrides (owner).
- ~~Phase 3: Label fidelity test~~: decided, real bag photos only.
- **Phase 4:** QA redesign and judge calibration.
- **Phase 5:** Photo shoot. Can happen in parallel with Phases 1–2.
- **Gate for every change:** before deploying, re-run the golden set with old and new side by side on a review page where you pick per image. Ship only if the new version wins. The old pipeline stays as a per-shot-type fallback until each shot type passes.

## Decisions (2026-10-28)

1. **Approved:** fixed shot-type menu; the strategist no longer writes free-form scenes.
2. **No new vendors:** bag shots use real photos of the bag (Option C, real photos only).
3. **Approved:** owner takes about 30 phone photos for the library.
4. **Approved:** #453 parked (draft), #432 kept, Phase 0 started.

## Phase 0 status

- **Done in the Phase 0 PR:**
  - `purge-old-media` keeps renders behind posts the owner published or rejected. Before this, `ig-test/` was purged after 4 days and only 8 of 77 decided images survived.
  - Every render carries `prompt_version` (today `layered-v1`).
  - `scripts/image-pipeline.sh report` gives approval rate by prompt version and scene type.
  - `scripts/image-pipeline.sh golden` builds `golden_set.json`: 35 briefs, of which 11 rejected, 7 reported bad, 17 published.
- **Baseline (layered-v1, Aug 1 – Oct 28):** 151 posts; 66 published, 11 rejected, **74 never reviewed**. The high approval rate among decided posts hides that half were never looked at, and the daily bad images reported in chat.

## Phase 1 status (2026-10-28): shot library built, flag OFF

**What's built:**
- **Shot library:** `supabase/functions/_shared/shot_library.ts`, with 7 shots, all enabled. Each shot has its prompt or edit brief, a yes/no QA checklist, and a router prompt that maps an old free-form brief onto the menu.
- **Real-photo shots, published as photographed:** bag hero, bag with drink, bar moment and roastery. There's no image-model edit; that rotated, re-staged and invented things in testing. `scripts/image-library-prep.sh` prepares the library offline:
  - a subject-aware crop to 9:16, 4:5 and 1:1 (the bag always stays whole);
  - the owner-approved house look: a warm grade, a little contrast, light sharpening, no blur;
  - a blur patch over each car licence plate.

  The output lives in `marketing/upload_images_ready/`. Exclusions are in `library_exclude.txt` (readable order tickets, green coffee, bad crops). Bag photos are chosen by product file name (`bag_scenes/<slug>_*.jpg`); the 14 photos from the owner's shoot cover 7 products, and the others fall back to their packshot.
- **Generated shots:** brew ritual, finished drink and beans close-up. Each uses ONE real reference photo (the equipment, cup or beans) and a short positive prompt for a still scene. Pours and hands come only from real photos.
- **Worker:**
  - `seo-worker-visual`'s `handleShot` handles `ig_post` visuals that name a `shot_type`, or every `ig_post` visual when `SHOT_LIBRARY_ENABLED=true`.
  - QA is one pass of the shot's checklist, and an eval that can't run counts as a fail.
  - Photos used in the last 21 days are skipped.

**Golden set (35 real briefs):** 28 pass and 7 are flagged for real defects. None fail to render. All 7 previously reported-bad briefs now produce clean images. Review page: https://claude.ai/artifact/WydvDwiwqp763ngxgjrrJ6

**Next (Phase 1b / 2):**
1. Deploy `visual-test` and `seo-worker-visual`. With the flag still off, nothing changes for briefs without a `shot_type`.
2. Update the planner prompts (mission-worker IG cadence, organic-orchestrator, strategist-executor, chat) so they write the caption first, then pick a `shot_type` and slots from `plannerShotMenu()`.
3. Set `SHOT_LIBRARY_ENABLED=true`, watch the first days of posts, and compare `./scripts/image-pipeline.sh report` by `prompt_version`.
4. Owner shoot, still open: V60/AeroPress/grinder with hands, latte pour, beans in hand, cooling bin. After uploading, run `./scripts/image-library-prep.sh <folder>`.
