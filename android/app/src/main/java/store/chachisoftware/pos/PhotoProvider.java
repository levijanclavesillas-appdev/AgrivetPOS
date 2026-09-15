package store.chachisoftware.pos;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Somewhere for the camera to put a product's photo — TASK-052.
 *
 * The camera is another app, and it can only write where it is handed a content URI it
 * has been granted. This serves exactly one kind of file — the app's own
 * {@code cache/photos/photo-<digits>.jpg} — and nothing else: no directories, no other
 * names, not exported, and reachable only through the one-time grant on the camera
 * intent. It is the one thing AndroidX's FileProvider would have been used for, without
 * adding a dependency for it.
 */
public final class PhotoProvider extends ContentProvider {

    private static final String NAME = "photo-\\d{1,19}\\.jpg";

    static File folder(Context context) {
        File dir = new File(context.getCacheDir(), "photos");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    /** A fresh file for the next photo. The previous ones are removed: one photo at a time. */
    static File newPhoto(Context context) {
        File dir = folder(context);
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) //noinspection ResultOfMethodCallIgnored
            f.delete();
        return new File(dir, "photo-" + System.currentTimeMillis() + ".jpg");
    }

    static Uri uriFor(Context context, File photo) {
        return new Uri.Builder().scheme("content").authority(context.getPackageName() + ".photos")
                .appendPath(photo.getName()).build();
    }

    private File fileFor(Uri uri) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (uri.getPathSegments().size() != 1 || name == null || !name.matches(NAME)) {
            throw new FileNotFoundException("Not a photo this app took");
        }
        return new File(folder(getContext()), name);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        return "image/jpeg";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sortOrder) {
        File file;
        try {
            file = fileFor(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        MatrixCursor cursor = new MatrixCursor(new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        cursor.addRow(new Object[] {file.getName(), file.length()});
        return cursor;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.parseMode(mode));
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        return 0;
    }
}
