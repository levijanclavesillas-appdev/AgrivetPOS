# TASK-045 — A design system, a screen that fits, and three transitions to anything

**Priority:** **P2** — the product works and reads like eight people built it ·
**Blocks release:** no, and it should ship before UAT anyway ·
**Requirement:** `04_UX_SPEC.md` §0, §1 principle 5, §2.1, §8, `NFR_4.3`, `SEC-7`,
`05_TECH_SPEC.md` §2

---

## Objective

Put one design system behind every screen — Material 3, on the platform's own palette — make the
whole product fit the 1366×768 a store PC actually has, and hold every operation to three screen
transitions with a test rather than with a claim.

## Context

**Three things were true at once, and each made the other two harder to see.**

`04_UX_SPEC.md` has cited `/root/AdWebsite/docs/branding.md` §3 since v2.0 of that document —
primary `#2563EB`, canvas `#F8FAFC`, heading `#0F172A`. **The stylesheets never adopted it.** They
ran on `#1f5c3d`, a green nobody specified, with `#fff`, `#f4f7f5` and `#eee` typed in by hand
across eight files, four different border radii and three different shadows. The spec and the
product had been describing different software since v1.0, and the way that shows up at a counter
is that the payments report and the batch list do not look like the same program.

**1366×768 is principle 5 of the same document, and five screens did not fit it.** Measured in a
real window: `SCR-702` was **6,941 px tall** — nine viewports of settings in one column, with the
tab strip somewhere above the fold — then `SCR-705` at 2,259, `SCR-703` at 1,784, `SCR-706` at
1,493 and `SCR-602` at 949. The *document* scrolled on all five, so the rail and the header went
with it.

**And nothing had ever checked the navigation depth.** It turned out to be mostly fine, which is
the answer that only counts if somebody looked.

## Requirements

1. One design system, in one file, that every stylesheet reads from: colour **roles**, type scale,
   shape scale, elevation, state layers, motion and density.
2. Material 3, and **no dependency**: no Material Web Components, no icon font, no Roboto from a
   CDN. `05_TECH_SPEC.md` §2 forbids a framework and a bundler; the shell's CSP forbids a remote
   asset. The specification is implementable without any of them.
3. The brand palette is the source of the colour roles. Not M3's baseline purple, and not the
   green the stylesheets had been using.
4. No hex value, radius or shadow declared outside the system file.
5. **The document never scrolls at 1366×768, in either direction, on any screen.** The shell is the
   viewport and clips; one element scrolls, and it is the screen pane.
6. Density is M3 compact — and `NFR_4.3`'s 44 px is the floor under every control regardless.
   Density is rows and spacing, never the size of a target.
7. **No operation is more than three screen transitions from where a role lands**, checked
   mechanically, per role, against a table in the spec.
8. Every existing screen keeps its class names and its tests. A redesign that renames 160
   selectors is a redesign nobody can review.

## Business Rules

- `NFR_4.3` — 44 px touch targets on POS and payment.
- `SEC-7` — the token is in memory, so an export is fetched and never followed as a link. Unchanged
  by this, and asserted again because a restyle is where that sort of thing gets broken.
- `SEC-6` — hiding a control is a courtesy; the refusal is the control. The rail is role-filtered
  **and** every route re-checks.
- `RPT-101`, `INV-101`, `CR-301`, `POS-510` — every screen that states a rule in words keeps
  stating it. Colour is never the only signal (`04_UX_SPEC.md` §8).

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `public/css/tokens.css` (new), the eight existing stylesheets, `public/index.html`, `public/js/reports/dashboard.js`, `public/js/catalogue/list.js`, `public/js/admin/settings.js`, `public/js/shell/app.js` |
| Schema | **None.** Nothing here reaches the server |
| API | **None** |
| Constraints | No framework, no build step, no remote asset · every existing class name survives · every existing renderer test passes or is updated with its reason |

## Acceptance Criteria

- [x] One token file; no hex, radius or shadow declared anywhere else
- [x] The colour roles are the platform brand's, and `04_UX_SPEC.md` no longer describes a
      different product from the one that ships
- [x] The document does not scroll on any screen at 1366×768 — measured in a real window
- [x] `SCR-702` fits its pane's scroll rather than the page's, under a tab strip that stays put
- [x] Every control a hand lands on is ≥ 44 px, on every screen and not only on POS and payment
- [x] Every screen is within three transitions of every role's landing screen
- [x] Every report is one press from the dashboard
- [x] The full suite and the browser smoke are green

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-UI-01` | The 44 px floor, now read across the whole design system rather than one sheet |
| `TC-UI-13` | The three-transition walk, per role, against `04_UX_SPEC.md` §2.1's table |
| browser smoke | Every rail destination measured in a real 1366×768 window; the settings pane; `SCR-608` in one press; the low-stock filter |

**What the walk found, which is the reason it is a test.** `SCR-204`, the low-stock list, hung off
the dashboard's tile and nowhere else — and the dashboard is behind `TX-421`, which the **inventory
clerk does not hold**. The one screen that says what to reorder could not be opened by the one role
whose job that is. It is now a filter on `SCR-201`. An audit that assumed one rail for everybody
would have called it two transitions and moved on; `TC-UI-13` walks all four roles with the rail
each of them is actually shown.

**Four of the eight reports were three hops away through another report**, and movement analysis
only by way of the *product list*. `SCR-601` now carries an index of every report. The contextual
entries stay beside it — arriving at reconciliation from the payments report carries the range.

**`--touch` beat density, and that was a decision rather than an oversight.** M3 compact would put
a button at 40 px. The four pixels buy nothing: what wins vertical space on a 768 px screen is the
row height above it and the scroll container the shell provides, not a shorter button. So
`--density-field` resolves to `--touch`, density is expressed in rows and spacing, and `NFR_4.3`'s
figure is the floor everywhere rather than on two screens.

**Two departures from M3, both stated in `04_UX_SPEC.md` §0.** Text fields keep a persistent label
above the box — the floating label needs a wrapper and a notched container per field, and there are
some hundreds of inputs written as `label > input`. And there is no ripple: it is a JavaScript
component, and a listener on every button is a framework by instalments. The state layers are the
same specification's hover, focus and pressed opacities, in CSS.

**The sticky bars, which took two goes.** A pane has one sticky bar and it is the screen's own.
The first attempt broke that twice over, and both read to the operator as *the top bar is cut*:

* On the catalogue the search bar is **not** the first thing in the screen — the header is — so the
  negative-margin trick the report header uses did not apply, and a `box-shadow` reaching 16 px
  upward was used instead to paint over the pane's padding. A background that reaches upward covers
  whatever is up there, and what was up there was the bottom of the header's buttons. "New product"
  came out sliced along its lower edge. The two now stick as a **pair**: the header at minus one
  padding, the search bar at the header's own height. A sticky offset is measured from the
  scrollport's *padding box*, not its border box, which is why those two numbers cancel.
* And `thead th` was made sticky in the system file, which was a mistake in both directions. Where
  a screen bar existed the table header pinned itself **underneath** it and vanished; where the
  table had a `border-radius` with `overflow: hidden` it did not stick at all, because that makes
  the table its own clipping context and sticky has nothing left to stick to. It is gone, and
  `04_UX_SPEC.md` §4 now says what a table's header does and why.

The report bar was also two rows and 88 px tall, because the date fields stacked their labels
above them. It is one row and 72 px now — on the bar that never scrolls away, that is 16 px of 741
somebody gets back on every report.

**And then every screen was audited for the same fault, which found three more.** The rule was
written as `.catalogue > .admin-head`, so on `SCR-401`, `SCR-801` and `SCR-804` the search bar
pinned with **nothing above it** and rows scrolled visibly through the 60 px band over its head. On
`SCR-202` the header and the editor's own tab strip both claimed the top and overlapped by 61 px.
The rule is now the shell's rather than the catalogue's: it names the six screen roots whose header
is their first child, and the second bar — a search bar or a tab strip — pins at `--touch`, the
header's row. `.admin > .admin-head` is deliberately not in that list: those panels sit under
`SCR-701`'s tab strip, which is already that pane's sticky bar.

The audit walks all 34 screens twice, unscrolled and scrolled, and asks four questions: does the
document scroll either way, is any bar pinned above the top of the pane, do two bars overlap, and —
with `elementFromPoint` rather than geometry, because a row scrolled under a bar still has a box up
there — does anything paint over one. It reports nothing on any of them.

**The same four questions are now asked by the smoke**, at every place it already measures a screen
against 1366×768 — so a screen added later with a bar pinned above the pane, two bars claiming the
same 60 px, or a background reaching over the one above it, fails a walk rather than a counter.

**And the counter itself, which was the one screen never measured with anything on it.**
`SCR-301` was audited empty — the walk had no shift open — so what was checked was the "open your
shift" state. Measured properly, with 1, 8 and 20 lines on the counter, the layout holds exactly as
`04_UX_SPEC.md` §8 promises: the document never moves, the pane never scrolls, the **cart scrolls
inside itself** (84 px at eight lines, 1,056 px at twenty) and the totals rail, the total, the
56 px Pay button and the key bar stay where they were. The search list and `F3`'s quantity prompt
both stay inside the window.

**What was wrong there was not the layout.** The totals rail printed the word **`null`** under the
Pay button — on every ordinary sale, on the screen this product is for. `h()` skips a null child;
`Element.append()` is the DOM's own and coerces it to the *string* `"null"`, and the rail's last
block is `priced?.requires_authorisation ? authorisations() : null` handed straight to it. The
payment screen already filtered for exactly this reason; this call site never had. It is a v1.0
defect that eleven months of tests walked past, because every assertion about that rail asked
whether a figure was right rather than what else was on it.

So the smoke now asks, at every screen it measures: does anything on this screen read `null`,
`undefined`, `NaN` or `[object Object]`? `pre`, `code` and `textarea` are out of scope — `SCR-703`
shows an audit row's before and after as JSON, and a null in there is the value. Every other screen
is clean.

**What was not done.** `SCR-705` is still about three panes of scrolling — it is a diagnostics page
read top to bottom, and a column layout would interleave its headings with the wrong tables. The
shell still has no top app bar, which `04_UX_SPEC.md` §2's diagram has described since v1.0: it
would cost 64 px of 768 to show a store name that does not change, and the rail already carries the
user. Both are noted here rather than quietly left.

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
