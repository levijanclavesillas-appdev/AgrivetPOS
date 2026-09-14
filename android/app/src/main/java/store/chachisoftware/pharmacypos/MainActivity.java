package store.chachisoftware.pharmacypos;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * The whole store, in one screen — TASK-049.
 *
 * A WebView over the server NodeRuntime starts on 127.0.0.1, showing exactly the renderer
 * the Windows build shows. What Android needs that a desktop browser gave for free is
 * here: a file picker for the opening workbook and restores, a way to save a download,
 * and a backup folder outside the app's own storage (OPS-001).
 */
public class MainActivity extends Activity {

    private static final String TAG = "ChachiPOS";
    private static final String ORIGIN = "http://127.0.0.1:" + NodeRuntime.PORT;
    private static final int PICK_FILE = 1;
    private static final String BACKUP_FOLDER_NAME = "ChachiPharmacyPOS Backups";

    private WebView web;
    private ValueCallback<Uri[]> pendingPick;
    private boolean askedForStorage = false;
    private final Handler main = new Handler(Looper.getMainLooper());

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // A counter tablet that goes dark between customers is a counter tablet somebody
        // taps awake with a customer waiting.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        // chrome://inspect works on a debug build and never on the store's release build.
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // The renderer is same-origin by its own CSP. Anything else is not ours to open.
                return !request.getUrl().toString().startsWith(ORIGIN);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingPick != null) pendingPick.onReceiveValue(null);
                pendingPick = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("*/*");
                try {
                    startActivityForResult(pick, PICK_FILE);
                } catch (Exception e) {
                    pendingPick = null;
                    return false;
                }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "ChachiAndroid");
        web.loadData(LOADING, "text/html", "utf-8");
        setContentView(web);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!hasSharedStorage() && !askedForStorage) {
            // Asked once, before the server starts, because the server is told the backup
            // folder when it starts. Either answer comes back through onResume.
            askedForStorage = true;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) askForSharedStorage();
            else requestPermissions(new String[] {android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, 2);
            return;
        }
        startServer();
    }

    /**
     * OPS-001: backups go outside the application's own storage, so they survive the app
     * being cleared or uninstalled. On Android 11 and later that is "all files access",
     * which a sideloaded point of sale may ask for. Without it the backups go to the app's
     * own folder on shared storage, which is visible over USB but removed on uninstall —
     * the wizard still refuses a folder inside the data directory either way.
     */
    private void askForSharedStorage() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.storage_title)
                .setMessage(R.string.storage_message)
                .setPositiveButton(R.string.storage_allow, (d, w) -> {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                            Uri.parse("package:" + getPackageName()));
                    try {
                        startActivity(intent);
                    } catch (Exception e) {
                        startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                    }
                })
                .setNegativeButton(R.string.storage_later, (d, w) -> startServer())
                .setCancelable(false)
                .show();
    }

    private boolean hasSharedStorage() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return Environment.isExternalStorageManager();
        // Android 8–10: the ordinary storage permission, with legacy storage on 10.
        return checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    private String backupFolder() {
        File shared = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
                BACKUP_FOLDER_NAME);
        if (hasSharedStorage()) return shared.getAbsolutePath();
        File own = getExternalFilesDir(BACKUP_FOLDER_NAME);
        return own != null ? own.getAbsolutePath() : shared.getAbsolutePath();
    }

    private boolean serverRequested = false;

    private void startServer() {
        if (serverRequested) return;
        serverRequested = true;
        new Thread(() -> {
            try {
                NodeRuntime.start(getApplicationContext(), backupFolder());
            } catch (RuntimeException e) {
                Log.e(TAG, "The server could not start", e);
                main.post(() -> web.loadData(failed(e.getMessage()), "text/html", "utf-8"));
                return;
            }
            // Poll /health, so the window never loads against a port nobody answers on —
            // the same rule main.js follows on Windows (waitForHealth).
            for (int attempt = 0; attempt < 600; attempt += 1) {
                if (answers()) {
                    main.post(() -> web.loadUrl(ORIGIN + "/"));
                    return;
                }
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    return;
                }
            }
            main.post(() -> web.loadData(failed("It did not answer within a minute."), "text/html", "utf-8"));
        }, "wait-for-server").start();
    }

    private static boolean answers() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(ORIGIN + "/api/v1/health").openConnection();
            c.setConnectTimeout(500);
            c.setReadTimeout(500);
            int code = c.getResponseCode();
            c.disconnect();
            return code == 200;
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILE || pendingPick == null) return;
        pendingPick.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        pendingPick = null;
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        // Back does not close the till. The screens have their own way back.
        if (web != null && web.canGoBack()) web.goBack();
    }

    /** What the renderer may ask of Android — window.ChachiAndroid. Downloads, and nothing else. */
    private final class Bridge {
        /**
         * Save a file the renderer produced — an export, a template, a statement — to the
         * tablet's Downloads. A WebView has no download manager for a blob, which is what
         * every download here is (SEC-7: fetched with the token, never followed as a link).
         */
        @JavascriptInterface
        public void saveFile(String name, String mime, String base64) {
            String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    values.put(MediaStore.Downloads.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) throw new IllegalStateException("Downloads refused the file");
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (out == null) throw new IllegalStateException("Downloads refused the file");
                        out.write(bytes);
                    }
                } else {
                    File folder = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    //noinspection ResultOfMethodCallIgnored
                    folder.mkdirs();
                    try (OutputStream out = new FileOutputStream(new File(folder, safe))) {
                        out.write(bytes);
                    }
                }
                main.post(() -> Toast.makeText(MainActivity.this, getString(R.string.saved_to_downloads, safe), Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                Log.e(TAG, "Could not save " + safe, e);
                main.post(() -> Toast.makeText(MainActivity.this, getString(R.string.save_failed, e.getMessage()), Toast.LENGTH_LONG).show());
            }
        }
    }

    private static final String PAGE_STYLE = "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#f1f5f9;"
            + "font:16px system-ui,sans-serif;color:#0f172a}main{text-align:center;max-width:32rem;padding:2rem}"
            + "h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#475569;line-height:1.5}</style>";

    private static final String LOADING = PAGE_STYLE
            + "<main><h1>Chachi Pharmacy POS</h1><p>Starting the store…</p></main>";

    private static String failed(String why) {
        String safe = why == null ? "" : why.replace("&", "&amp;").replace("<", "&lt;");
        return PAGE_STYLE + "<main><h1>The store could not start</h1><p>" + safe + "</p>"
                + "<p>Close the app and open it again. If it happens again, connect the tablet to a "
                + "computer and send <code>adb logcat -s ChachiNode</code> to support.</p></main>";
    }
}
