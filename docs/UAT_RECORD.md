# UAT record — Chachi Agrivet POS v1.0

`07_TEST_PLAN.md` §8, executed on the **store's own hardware**, before go-live.

This is the eleventh release-gate criterion and the only one that cannot be automated.
Everything else in the gate is assertable by `npm run test:all`; this is a person in a
store, with the store's scanner, printer, drawer and PC, on the store's mains power.

**It is filled in on the day, by hand, in ink.** A pre-ticked UAT record is not evidence
of anything, and a gate table of ticks nobody checked is worse than an honest one with a
gap (`TASK-018` requirement 12).

---

## Before starting

| | |
| :--- | :--- |
| Store | Chachi Agrivet, Poblacion, Sultan Kudarat |
| Tax mode configured at install | **`NONE`** — not BIR-registered (`TAX-001`, `Q-1`) |
| Machine | Make/model: ______________________  RAM: ______  Screen: ____________ |
| Windows version | ______________________ |
| Printer | Make/model: ______________________  Width: 58 mm ☐  80 mm ☐ |
| Scanner | Make/model: ______________________ |
| Drawer | Connected via the printer ☐  Not fitted ☐ |
| Installer version | `ChachiAgrivetPOS-Setup-________.exe` |
| Date | ______________  Performed by: ______________________ |

The reference machine in `NFR_4.1` is Windows 10/11 x64, 4 GB RAM, dual core, 1366×768.
**If the store's machine is better than that, say so** — a pass on faster hardware does not
establish the budget, and `NFR_1.1`–`NFR_1.5` are measured on the reference spec.

---

## The ten checks

| # | Check | Pass when | Result | Notes |
| :-: | :--- | :--- | :--: | :--- |
| 1 | Scanner adds items without a driver install | 20 consecutive scans, no misses | ☐ | |
| 2 | 58 mm and 80 mm receipts print legibly | Both layouts checked against the real printer | ☐ | |
| 3 | Drawer opens on a cash sale | Physical drawer opens | ☐ | |
| 4 | Feed sold by sack and by kilo | On-hand matches a physical count afterwards | ☐ | |
| 5 | A real credit customer's balance matches the notebook | Reconciled at cutover | ☐ | |
| 6 | A full day's takings reconcile at close | Variance ≤ ₱50 | ☐ | |
| 7 | Unplug the PC mid-sale | Restart is clean, no phantom sale | ☐ | |
| 8 | Backup file exists and opens after close | Verified in `SCR-704` | ☐ | |
| 9 | Cashier cannot see cost or reach settings | Confirmed on their own login | ☐ | |
| 10 | Receipt carries "This is not an official receipt" | Printed and read on paper | ☐ | |

### Notes on the ones that are easy to do badly

**Check 1 — twenty scans.** Twenty in a row, at the speed a cashier actually works, not
twenty over five minutes. A scanner that drops one keystroke in fifty passes a slow test
and fails at the counter. Scan the same item twenty times if that is what is to hand.

**Check 2 — both widths.** The receipt layout is different at 32 and 48 columns and both
are built. Set the width in Settings, print, read the paper, set it back. A line one
character too long does not error on a thermal head; it wraps mid-figure, and ₱1,234.56
becomes ₱1,234 on one line and .56 on the next.

**Check 7 — pull the plug.** Not a shutdown, not a force-quit: the mains plug, in the
middle of ringing a sale. This is the only check that establishes the half of `OPS-008`
the automated `TC-E2E-09` cannot — `SIGKILL` kills a process but leaves the operating
system's write cache intact, and it is that cache a power cut empties. Afterwards: start
the application, confirm the interrupted sale is either wholly there or wholly absent, and
confirm the sales before it are all present.

**Check 10 — on paper.** Read it on the printed document, in the store's own tax mode. Not
on the screen, not in a preview. `TAX-006` is a legal requirement about a physical piece of
paper handed to a customer.

---

## Additional checks for this release

These are not in §8 and are recorded because `TASK-018` requires them.

| # | Check | Pass when | Result | Notes |
| :-: | :--- | :--- | :--: | :--- |
| A | Clean install reaches `SCR-001` | No administrator prompt appears at any point | ☐ | |
| B | `%LOCALAPPDATA%\ChachiAgrivetPOS\` created | `agrivet.db`, `session.key` present | ☐ | |
| C | Cold start to the login screen | ≤ 8 s, timed with a phone (`NFR_1.4`) | ☐ | ____ s |
| D | Upgrade over a prior install | Data preserved, pre-migration backup written and verified | ☐ | |
| E | Uninstall | `agrivet.db` and the backup folder still there afterwards | ☐ | |
| F | A full trading day with the machine's networking switched off | `TC-E2E-08` — Wi-Fi off and cable out, at the wall | ☐ | |
| G | Restore a backup onto a **second machine** | The day's trading appears on the other PC | ☐ | |
| H | Handover signed | `docs/HANDOVER.md` §1 and §2 read aloud and initialled | ☐ | |

**Check F — off at the wall.** Aeroplane mode is not enough and a firewall rule is not
enough: the point is a machine with no network, not a machine that has been asked nicely.

**Check G — a second machine.** This is the scenario `05_TECH_SPEC.md` §7's
disaster-recovery table actually describes, and until it has been done once, the store's
backups are untested where it counts. Take the USB stick to another PC, install, restore,
and check a figure you know.

---

## Defects found

Anything touching `MON-*`, `INV-101`, `CR-103` or `POS-509` is **S1 by definition**,
regardless of how small it looks (`07_TEST_PLAN.md` §9). Sign-off requires zero open S1 and
S2 defects.

| # | What happened | Severity | Rule | Open / fixed |
| :-: | :--- | :--- | :--- | :--- |
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

---

## Sign-off

The checks above were performed on the store's own hardware on the date shown. Any check
not marked passed is recorded as not passed, and the reason is written in Notes.

> **Owner** — I have seen the system take a sale, print a receipt, close a drawer and back
> itself up on this machine. I have received the recovery code and the handover document.
>
> Name: ______________________  Signature: ______________________  Date: ____________

> **Performed by**
>
> Name: ______________________  Signature: ______________________  Date: ____________

> ### Outcome
>
> ☐ **Accepted** — go-live approved
> ☐ **Accepted with the defects listed above**, agreed as non-blocking
> ☐ **Not accepted** — reason: ______________________________________________

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
