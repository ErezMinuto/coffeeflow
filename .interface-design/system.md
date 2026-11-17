# Design System: CoffeeFlow

Internal tool for Minuto Café, a specialty coffee roastery (בית קלייה) in Rehovot. About three people use it every day: logging roasts at the roaster, packing bags, checking stock, building the weekly schedule. Hebrew, right to left. Direction approved by Erez on 2026-11-17 (mockup: `docs/design/coffeeflow-redesign/after.html`).

## Direction

**Personality:** Utility & Function, with warmth. It should feel like a well-kept roastery logbook: calm paper, dark ink, one olive stamp of colour. Not a SaaS template, not a "coffee theme".

**Foundation:** warm (paper `#F7F6F2`, warm greys).

**Depth:** borders-only. Hairline `#E6E3DB` borders on white surfaces. Shadows exist only on things that float above the page (menus, the phone drawer, toasts, modals).

**Who and when:** someone at the roaster or the packing table, often on a phone, between tasks, checking one number or logging one action. Speed of reading beats decoration. Every number on screen comes from real data.

**Signature:** the olive accent is used for exactly two things, the primary action and "where you are" (active nav). Everything that needs attention is a small dot or tag in muted red/amber, never a big coloured box. Figures are tabular so columns of kilos and shekels line up.

## Tokens

All on `:root` in `src/App.css`. Pages use tokens, never new hex values.

### Spacing
Base: 4px
Scale: 4, 8, 12, 16, 20, 24, 28, 40
- Page gutter 40px desktop / 16px phone; 24px between sections; card padding 18–20px.

### Colors
```
--bg:          #F7F6F2   paper, page background
--surface:     #FFFFFF   cards, sidebar
--surface-2:   #FBFAF7   table heads, row hover
--sunken:      #F1EFE9   hover fill, meter track
--line:        #E6E3DB   hairline borders
--line-strong: #D6D2C7   control borders
--ink:         #1C211A   primary text
--ink-2:       #4A5045   secondary text, nav
--muted:       #7A7F73   labels, metadata
--faint:       #A3A79C   placeholders
--brand:       #3D4A2E   Minuto olive, the only accent
--brand-hover: #2F3A23
--brand-soft:  #ECEFE4   active nav, selected
--danger:      #B42318 on --danger-soft #FDF1EF
--warn:        #A15C07 on --warn-soft #FCF5E8 (dot #D9921C)
--ok:          #3F6B2A on --ok-soft #EEF3E8
```
Legacy `--minuto-*` / `--coffee-*` names are aliases of these.

### Radius
10px cards (`--radius`), 8px controls and nav items (`--radius-sm`), 6px tags, 999px counts and meters.

### Typography
Font: Heebo (Google Fonts) 400 / 500 / 600. One family for everything.
Scale: 12 (tags, counts), 12.5 (table heads, meta), 13 (labels, links), 14 (base), 15 (card titles), 17 (section h2), 24 (page h1, 22 on phones), 28 (KPI values, 24 on phones).
- Headings 600 with -0.015em tracking; KPI values 500 with -0.02em.
- Hierarchy from size + weight + the ink / ink-2 / muted / faint ramp together.
- `font-variant-numeric: tabular-nums` on every figure (`.num`, `td`, KPI values).

### Icons
lucide-react 0.460.0, stroke 1.7, 16–18px, `aria-hidden` next to a text label. No emoji as icons.

## Patterns

### App shell
- Sidebar on the right (RTL), 248px, white, hairline inline-end border, sticky full height.
- Groups: סקירה / ייצור (זנים, קלייה, מוצרים, אריזה) / תפעול (משימות, סידור עבודה, נוכחות, יומן רכב, חשבוניות ספקים) / הגדרות. Group labels 12px muted.
- Nav item: 40px min height, 8px radius, ink-2 text, muted icon; active = brand-soft fill + brand text and icon. Counts are 20px pills in danger/warn soft tints.
- ≤860px: sticky top bar (logo, avatar, menu button); sidebar becomes a 300px drawer from the right, 300ms `cubic-bezier(0.32,0.72,0,1)`, scrim 32% ink, closes on navigation / Escape / scrim.

### Page header
h1 24px/600 + one muted line of context; actions on the opposite side, primary action last (leftmost). Stacks on phones with actions full width. `PageHeader` in `src/components/shared/ui.jsx`.

### Button
- Default: 38px h · 0 14px · 8px radius · 14px/500 · white with `--line-strong` border.
- Primary: brand fill, white text. Danger: danger text, pale red border. Ghost: no border.
- Small: 32px h · 0 11px · 13px. Icon-only `.btn-icon`: 40×40, transparent until hover.
- Press `scale(0.97)` 160ms `cubic-bezier(0.23,1,0.32,1)`; hover only under `(hover:hover) and (pointer:fine)`; focus = 3px olive ring at 22%.

### Card
White, 1px `--line`, 10px radius, 20px padding, no shadow. `.card.flush` + `.card-head` (52px min, 15px/600 title, muted meta or olive text link) for lists and tables.

### KPI strip
One card split by hairlines, never separate boxes. Label 13px muted → value 28px/500 tabular (+ small muted unit) → one muted note that says where the number comes from. 4 across, 2×2 on phones.

### Needs-attention list
Row: 8px status dot · item (500) over reason (13px muted) · "go fix" link at the end (ink-2, chevron, hover fill). Danger first, then warn. Replaces stacked coloured alert boxes.

### Meter
6px track in `--sunken`, olive fill; amber at or below minimum, red at zero (2% sliver so it still reads).

### Table
Head 12.5px/500 muted on `--surface-2`; cells 12px 16px; hairline rows; row hover `--surface-2` (pointer devices only). Numeric columns left-aligned (`th.end/td.end`). Wide tables scroll inside their card; secondary columns `.hide-sm` on phones.

### Tag / notice
Tag: 6px radius, 12px/600, soft tint + strong text. Notice (`.notice`) only for a real message, soft tint with a hairline border, no thick side stripe.

### Forms
Inputs/selects 38px, 1px `--line-strong`, 8px radius, olive focus ring; global rules at zero specificity (`:where`) so page rules win. 16px font on phones (stops iOS zoom). Labels 13px/500 ink-2 above the field.

## Decisions

| Decision | Rationale | Date |
|----------|-----------|------|
| Borders-only depth | Tool used many times a day; shadows add weight without information. Floating layers are the only exception. | 2026-11-17 |
| Olive as the single accent | Minuto's brand colour; reserving it for action + location keeps it meaningful. | 2026-11-17 |
| Status as dots/tags, not boxes | The old stacked red/yellow boxes made the dashboard shout; a list of dot + reason + link is calmer and actionable. | 2026-11-17 |
| Heebo, one family | Hebrew-first sans with good numerals; display faces don't belong in labels and data. | 2026-11-17 |
| Right-side sidebar instead of top navbar | 10+ destinations with Hebrew labels didn't fit a top bar (it mixed English labels and wrapped on phones). | 2026-11-17 |
| Page CSS in page-scoped files | Parallel page PRs must not collide in App.css; shared rules stay in the foundation section. | 2026-11-17 |
| Only real numbers on the dashboard | "קליות החודש" used to count every roast ever; every KPI states its source. | 2026-11-17 |
