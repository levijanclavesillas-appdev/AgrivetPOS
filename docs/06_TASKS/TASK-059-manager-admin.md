# TASK-059 — A manager's Admin

**Priority:** **P2** · **Rules:** `SEC-6`, `TX-424`, `TX-426`, `TX-427`, `TX-428`, `TX-429`, `LIC-004` · **Tests:** `authz.test.js` (TASK-059), `renderer.test.js`

## What was wrong

The server's matrix (§10) gives a manager:

- settings at `LIMITED` (`TX-424`);
- manual backups and the health panel (`TX-428`);
- export (`TX-426`);
- the audit trail (`TX-429`).

The renderer showed **Admin** to the owner alone, because its rail item needed `TX-423`
(users). So a manager held those rights with no screen to use them from. The Users screen and
`DEPLOYMENT.md` described a manager as "everything except users and settings", which matched
neither the server nor the screen.

## As built

- **The rail.** Admin shows to any role holding one of its tabs' `TX` ids. Each tab carries its
  own id and a role sees only the tabs it holds, so a manager gets everything except Users.
  The tab last chosen is dropped if the new role does not hold it, as when an owner signs out
  on Users and a manager signs in.
- **Settings.**
  - The owner-only settings are shown to a manager, disabled and tagged, and a section's save
    sends only what the role may change.
  - A group of nothing but owner-only settings has no save button.
  - The tax mode (`TX-425`) is stated, not offered.
  - The server already refuses all of this regardless (`settingsService.assertMayChange`).
- **Export / import.** A manager sees only the export. Import and the opening load are
  `TX-427`, the owner's alone.
- **Backups** already offered restore to the owner only. **Subscription** already offered
  linking and "Check now" to the owner only, and the server refuses a manager with
  `LIC-004`.
- **Wording.** The Users screen's role line, `DEPLOYMENT.md`, `04_UX_SPEC.md`, and the
  guide's roles table and Admin "Who" lines now say what a manager actually has.

## Tests

`authz.test.js` (TASK-059) runs as a manager against the real server:

- **Allowed:**
  - every GET the Settings, Audit, Backups, Health and Subscription tabs load with;
  - an export;
  - a day-to-day setting.
- **Refused:**
  - an owner-only setting (`TX-424`);
  - users, the tax mode, import and restore;
  - linking the subscription (`LIC-004`).

`renderer.test.js` checks each tab's `TX`, the filter, the locked settings and the export-only
screen. `TC-UI-13`'s rail walk now reads a rail item's list of ids.

Walked in the renderer against the demo store. Ben (manager) saw Admin with Settings, Audit,
Backups, Export / import, Health and Subscription, and none of them errored. On Settings, 18
of 36 settings were locked and the tax mode was stated. Near-expiry days saved, and there were
no restore buttons. Chachi (owner) still saw all seven tabs, starting on Users.
