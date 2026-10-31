package ai.filedeck.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import android.util.Size;
import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;

@CapacitorPlugin(name = "FolderSync")
public class FolderSyncPlugin extends Plugin {

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void chooseFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION |
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        );
        startActivityForResult(call, intent, "onFolderSelected");
    }

    @ActivityCallback
    private void onFolderSelected(PluginCall call, ActivityResult result) {
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            Uri treeUri = result.getData().getData();
            if (treeUri != null) {
                try {
                    getContext().getContentResolver().takePersistableUriPermission(
                        treeUri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                    );
                } catch (Exception ignored) {}

                DocumentFile dir = DocumentFile.fromTreeUri(getContext(), treeUri);
                String name = (dir != null && dir.getName() != null) ? dir.getName() : "Local Folder";

                JSObject ret = new JSObject();
                ret.put("uri", treeUri.toString());
                ret.put("name", name);
                call.resolve(ret);
                return;
            }
        }
        call.reject("User cancelled folder selection");
    }

    @PluginMethod
    public void listFiles(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null || uriStr.isEmpty()) {
            call.reject("Missing uri");
            return;
        }

        try {
            Uri treeUri = Uri.parse(uriStr);
            DocumentFile dir = DocumentFile.fromTreeUri(getContext(), treeUri);
            if (dir == null || !dir.isDirectory()) {
                call.reject("Directory not found or inaccessible");
                return;
            }

            JSArray filesArray = new JSArray();
            DocumentFile[] files = dir.listFiles();
            if (files != null) {
                for (DocumentFile f : files) {
                    if (f.isFile() && f.exists() && f.length() > 0) {
                        JSObject item = new JSObject();
                        item.put("name", f.getName());
                        item.put("size", f.length());
                        item.put("lastModified", f.lastModified());
                        item.put("mimeType", f.getType() != null ? f.getType() : "application/octet-stream");
                        item.put("uri", f.getUri().toString());
                        filesArray.put(item);
                    }
                }
            }

            JSObject ret = new JSObject();
            ret.put("files", filesArray);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to list files: " + e.getMessage());
        }
    }

    @PluginMethod
    public void readFilePart(PluginCall call) {
        String uriStr = call.getString("uri");
        Long offset = call.getLong("offset", 0L);
        Integer length = call.getInt("length", 524288); // 512 KB

        if (uriStr == null || uriStr.isEmpty()) {
            call.reject("Missing uri");
            return;
        }

        ParcelFileDescriptor pfd = null;
        FileInputStream fis = null;
        try {
            Uri fileUri = Uri.parse(uriStr);
            pfd = getContext().getContentResolver().openFileDescriptor(fileUri, "r");
            if (pfd != null) {
                fis = new FileInputStream(pfd.getFileDescriptor());
                FileChannel channel = fis.getChannel();
                channel.position(offset);

                ByteBuffer buffer = ByteBuffer.allocate(length);
                int totalRead = 0;
                while (totalRead < length) {
                    int r = channel.read(buffer);
                    if (r <= 0) break;
                    totalRead += r;
                }

                byte[] bytes = new byte[totalRead];
                buffer.flip();
                buffer.get(bytes);

                String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                JSObject ret = new JSObject();
                ret.put("data", base64);
                ret.put("bytesRead", totalRead);
                call.resolve(ret);
                return;
            }
        } catch (Exception ignored) {
        } finally {
            if (fis != null) {
                try { fis.close(); } catch (Exception ignored) {}
            }
            if (pfd != null) {
                try { pfd.close(); } catch (Exception ignored) {}
            }
        }

        // Fallback: Read stream with byte-draining loop (never breaks early on skip == 0!)
        try {
            Uri fileUri = Uri.parse(uriStr);
            InputStream is = getContext().getContentResolver().openInputStream(fileUri);
            if (is == null) {
                call.reject("Could not open input stream");
                return;
            }

            long toSkip = offset;
            byte[] discard = new byte[16384];
            while (toSkip > 0) {
                long s = is.skip(toSkip);
                if (s > 0) {
                    toSkip -= s;
                } else {
                    int read = is.read(discard, 0, (int) Math.min(discard.length, toSkip));
                    if (read <= 0) break;
                    toSkip -= read;
                }
            }

            byte[] buffer = new byte[length];
            int totalRead = 0;
            while (totalRead < length) {
                int r = is.read(buffer, totalRead, length - totalRead);
                if (r <= 0) break;
                totalRead += r;
            }
            is.close();

            byte[] finalBytes = buffer;
            if (totalRead < length) {
                finalBytes = new byte[totalRead];
                System.arraycopy(buffer, 0, finalBytes, 0, totalRead);
            }

            String base64 = Base64.encodeToString(finalBytes, Base64.NO_WRAP);
            JSObject ret = new JSObject();
            ret.put("data", base64);
            ret.put("bytesRead", totalRead);
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("Error reading file part: " + ex.getMessage());
        }
    }

    @PluginMethod
    public void getThumbnail(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null || uriStr.isEmpty()) {
            call.reject("Missing uri");
            return;
        }

        try {
            Uri fileUri = Uri.parse(uriStr);
            Bitmap bitmap = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    bitmap = getContext().getContentResolver().loadThumbnail(fileUri, new Size(640, 640), null);
                } catch (Exception ignored) {}
            }
            if (bitmap == null) {
                InputStream is = getContext().getContentResolver().openInputStream(fileUri);
                if (is != null) {
                    BitmapFactory.Options opts = new BitmapFactory.Options();
                    opts.inSampleSize = 2;
                    bitmap = BitmapFactory.decodeStream(is, null, opts);
                    is.close();
                }
            }

            if (bitmap != null) {
                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                bitmap.compress(Bitmap.CompressFormat.JPEG, 85, baos);
                byte[] bytes = baos.toByteArray();
                String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                JSObject ret = new JSObject();
                ret.put("data", base64);
                call.resolve(ret);
                return;
            }
            call.reject("Could not create thumbnail");
        } catch (Exception e) {
            call.reject("Failed to generate thumbnail: " + e.getMessage());
        }
    }
}
