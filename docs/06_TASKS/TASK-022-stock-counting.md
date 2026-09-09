# TASK-022 — Stock counting

**Priority:** **P2** for v1.1 — the store can count on paper for a while ·
**Blocks release:** yes (v1.1) · **Requirement:** feature `FT-209`,
rules `INV-110`–`INV-113`, `INV-101`, `INV-103`, `AUD-601`

---

## Objective

Count the shelves against the system, and post the difference as one movement per product that
actually differs.

## Context

v1.0 corrects stock one product at a time through `SCR-203`, which is right for a miscount and
wrong for a stocktake: counting four hundred products means four hundred adjustments, each
against a figure that has moved since the last one was posted.

**`INV-110` is the rule that makes a count a count: the session freezes the expected quantities
at start.** Without the freeze, a store that counts for three hours while trading measures its
variance against a moving figure and finds discrepancies it created by counting slowly. With it,
the variance is against what the system believed when the counting began, which is the only
figure the count can honestly be compared to.

**`INV-112` is the control:** a count must be approved by somebody other than the counter,
where the store has more than one active user. A stocktake is where shrinkage is written off,
and one person counting and approving their own count is the shape of the problem.

## Requirements

1. A session: opened by a user, covering all products or a category, with the expected quantity
   of every product in scope **snapshotted at open** (`INV-110`).
2. Counted quantities entered per product, in the base unit (`UOM-005`), saveable in progress —
   a stocktake spans a lunch break.
3. Variance computed against the snapshot, never against live on-hand.
4. `INV-111`: posting writes **one `COUNT_VARIANCE` movement per varying product, and none
   for products that matched.** A movement of zero is noise in the ledger every product will
   carry for ever.
5. `INV-112`: approval by a different active user before posting. Where the store has exactly
   one active user, the requirement cannot be met and is waived — with that stated on screen,
   not silently skipped.
6. `INV-113`: a session older than `stock_count_stale_days` (default 7, already in the
   registry) is flagged stale and needs owner authorisation to post — a fortnight-old count is a
   measurement of a fortnight ago.
7. Posting is one transaction, and the session becomes immutable.
8. The variance report: by product, by value at average cost, and a total — the figure the owner
   is actually asking for.
9. Audited with the session, the approver and the totals (`AUD-601`).

## Business Rules

- `INV-110` — the freeze, and why the variance is measured against it.
- `INV-111` — one movement per varying product, none for the rest.
- `INV-112` — approved by somebody other than the counter.
- `INV-113` — stale sessions, and who may post one.
- `INV-101`, `INV-102` — on hand stays derived; the count posts append-only movements.

## Technical Requirements

| Area | Detail |
| :--- | :--- |
| Files | `src/services/stockCountService.js`, its repository and routes, `public/js/inventory/count.js` |
| Schema | `stock_count_sessions`, `stock_count_lines` (carrying `expected_milli` frozen at open) |
| API | `POST /stock-counts`, `PUT /stock-counts/:id/lines`, `POST /stock-counts/:id/approve|post` |
| Constraints | The freeze is a stored column, not a re-read · posting is one transaction · `COUNT_VARIANCE` is already a declared movement type |

## Acceptance Criteria

- [x] A session opened at 09:00 measures variance against 09:00, whatever trades at 11:00
- [x] Posting writes a movement only for products that differ
- [x] The same user cannot approve their own count where another active user exists
- [x] A single-user store can post, and is told the second pair of eyes was not available
- [x] A stale session cannot be posted without owner authorisation
- [x] The ledger reconciles after posting, and the variance report values it at average cost

## What it decided

**The variance posted is `counted − expected`, and the consequence needs saying on the screen.**
Both wrong subtractions are one character away. A shelf holds 10 at the freeze, the counter finds
9 at 09:30, the shop sells 2 at 11:00. `counted − expected` is −1, and posting it leaves 8 − 1 =
7 — right, because nine really were there and two have since been sold. `counted − live` is +1:
it would *add* a sack, erase one of the two sales and report a surplus where there was a
shortage. **So after posting, on hand is not the counted figure**, and a store that does not know
that will report the ledger as broken. `SCR-205` prints the sentence on the sheet and again after
posting, and `TC-INT-88` asserts both the reported variance and the resulting on-hand — because
each wrong implementation gets exactly one of those two right.

**A blank is not a zero, and this is not in the rule document.** `counted_milli` is nullable with
no default. An uncounted line writes nothing; a line counted as `0` writes the whole quantity off.
A schema that defaulted the column to zero would write off the entire unreached remainder of a
shop as shrinkage the moment somebody posted a half-finished session, which is the most expensive
mistake this feature could make and is one keystroke away. `INV-111` is therefore read as "one
movement per **counted** product that varies", the posting reports how many were never reached,
the sheet hatches those rows and their field reads *not counted*, and clearing a line back to
blank is supported — without it there would be no way back from a mis-key and "blank means zero"
would become the only available reading.

**The freeze is one transaction, not a loop.** `snapshotLines` reads the products and writes
every line under one `BEGIN`. Inserting them one at a time would leave a window in which a sale
could commit between the first product and the last, and the session would then hold two
different ideas of "now" — the corruption `INV-110` exists to prevent, reintroduced by the code
meant to implement it.

**`INV-112` is enforced twice, on purpose.** §10 already keeps `TX-408` away from the inventory
clerk, so the approval route refuses them at the door; the service then refuses on **identity**,
because a manager who counted the shelves themselves is still the counter. The permission is the
coarse control and the identity check is the real one.

**Inactive products are counted.** `INV-105` keeps their stock reportable, and a shelf does not
stop holding twelve sacks because somebody deactivated the product. Skipping them would leave
that stock permanently unverifiable.

**Two deviations from this file's own technical requirements, both deliberate.** The screen is
`public/js/catalogue/count.js`, not `public/js/inventory/count.js` — there is no `inventory/`
directory and the catalogue screens (`SCR-201`–`SCR-204`) live where this one belongs. And the
child table is `stock_count_lines` rather than `_items`, against §3.3's convention for a
document's children: every product in scope gets a row whether or not anybody counts it, which is
a worksheet rather than a set of lines somebody entered — and `INV-111`'s whole point is that
most of them do nothing.

**What it did not do.** Nothing prevents two open sessions covering the same product. The
repository has `openSessionsForProduct` ready for the check, but refusing it would stop a store
recounting one aisle while another session sits abandoned, and `INV-110` says nothing about it —
each session measures against its own freeze and posts its own variance, so two of them are
arithmetically sound even if organisationally odd. Worth a rule before it is worth code.

## Tests

| Case | Asserts |
| :--- | :--- |
| `TC-INT-88` | `INV-110`: trading during a session does not change its variance |
| `TC-INT-89` | `INV-111`: no movement for a product that matched |
| `TC-INT-90` | `INV-112`: self-approval refused; waived and stated for a single-user store |
| `TC-INT-91` | `INV-113`: a stale session needs an owner |
| `TC-E2E-19` | Count 200 products while the shop trades, approve, post, and reconcile |

---

> Chachi's Software Development Service — DTI BN `8089738` · BIR OCN `111RC20260000002455`
