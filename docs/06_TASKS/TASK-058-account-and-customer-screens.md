# TASK-058 — Sign out, your own password and PIN, the recovery code, and editing a customer

**Priority:** **P1** · **Rules:** `SEC-2`, `SEC-3`, `SEC-5`, `SEC-7`, `AUD-601`, `AUD-604` · **Tests:** `own-account.test.js`

## What was wrong

The server could do these things, but no screen offered them.

| # | Fault |
| :-: | :--- |
| 1 | **No way to sign out.** The name at the foot of the menu locked the screen (with a PIN) or showed the sign-in form, with the old token still held in memory |
| 2 | **Nobody could change their own password or PIN.** Only the owner could, from Admin → Users, and that screen told the owner "They can change it later" |
| 3 | **The recovery code had an endpoint and no screen.** `POST /auth/recover` existed, but the sign-in screen had no way to it, and the guide said to email support. The owner also could not replace a lost code while still signed in |
| 4 | **A customer could not be edited.** `PUT /customers/:id` existed, but the profile could only deactivate. A wrong phone number or a customer who became a reseller needed a second customer. The profile did not show the address or notes at all, and a deactivated customer could not be brought back |
| 5 | **A timed-out session always showed the PIN keypad**, even to someone with no PIN |

## As built

- **Server.** `POST /auth/password`, `POST /auth/pin` and `POST /auth/recovery-code` (owner
  only) each prove the person with their current password. The check is the sign-in
  screen's own, so wrong tries count towards the same lockout (`SEC-3`). A PIN session is
  refused (`SEC-2`), so a screen left unlocked with a PIN cannot be used to take over the
  account. A wrong current password answers 403 rather than 401, because the renderer
  treats a 401 as a session that has ended and locks the screen. Each change is audited
  before it takes effect (`PASSWORD_CHANGED`, `PIN_CHANGED`, `RECOVERY_CODE_REISSUED`), and
  the audit row never holds the secret.
- **The account panel** (`public/js/shell/account.js`) opens from the name at the foot of
  the menu. It offers:
  - Lock screen (with a PIN);
  - Change password;
  - Change PIN, Set a PIN, and Remove my PIN;
  - New recovery code (owner). The code is shown once and the panel will not close until
    "I have written it down" is ticked;
  - Sign out. This drops the in-memory token (`SEC-7`) and says the cart stays on its shift.

  After a PIN unlock, the panel offers only Lock and Sign out. Its forms stay open with the
  reason under them, and they never trim a password.
- **The sign-in screen** has "Forgot the owner password?". The owner enters the username,
  the recovery code and a new password, and `POST /auth/recover` replaces the password. The
  next code is shown once, behind the same tick.
- **The customer profile** has Edit details. It covers name, code, contact number, address,
  type, price level and notes, and turning credit on (with limit and terms, `VR-303`) or
  off (the server refuses while anything is owed). The limit itself stays with Change credit
  limit (`TX-414`). The profile now shows the address and notes, and has Reactivate.
- **A timed-out session without a PIN** goes to the sign-in screen with the username filled
  in.

## Tests

`own-account.test.js` runs the real server and shows:

- **Password.**
  - A wrong current password is 403 and says so.
  - A short new password and an unchanged one are refused.
  - After a change, the old password no longer signs in and the new one does.
  - The audit row carries no hash.
- **PIN.**
  - A sequential PIN is refused.
  - A new PIN unlocks the open shift and the old one does not.
  - Removing the PIN works.
  - All three changes are refused to a PIN session with `SEC-2`.
- **Recovery code.**
  - A cashier cannot make one.
  - A replaced code is worthless.
  - The new one recovers, case-insensitively, and issues the next.
- **Lockout.** Six wrong current passwords lock the account (423), at the sign-in screen
  too.

Renderer checks cover the rail button, sign-out, the endpoints each screen calls, and that
passwords are not trimmed.

Walked in the renderer against the demo store:

- **Cashier.** A wrong current password showed the reason and the screen stayed unlocked.
  The password and PIN changed, and Sign out left a sign-in screen whose session answers 401.
- **PIN session.** The panel offered only Lock and Sign out.
- **Owner.** A new recovery code was made; Escape was ignored until the tick. That code then
  reset the password on the sign-in screen (desktop and phone), and the owner signed in.
- **Customer.** A cashier edited a customer's contact number, address and notes, and the
  profile showed them after saving.
