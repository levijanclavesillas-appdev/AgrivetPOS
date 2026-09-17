package store.chachisoftware.pos;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.FileObserver;
import android.provider.MediaStore;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * OPS-001 on Android 11 and later, without "all files access".
 *
 * The server writes and verifies its backups in the app's own folder on shared storage, which
 * it can always write. This copies each finished backup into Documents/ChachiPOS Backups
 * through MediaStore — the one way an app may put a file there now — so the backups survive
 * the app being removed. A backup the server deletes (a failed check, or the retention count)
 * is deleted from Documents too. Only this installation's copies are touched.
 */
final class BackupMirror {
    private static final String TAG = "ChachiPOS";
    static final String RELATIVE = "Documents/ChachiPOS Backups/";
    private static final String FALLBACK_RELATIVE = "Download/ChachiPOS Backups/";

    private static FileObserver observer;

    private BackupMirror() {}

    static synchronized void start(Context context, File folder) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || observer != null) return;
        final Context app = context.getApplicationContext();
        //noinspection ResultOfMethodCallIgnored
        folder.mkdirs();
        observer = new FileObserver(folder, FileObserver.CLOSE_WRITE | FileObserver.DELETE | FileObserver.MOVED_TO) {
            @Override
            public void onEvent(int event, String name) {
                if (name == null || !name.endsWith(".zip")) return;
                File file = new File(folder, name);
                if ((event & (FileObserver.CLOSE_WRITE | FileObserver.MOVED_TO)) != 0) copy(app, file);
                else if ((event & FileObserver.DELETE) != 0) remove(app, name);
            }
        };
        observer.startWatching();
        // Backups made before this ran, or while the app was closed.
        new Thread(() -> {
            File[] existing = folder.listFiles((dir, n) -> n.endsWith(".zip"));
            if (existing != null) for (File file : existing) copy(app, file);
        }, "backup-mirror").start();
    }

    private static Uri collection() {
        return MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
    }

    private static Uri find(ContentResolver resolver, String name) {
        String[] columns = {MediaStore.MediaColumns._ID};
        String where = MediaStore.MediaColumns.DISPLAY_NAME + "=? AND (" + MediaStore.MediaColumns.RELATIVE_PATH + "=? OR "
                + MediaStore.MediaColumns.RELATIVE_PATH + "=?)";
        try (Cursor c = resolver.query(collection(), columns, where, new String[] {name, RELATIVE, FALLBACK_RELATIVE}, null)) {
            if (c != null && c.moveToFirst()) {
                return Uri.withAppendedPath(collection(), String.valueOf(c.getLong(0)));
            }
        } catch (Exception e) {
            Log.w(TAG, "backup mirror: lookup failed: " + e.getMessage());
        }
        return null;
    }

    static synchronized void copy(Context context, File file) {
        if (!file.isFile() || file.length() == 0) return;
        ContentResolver resolver = context.getContentResolver();
        if (find(resolver, file.getName()) != null) return;
        for (String relative : new String[] {RELATIVE, FALLBACK_RELATIVE}) {
            Uri target = null;
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, file.getName());
                values.put(MediaStore.MediaColumns.MIME_TYPE, "application/zip");
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, relative);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                target = resolver.insert(collection(), values);
                if (target == null) throw new IllegalStateException("MediaStore refused " + relative);
                try (InputStream in = new FileInputStream(file); OutputStream out = resolver.openOutputStream(target)) {
                    if (out == null) throw new IllegalStateException("no stream for " + target);
                    byte[] buffer = new byte[64 * 1024];
                    for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(target, done, null, null);
                Log.i(TAG, "backup mirror: " + file.getName() + " -> " + relative);
                return;
            } catch (Exception e) {
                Log.w(TAG, "backup mirror: " + relative + " refused " + file.getName() + ": " + e.getMessage());
                if (target != null) {
                    try { resolver.delete(target, null, null); } catch (Exception ignored) { /* nothing to undo */ }
                }
            }
        }
    }

    static synchronized void remove(Context context, String name) {
        ContentResolver resolver = context.getContentResolver();
        Uri existing = find(resolver, name);
        if (existing == null) return;
        try {
            resolver.delete(existing, null, null);
        } catch (Exception e) {
            Log.w(TAG, "backup mirror: could not remove " + name + ": " + e.getMessage());
        }
    }
}
