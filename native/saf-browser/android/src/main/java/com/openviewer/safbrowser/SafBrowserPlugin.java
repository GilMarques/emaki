package com.openviewer.safbrowser;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

/**
 * Minimal Storage Access Framework (SAF) browser.
 *
 * Covers exactly what the library explorer needs and nothing more:
 *  - {@code pickDirectory} launches Android's folder picker and keeps a
 *    persistable grant so the folder stays readable across app restarts.
 *  - {@code listDirectory} enumerates a tree/document URI's children through
 *    DocumentsContract.
 *
 * Reading file bytes is deliberately NOT implemented here: the app already
 * ships {@code @capacitor/filesystem}, which reads {@code content://} URIs
 * directly (no {@code directory} argument). Keeping this plugin small reduces
 * native surface and avoids duplicating base64 marshalling.
 */
@CapacitorPlugin(name = "SafBrowser")
public class SafBrowserPlugin extends Plugin {

    private static final String TAG = "SafBrowser";
    private static final int READ_WRITE =
            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
    private static final int READ_ONLY = Intent.FLAG_GRANT_READ_URI_PERMISSION;

    @PluginMethod
    public void pickDirectory(PluginCall call) {
        Log.i(TAG, "pickDirectory() launching ACTION_OPEN_DOCUMENT_TREE");
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        startActivityForResult(call, intent, "pickDirectoryResult");
    }

    @ActivityCallback
    private void pickDirectoryResult(PluginCall call, ActivityResult result) {
        Log.i(TAG, "pickDirectoryResult() code=" + result.getResultCode());
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            Log.i(TAG, "pickDirectoryResult() -> RESULT_CANCELED / no data");
            JSObject ret = new JSObject();
            ret.put("uri", JSObject.NULL);
            ret.put("name", JSObject.NULL);
            call.resolve(ret);
            return;
        }
        Uri treeUri = result.getData().getData();
        Log.i(TAG, "pickDirectoryResult() treeUri=" + treeUri);
        try {
            persistGrant(treeUri);
            call.resolve(toResult(treeUri));
            Log.i(TAG, "pickDirectoryResult() resolved");
        } catch (Exception e) {
            Log.e(TAG, "pickDirectoryResult() threw before resolve", e);
            call.reject("pick_failed", e.getMessage(), e);
        }
    }

    @PluginMethod
    public void listDirectory(PluginCall call) {
        String uriStr = call.getString("uri", "");
        Log.i(TAG, "listDirectory() uri=" + uriStr);
        if (uriStr.isEmpty()) {
            call.reject("invalid_args", "uri is required");
            return;
        }
        Uri uri = Uri.parse(uriStr);
        String documentId;
        try {
            documentId = documentIdFor(uri);
        } catch (Exception e) {
            Log.e(TAG, "listDirectory() documentIdFor failed", e);
            call.reject("invalid_uri", "not a DocumentsContract URI: " + uriStr);
            return;
        }
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(uri, documentId);
        Log.i(TAG, "listDirectory() childrenUri=" + childrenUri);
        ContentResolver resolver = getContext().getContentResolver();
        JSONArray entries = new JSONArray();
        try (Cursor cursor = resolver.query(
                childrenUri,
                new String[] {
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                },
                null,
                null,
                null)) {
            if (cursor != null) {
                while (cursor.moveToNext()) {
                    String childId = cursor.getString(0);
                    String name = cursor.getString(1);
                    String mime = cursor.getString(2);
                    boolean isDirectory = DocumentsContract.Document.MIME_TYPE_DIR.equals(mime);
                    Uri docUri = DocumentsContract.buildDocumentUriUsingTree(uri, childId);
                    JSObject entry = new JSObject();
                    entry.put("name", name != null && !name.isEmpty() ? name : childId);
                    entry.put("uri", docUri.toString());
                    entry.put("mime", mime != null ? mime : "");
                    entry.put("isDirectory", isDirectory);
                    entries.put(entry);
                }
            }
            Log.i(TAG, "listDirectory() entries=" + entries.length());
        } catch (SecurityException e) {
            Log.e(TAG, "listDirectory() permission_denied: " + e.getMessage());
            call.reject("permission_denied", e.getMessage());
            return;
        } catch (Exception e) {
            Log.e(TAG, "listDirectory() list_failed: " + e.getMessage(), e);
            call.reject("list_failed", e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("entries", entries);
        call.resolve(ret);
    }

    @PluginMethod
    public void stat(PluginCall call) {
        String uriStr = call.getString("uri", "");
        if (uriStr.isEmpty()) {
            call.reject("invalid_args", "uri is required");
            return;
        }
        Uri uri = Uri.parse(uriStr);
        long size = -1;
        try (Cursor cursor = getContext().getContentResolver().query(
                uri,
                new String[] { OpenableColumns.SIZE },
                null,
                null,
                null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (idx >= 0 && !cursor.isNull(idx)) {
                    size = cursor.getLong(idx);
                }
            }
        } catch (SecurityException e) {
            Log.e(TAG, "stat() permission_denied: " + e.getMessage());
            call.reject("permission_denied", e.getMessage());
            return;
        } catch (Exception e) {
            Log.e(TAG, "stat() stat_failed: " + e.getMessage());
            call.reject("stat_failed", e.getMessage());
            return;
        }
        if (size < 0) {
            call.reject("size_unknown", "provider did not report a size");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("size", size);
        call.resolve(ret);
    }

    /**
     * Extract the document id from a tree URI, a tree-relative document URI, or
     * a standalone document URI. {@code DocumentsContract.getDocumentId()} only
     * accepts standalone {@code .../document/<id>} URIs and throws for tree
     * URIs ({@code .../tree/<id>}), which is what the folder picker returns.
     */
    private static String documentIdFor(Uri uri) {
        final java.util.List<String> paths = uri.getPathSegments();
        if (paths.size() >= 2) {
            if ("tree".equals(paths.get(0))) {
                if (paths.size() >= 4 && "document".equals(paths.get(2))) {
                    return paths.get(3);
                }
                return paths.get(1);
            }
            if ("document".equals(paths.get(0))) {
                return paths.get(1);
            }
        }
        throw new IllegalArgumentException("Invalid URI: " + uri);
    }

    /** Ask the provider to keep the grant after the picker session ends. */
    private void persistGrant(Uri treeUri) {
        try {
            getContext().getContentResolver().takePersistableUriPermission(treeUri, READ_WRITE);
        } catch (SecurityException readWriteDenied) {
            // Some providers only grant read; a read-only grant is enough to browse.
            try {
                getContext().getContentResolver().takePersistableUriPermission(treeUri, READ_ONLY);
            } catch (SecurityException ignored) {
                // Session-only grant — the folder still works until the app restarts.
            }
        }
    }

    private JSObject toResult(Uri treeUri) {
        JSObject ret = new JSObject();
        ret.put("uri", treeUri.toString());
        ret.put("name", resolveDisplayName(treeUri));
        return ret;
    }

    /** Best-effort human-readable folder name (e.g. "Comics", not "primary%3AComics"). */
    private String resolveDisplayName(Uri treeUri) {
        try {
            String treeDocId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri rootDoc = DocumentsContract.buildDocumentUriUsingTree(treeUri, treeDocId);
            ContentResolver resolver = getContext().getContentResolver();
            try (Cursor cursor = resolver.query(
                    rootDoc,
                    new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME },
                    null,
                    null,
                    null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    String name = cursor.getString(0);
                    if (name != null && !name.isEmpty()) return name;
                }
            }
            return treeDocId;
        } catch (Exception e) {
            return DocumentsContract.getTreeDocumentId(treeUri);
        }
    }
}