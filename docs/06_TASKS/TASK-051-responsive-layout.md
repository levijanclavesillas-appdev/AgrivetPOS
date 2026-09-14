# TASK-051 — Every screen fits a phone, a tablet and a desktop

**Priority:** **P1** for the Android app · **Blocks release:** the phone build · **Branch:**
`pharmacy` · **Requirement:** `04_UX_SPEC.md` §8, `NFR_4.3`, `TASK-045`, `TASK-049`

---

## Objective

Make the product usable on any screen from a 360 px phone to a desktop, without changing how it
looks at the 1366×768 it was designed for.

## Context

The client, after installing the Android build on a phone:

> the android app does not adapt phone screen
>
> make the design responsive to mobile and other screen sizes

`TASK-045` designed for 1366×768, and the only narrow rule collapsed the rail to icons below
1024 px. On a 412 px phone the rail took a sixth of the width, the product list's search box grew
350 px tall (in a stacked column its `flex-basis: 22rem` became a height, which also affected
tablets), tables ran past the edge with no way to reach their last columns, the POS squeezed its
cart beside a fixed 20 rem totals column, and the app was locked to landscape.

## Requirements

1. M3's window size classes. **Expanded** (≥ 1024 px): the labelled drawer, as before.
   **Medium** (600–1023 px): the icon rail. **Compact** (< 600 px): a top app bar naming the
   section, and its menu button opens the same navigation as a modal drawer with a scrim.
2. The document never scrolls sideways at any size from 360 px.
3. Under 900 px the POS stacks: the cart on top, scrolling in itself; under it, a panel capped at
   half the height with any authorisation first, then the total and **PAY**, then the customer.
4. Every list table sits in a `.table-scroll`, so a wide table scrolls inside itself and a narrow
   one still fills its card. On a phone a list row stays one line.
5. On a touch screen the F-key hints on buttons (`PAY  F9`) and the F-key strip are hidden; the
   button's text is unchanged.
6. The Android app follows the device's orientation.
7. 1366×768 is untouched: the browser smoke passes unchanged.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `public/css/pos.css` (window sizes, drawer, POS), `tokens.css` (tables, touch), `catalogue.css` (search box), `app.css` (wizard on a phone), `public/js/shell/app.js` (top app bar, drawer), `shell/ui.js` (key hints), 22 tables wrapped in `.table-scroll` across the screens, `android/.../AndroidManifest.xml` (orientation) |
| Schema, API | **None** |

## Acceptance Criteria

- [x] No element runs past the screen edge on 18 screens (sign-in, dashboard, POS, a cart,
      payment with a GCash row, products, the editor, customers, a profile, shift, reports, a
      report, admin, settings, export/import, buying, returns, the wizard) at 360×740, 412×915,
      768×1024, 915×412, 1024×768 and 1366×768. Measured in a real Electron window
- [x] The drawer opens from the top app bar, closes on a choice, on the scrim and on Escape, and
      returns focus to the menu button
- [x] The browser smoke passes unchanged at 1366×768 (436 checks)
- [ ] Used on the client's phone. **Not done:** a phone build is the client's to install

## Tests

| Case | Asserts |
| :--- | :--- |
| `renderer.test.js` | The three window sizes: labels hidden on the medium rail; on compact, a top app bar and a drawer that slides away rather than being removed |
| browser smoke | 1366×768, unchanged |

**Status — 2026-09-14:** built on the `pharmacy` branch.

**Follow-up — 2026-09-14, the setup wizard (client: "still not responsive … on the set up
screens").** The first pass checked the wizard for sideways overflow, and it had none, so it
passed. What was wrong was the layout:

- **The header ballooned.** The stacked wizard was a grid with a minimum height, so the rail
  row stretched: half of a tablet portrait screen was an empty header, and a third of a phone's.
  It is a flex column now.
- **Next was a scroll away.** The action bar is sticky, but the card's `overflow: hidden` made
  it stick to nothing. On anything narrower than the card, the page scrolls, nothing clips, and
  Back/Next stay on the bottom of the screen, above the Android navigation bar
  (`safe-area-inset-bottom`).
- **Phones and landscape phones get a one-line header**: the brand, *Step 3 of 5 · Owner*, and
  a progress bar. The step list and title stay for a screen reader. Fields go one to a row,
  Back and Next share the bar at thumb width, and the two choices after setup stack.
- After setup, three things on the first screens: dashboard tiles on a phone centred their
  figures at a different place each (a grid inside a `<button>` sized to its text); the admin
  tab strip scrolls the chosen tab into view; and Subscription, when unlinked, says what to
  press rather than where to go.

Walked at 360×640, 390×844, 844×390, 800×1280, 1280×800 and 1366×768 through all six steps,
an error, the recovery code, sign-in, the dashboard and Subscription: no sideways overflow at
any size, and the desktop card unchanged. The browser smoke passes at 1366×768.

