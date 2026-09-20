package store.chachisoftware.pos;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.TimeZone;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Node, inside the app — TASK-049.
 *
 * The server in src/ runs here unchanged: the same routes, rules and database code as the
 * Windows build, on the tablet's own storage. What this class adds is only what an
 * operating-system process would otherwise have given it: the files on disk, an
 * environment, and a thread.
 *
 * Node can start once per process and never stops (node::Start runs the event loop
 * until exit), so {@link #start} is idempotent and the server outlives the activity.
 */
final class NodeRuntime {

    static final int PORT = 47800;
    private static final String TAG = "ChachiNode";
    private static final String PROJECT = "nodejs-project";

    static {
        System.loadLibrary("node");
        System.loadLibrary("native-lib");
    }

    private static native int startNodeWithArguments(String[] arguments);

    private static boolean started = false;

    private NodeRuntime() { }

    /**
     * @param backupFolder where the server writes its backups
     * @param fixed        true where the app decides that folder (the owner cannot change it)
     * @param copiedTo     where each backup is copied for keeping (Documents/…), or null
     */
    static synchronized void start(Context context, String backupFolder, boolean fixed, String copiedTo) {
        if (started) return;
        started = true;

        File project = new File(context.getFilesDir(), PROJECT);
        try {
            installProject(context, project);
        } catch (IOException e) {
            Log.e(TAG, "Could not unpack the server", e);
            started = false;
            throw new IllegalStateException("Could not unpack the server: " + e.getMessage(), e);
        }

        File data = new File(context.getFilesDir(), "data");
        //noinspection ResultOfMethodCallIgnored
        data.mkdirs();
        try {
            // The server reads all of its configuration from the environment; these are
            // the variables src/config/paths.js, sqlite.js and setupService.js read.
            Os.setenv("AGRIVET_DATA_DIR", data.getAbsolutePath(), true);
            Os.setenv("AGRIVET_PORT", String.valueOf(PORT), true);
            Os.setenv("AGRIVET_SQLITE_ADDON",
                    context.getApplicationInfo().nativeLibraryDir + "/libbetter_sqlite3.so", true);
            Os.setenv("AGRIVET_BACKUP_SUGGESTION", backupFolder, true);
            // src/config/hosting.js: a folder the app fixes wins over any the store saved,
            // including a Documents path saved by a build that had "all files access".
            if (fixed) Os.setenv("AGRIVET_APP_BACKUP_DIR", backupFolder, true);
            if (copiedTo != null) Os.setenv("AGRIVET_APP_BACKUP_COPY", copiedTo.replaceAll("/+$", ""), true);
            // OPS-001: where a backup goes if the folder above ever refuses it.
            //
            // **Internal storage, and deliberately not getExternalFilesDir("ChachiPOS
            // Backups").** That was this line until now, and it is the very folder
            // `backupFolder()` hands over as the target whenever the app fixes the folder —
            // which is every Android 11+ device, and every Android 8–10 one where the storage
            // permission was refused. backupService.fallbackFolder() rejects a spare equal to
            // its target, quite rightly, so the fallback added for exactly this case was
            // switched off on the path that needed it most: a write that failed had nowhere
            // else to go, and the owner was told "the backup could not be written (EACCES)"
            // with no second folder named and no backup taken.
            //
            // getFilesDir() is the one place that cannot refuse: it needs no permission, it is
            // never unmounted, and it does not depend on the state of shared storage — which
            // is what the target depends on. It does not survive an uninstall, so it is a last
            // resort and the Backups screen says so loudly (backupService writes a
            // BACKUP_FAILED row naming both folders whenever it lands here).
            File spare = new File(context.getFilesDir(), "backup-fallback");
            Os.setenv("AGRIVET_BACKUP_FALLBACK_DIR", spare.getAbsolutePath(), true);
            Os.setenv("HOME", context.getFilesDir().getAbsolutePath(), true);
            Os.setenv("TMPDIR", context.getCacheDir().getAbsolutePath(), true);
            // Android has no /etc/localtime for Node to read. The ledger is UTC and the
            // screens say Asia/Manila explicitly (NFR_4.2); this is for anything else.
            Os.setenv("TZ", TimeZone.getDefault().getID(), true);
            Os.setenv("NODE_ENV", "production", true);
        } catch (ErrnoException e) {
            throw new IllegalStateException("Could not set the server's environment", e);
        }

        String main = new File(project, "main.js").getAbsolutePath();
        // V8 wants more stack than a default Java thread has.
        Thread node = new Thread(null, () -> {
            int code = startNodeWithArguments(new String[] {"node", main});
            Log.e(TAG, "Node exited with code " + code);
        }, "node", 16L * 1024 * 1024);
        node.start();
    }

    /**
     * Unpack the staged server from the APK, on first launch and after every update — and
     * only then, because it is a thousand files and the counter should not wait for them
     * on an ordinary morning.
     *
     * One zip rather than a tree of assets: Android's asset packager silently drops
     * dot-files and directories whose names start with an underscore, and node_modules
     * has both. A package missing a file it requires is a server that does not start.
     */
    private static void installProject(Context context, File project) throws IOException {
        String stamp = versionStamp(context);
        File marker = new File(project, ".installed");
        if (marker.exists() && stamp.equals(new String(Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8))) {
            return;
        }
        deleteRecursively(project);
        unzip(context, project);
        try (OutputStream out = new FileOutputStream(marker)) {
            out.write(stamp.getBytes(StandardCharsets.UTF_8));
        }
        Log.i(TAG, "Server installed for " + stamp);
    }

    private static String versionStamp(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info.versionName + "/" + info.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) {
            return "unknown/" + System.currentTimeMillis();
        }
    }

    private static void unzip(Context context, File project) throws IOException {
        String root = project.getCanonicalPath() + File.separator;
        try (ZipInputStream zip = new ZipInputStream(context.getAssets().open(PROJECT + ".zip"))) {
            byte[] buffer = new byte[1 << 16];
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                File out = new File(project, entry.getName());
                if (!out.getCanonicalPath().startsWith(root)) throw new IOException("Unsafe path " + entry.getName());
                if (entry.isDirectory()) {
                    //noinspection ResultOfMethodCallIgnored
                    out.mkdirs();
                    continue;
                }
                //noinspection ResultOfMethodCallIgnored
                out.getParentFile().mkdirs();
                try (OutputStream stream = new FileOutputStream(out)) {
                    int read;
                    while ((read = zip.read(buffer)) > 0) stream.write(buffer, 0, read);
                }
            }
        }
    }

    private static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
