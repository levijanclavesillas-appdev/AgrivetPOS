# TASK-050 — Lucide icons, vendored, beside the words they illustrate

**Priority:** **P2** · **Blocks release:** no · **Branch:** `pharmacy` · **Requirement:**
`04_UX_SPEC.md` §8 (the collapsed rail; colour is never the only signal), `05_TECH_SPEC.md` §2,
`TASK-045` requirement 2

---

## Objective

Use Lucide icons across the UI, as the client asked, without adding a dependency, a font or
a remote asset.

## Context

The client asked:

> use Lucide Icons for the ui.

**The spec already required icons in two places, and neither had any.** `04_UX_SPEC.md` §8 says
that below 1024 px the drawer "collapses to M3's navigation rail — icons only". `pos.css` did
hide the labels, but there were no icons, so the collapsed rail was a column of empty buttons
with no accessible name. The same section says "colour is never the only signal: variance,
overdue and low stock each carry an icon or a word beside the colour". Low-stock and expired rows
had only a coloured border.

**The constraints are `TASK-045`'s.** No icon font, nothing from a CDN (`index.html`'s CSP is
same-origin with no exception), and no new runtime dependency (`05_TECH_SPEC.md` §2). Lucide fits
all three: every icon is a small SVG, and the ISC licence permits copying with the notice.

## Requirements

1. The icons are **vendored**, not installed. `tools/icons/build.js` reads Lucide's
   `icon-nodes.json` from `npm pack lucide-static@1.45.0` and writes only the icons the renderer
   uses, with the ISC notice, into `public/js/shell/icons.js` and `public/css/icons.css`.
2. The set is **derived from use**. The tool scans the renderer for `icon: '…'`, `iconEnd: '…'`,
   `icon('…')`, `iconSvg('…')`, `@icons …` and `var(--icon-…)`. A test fails if a name is used
   and not vendored, or vendored and not used.
3. `h()` takes `icon` and `iconEnd`, so a button gains an icon with one attribute and the icon
   sits beside the words.
4. Every rail section has an icon, and every icon-only control has an accessible name
   (`aria-label` and `title`).
5. The text glyphs `←`, `→` and a close `×` on buttons are replaced by `arrow-left`,
   `chevron-left`, `chevron-right` and `x`.
6. Status is a shape as well as a colour. A shift verdict (balanced, within, beyond tolerance),
   an overdue tag, a low, overdue or expired row, and the opening panel's result each carry an
   icon, drawn by the stylesheet as a mask so the class brings it wherever it is used.
7. Icons are decorative (`aria-hidden`) and drawn in `currentColor`: 18 px in a button, 24 px in
   the rail.

## Business Rules

- `SEC-7`, `SEC-8`: unchanged. The CSP gains no exception: CSS icons are `data:` URIs, which
  `img-src` already allows, and the SVG namespace in them is an identifier, not an address.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `tools/icons/build.js` (new) · `public/js/shell/icons.js`, `public/css/icons.css` (generated) · `public/js/shell/ui.js` (`h()`) · `public/js/shell/app.js` (rail) · `public/css/tokens.css` (sizes, status icons) · `public/css/pos.css` (rail) · `public/setup.html`, `public/js/setup.js`, `public/css/app.css` (wizard) · about thirty screens, one attribute each |
| Schema | **None** |
| API | **None** |
| Constraints | 48 icons in JS and 4 in CSS: 12.5 KB, no request, no font, no framework |

## Acceptance Criteria

- [x] No icon is fetched, and none is a font. The CSP is unchanged
- [x] The collapsed rail below 1024 px shows an icon per section, and each is named. Checked in
      a real 900 px window
- [x] Back links, paging, dismiss and the main actions carry icons; Cancel, Done and Apply
      deliberately do not
- [x] Shift verdicts, overdue tags, and low, overdue or expired rows show an icon as well as a
      colour
- [x] The wizard's stepper checks off finished steps; the brand mark is Lucide's `pill`
- [x] The full suite is green

## Tests

| Case | Asserts |
| :--- | :--- |
| `renderer.test.js` | Vendored set equals used set (JS and CSS); no remote URL; the ISC notice is present; no button draws an arrow or × in text; the rail's icon-only controls are named; every rail section has an icon; the four status rules name their icons |
| browser smoke | Every screen renders with the icons in place and the renderer logs no errors (436 checks); `SCR-304`'s way back is found by its icon |
| `TC-E2E-08` | The renderer carries no remote asset; the SVG namespace in `icons.css`'s data URIs is exempted by name, because it is an identifier and not an address |

**Status — 2026-09-14:** closed on the `pharmacy` branch, in the commit after `0dccd58`.
