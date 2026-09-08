# Handover — Chachi Agrivet POS v1.0

**For:** the store owner · **From:** Chachi's Software Development Service
**Installed on:** ______________________  **Handed over:** ______________________

This document is for the person who owns the store, not for a technician. It covers the
four things that decide whether a bad day costs an afternoon or a year of records. Keep it
with the recovery code.

---

## 1. The recovery code — the one thing that cannot be replaced

When the system was set up it showed a **recovery code**, once, and never again. It looks
like `NQ85-YP3L-U8H2-CFU6`.

It is the only way back into the system if the owner password is forgotten. It is not
stored anywhere in readable form — not in the database, not in a file, not with your
supplier. **If it is lost and the password is forgotten, the data cannot be reached.**

- Write it on paper. Keep it where you keep the cash box or the business permits.
- Do not keep it in the drawer beside the PC. The two are lost together.
- Do not photograph it onto a phone that other people use.
- If you have lost it, say so now, while the system can still be reset the easy way.

> Written down and stored at: ______________________________________________

## 2. Backups — what the system does, and what only you can do

**What the system does, automatically, with no reminder needed:**

- A backup runs **every time a shift is closed**, and once a day at the configured hour.
- Every backup is **opened and checked** immediately after it is written. A backup that
  fails the check is deleted and does not count — because a backup nobody has opened is a
  hope, and the day you need it is the worst day to find out.
- The last thirty are kept. Older ones are removed only after a newer one has been checked.
- Backups are written to your backup folder as `agrivet_backup_….zip`. You can open one by
  double-clicking it; the database is inside, called `agrivet.db`.

**What only you can do — and this is the important part:**

> ### Copy the backup folder to a USB stick once a week, and keep the stick somewhere else.

The system cannot do this and does not pretend to. Backups on the shop PC do not survive
the shop PC. They survive a mistake, a wrong price, an accidental deletion — they do not
survive a fire, a theft, a flood, a lightning strike or a hard drive failing, which are the
four things a backup is actually for.

Once a week is enough. A month-old copy off-site is worth more than a perfect copy that
burned with the counter.

**One more thing about the stick.** A backup file is readable by anyone who has it. It
contains every price you charge, every customer's balance and every peso the store has
taken. It is not encrypted and nothing in this system pretends otherwise. Keep the stick
where you would keep the cash box, not in the till.

> Backup folder: ______________________________________________
> USB stick kept at: __________________________________________
> Weekly copy done by: ________________________________________

## 3. Restoring — what to do when something has gone badly wrong

Restoring **replaces everything** in the system with the contents of a backup. Every sale,
payment, stock movement and customer change made after that backup was taken is gone from
the system afterwards.

Use it when the database is damaged or when something has gone wrong that cannot be
corrected — not to undo a mistake. A wrong price is corrected by changing the price. A
wrong sale is corrected by a void or a return. Restoring to fix one sale throws away every
sale after it.

**How it works:**

1. Close every shift first. The system refuses to restore while a drawer is open — a shift
   counted against a database that is about to be replaced reconciles to nothing.
2. Open **Admin → Backups**. The list shows when each backup was taken and whether it was
   verified. Only a verified one can be restored.
3. Press **Restore…** next to the one you want. Read the date on it.
4. The system takes a **fresh backup of the current database first**, so the restore itself
   can be undone. If that backup cannot be taken, the restore does not start.
5. **You must type the backup's filename in full.** Not a tick-box — a tick-box gets ticked
   without reading, and the date on the file is the thing that has to be read.

Only the owner can restore. Every restore is recorded in the audit trail with who did it,
when, and which file.

**After a restore**, the pre-restore backup is in the backup folder. Anything you needed
from the period you just undid is in it.

## 4. If the PC dies

1. Install Chachi Agrivet POS on the replacement machine.
2. Copy your most recent backup from the USB stick to the new machine.
3. Set the backup folder in **Settings**, open **Admin → Backups**, and restore from it.
4. Re-key any sales made after that backup, from the receipts.

The most you can lose is the trading since your last shift close, because a backup runs at
every close.

---

## Day-to-day things worth knowing

**The system does not need the internet.** Not for selling, not for printing, not for
backups, not for reports. If the connection is down the store trades normally. There is no
"offline mode" to switch on and no warning to ignore — offline is simply how it works.

**Receipts are not official receipts.** Every printed document says
*"This is not an official receipt"*, because that is what the law requires of a document
that is not BIR-registered. Your tax mode is set to **NONE** (not BIR-registered). If the
store registers later, the mode is changed in Settings — it is an owner-only change, it is
audited, and reports covering the change will say which mode each sale was made under.

**GCash and QR Ph payments are recorded, not verified.** The system writes down what the
cashier saw on the customer's phone. Nothing confirms the money arrived — every screen and
every receipt says `RECORDED` for that reason. Check your GCash account against the payments
report at the end of the day.

**The clock.** If the PC's clock is wrong the system says so and keeps selling — receipt
numbers do not come from the clock. Fix the clock when you can; dates on new records will be
wrong until you do.

**Updates.** New versions arrive as a file, by hand or on a USB stick. The system never
updates itself, because a PC that updates in the middle of a shift is a queue at the
counter with no till. An update keeps your data and takes a backup before it changes
anything.

**Uninstalling does not delete your data.** The database and the backup folder are left
alone. Reinstalling finds them again.

---

## Who to call

> Supplier: Chachi's Software Development Service
> DTI BN `8089738` · BIR OCN `111RC20260000002455`
> Contact: ______________________________________________

Before calling, open **Admin → Health** and note the **version** and the **last verified
backup**. Those two lines answer most of the first questions.

---

## Signed

I have received the recovery code and understand that it cannot be recovered if lost.
I understand that the weekly off-machine copy of the backup folder is mine to perform and
that the system does not do it.

> Owner: ______________________  Signature: ______________________  Date: ____________
