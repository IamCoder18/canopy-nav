package com.canopy.nav;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.RandomAccessFile;

/** App-private, bounded random reads for PMTiles. Filesystem's readFile would
 * transfer the entire archive through the JS bridge for every viewport. */
@CapacitorPlugin(name = "PackFiles")
public class PackFilesPlugin extends Plugin {
    @PluginMethod
    public void readRange(PluginCall call) {
        String path = call.getString("path", "");
        Double offset = call.getDouble("offset", -1.0);
        Integer length = call.getInt("length", -1);
        if (!path.matches("canopy-bundles/[a-zA-Z0-9_-]+/[a-zA-Z0-9][a-zA-Z0-9_.-]*")
                || offset < 0 || offset != Math.floor(offset) || length < 0 || length > 32 * 1024 * 1024) {
            call.reject("Invalid artifact range"); return;
        }
        try {
            File file = new File(getContext().getFilesDir(), path);
            try (RandomAccessFile reader = new RandomAccessFile(file, "r")) {
                reader.seek(offset.longValue());
                int size = (int) Math.max(0, Math.min(length, reader.length() - offset.longValue()));
                byte[] bytes = new byte[size]; reader.readFully(bytes);
                JSObject result = new JSObject(); result.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)); call.resolve(result);
            }
        } catch (Exception error) { call.reject("Could not read map artifact", error); }
    }
}
