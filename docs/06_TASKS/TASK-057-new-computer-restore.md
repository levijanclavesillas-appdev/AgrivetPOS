# TASK-057 — A store moves to a new computer with its backup

**Priority:** **P1** · **Rules:** `OPS-001`, `OPS-002`, `OPS-004`, `AUD-601`, `FR_1.1` · **Tests:** `restore-elsewhere.test.js`

## What was wrong

| # | Fault |
| :-: | :--- |
| 1 | **A backup copied onto a new computer could not be restored.** `HANDOVER.md` §4 says to install, copy the backup over and restore it. The Backups tab restores only rows in its own log, and the new computer's log has never heard of the file. The file was counted as an "unrecognised file" with no Restore button |
| 2 | **Restoring on the new computer meant setting up a throwaway store first.** The Backups tab is behind the wizard, so the owner had to make a store, an owner and a recovery code only to replace them |
| 3 | **Restoring another store's backup would have crashed after the swap.** The audit row and the `RESTORE` event name the restorer by id, and on a backup that does not contain that user the foreign key fails. That happens after the database has already been replaced, so the store would be restored but the request would answer 500 |
| 4 | **A backup a newer build wrote would have been restored, then not opened.** The migration ran after the swap, outside the rollback, so a database with migrations this build does not ship would have been left in place for the next launch to refuse |
| 5 | **After a restore, backups went to the old computer's folder.** The restored settings name the folder the backup's own computer used. On a new computer that path does not exist, so every backup would fail |
| 6 | **The guide sent a new computer through Export / import.** That path gives new usernames and no passwords, and the guide named backup files `pharmacy_backup_…zip`, which is not their name |

## As built

- **In the wizard.** Step 1 starts with *Moving from another computer? Restore a backup*. The
  owner chooses the backup file and this computer's backup folder, and
  `POST /setup/restore` restores it. The body is the file's own bytes, streamed to a temporary
  file (`middleware/upload.js`, 512 MB cap), because a backup carries every product picture
  and is too big for JSON. It is reachable only while `POST /setup` is. The file is checked the
  way a restore checks one, and the folder the way the wizard checks one. There is nothing on
  a fresh install to lose, so no pre-restore backup is taken and no filename is typed. The
  first backup on the new computer is taken straight after, and the owner signs in with their
  old username and password.
- **On the Backups tab.** Files in the folder with no row in the log are listed under
  *Other backups in the folder*, each with **Restore…**. **Restore from a file…** uploads a
  backup from anywhere on the device (`POST /backups/files`). It is checked and saved into the
  folder; a different file with the same name is saved beside it, not over it. The preflight
  (`?fileName=`) opens the file and shows the store it holds, when it last recorded anything,
  and its owner's username, before the name is typed. `POST /backups/files/restore` then runs
  the same `OPS-004` restore: owner only, no open shift, typed filename, pre-restore backup.
- **For every restore:**
  - The file is verified at the moment of restoring, not trusted from its log row.
  - It is refused if a newer build wrote it (`migrate.status().unknown`) or it holds no store
    with an owner.
  - The migration runs inside the swap's rollback.
  - The folder in use before the restore is kept, and the change is audited.
  - The restorer is recorded by username alone when the restored database does not have them.
- Names from a request are bare file names in the folder, with the product's prefix. A
  directory in either spelling is refused as not found.

## Tests

`restore-elsewhere.test.js` makes two other installations. Each is set up, trades, closes a
shift and is archived. A third, never set up, runs the real server. The tests show:

- **The wizard's restore:**
  - It refuses a non-backup, JSON, a backup from a newer build, and a folder inside the
    application data, and after each refusal the install is still fresh.
  - It restores the old computer's backup: store, sales, owner, and a verified first backup
    in the new folder. The old users sign in.
  - It is audited as `setup`, and refused once the store exists.
- **The Backups tab's upload** is owner only, refuses a non-backup, and leaves nothing in the
  folder.
- **The preflight** describes the file and refuses a newer build's. Five traversal and missing
  names answer 404.
- **Restoring another store's file:**
  - It is owner only, needs the typed name, and refuses a newer build's backup.
  - It restores and keeps this computer's folder.
  - It is audited under the restorer's username with no id. Its owner signs in and the
    restorer does not.
- **A broken file in the folder** is refused as `OPS-002`.

Walked in the renderer against the demo store's backup:

- **Wizard:** a fresh install, *Restore a backup*, the file and a folder chosen, "Your store is
  on this computer … 34 sales … the owner: chachi", then the sign-in screen for Botika ni
  Chachi. The same flow was checked at phone width.
- **Backups tab:** **Restore from a file…** opened the dialog with the store, last recorded
  time and owner. The open shift from the backup was refused until closed, then the restore
  completed with its pre-restore backup.
