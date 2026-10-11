// Derived from Maestro by mobile.dev (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// maestro-android/src/main/java/dev/mobile/maestro/receivers/UnicodeInputReceiver.kt, licensed under the Apache License, Version 2.0
// (see native/LICENSE-APACHE).
// Modified for react-native-eye: ported to Java, base64url extra, RESULT_OK on success, process :ime.
package dev.rneye.server.receivers;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Base64;
import android.view.inputmethod.InputConnection;
import dev.rneye.server.input.RneInputMethodService;
import java.nio.charset.StandardCharsets;

/**
 * Ordered-broadcast endpoint for the host (`am broadcast -f 0x20 -a …`). Success is
 * Activity.RESULT_OK (-1), NOT 0: an ordered broadcast nobody receives also finishes
 * with result 0, which Maestro's protocol cannot tell apart from success.
 */
public final class UnicodeInputReceiver extends BroadcastReceiver {
    public static final String ACTION_COMMIT = "dev.rneye.server.ime.commitText";
    public static final String ACTION_STATUS = "dev.rneye.server.ime.status";
    public static final String EXTRA_TEXT = "textBase64";
    private static final int ERROR = 1;

    @Override public void onReceive(Context context, Intent intent) {
        RneInputMethodService ime = RneInputMethodService.current();
        InputConnection ic = ime == null ? null : ime.connection();
        if (ime == null) { answer(ERROR, "ime not active"); return; }
        if (ic == null) { answer(ERROR, "no input connection"); return; }
        if (ACTION_STATUS.equals(intent.getAction())) { answer(Activity.RESULT_OK, "ready"); return; }
        if (!ACTION_COMMIT.equals(intent.getAction())) { answer(ERROR, "unknown action"); return; }
        String b64 = intent.getStringExtra(EXTRA_TEXT);
        if (b64 == null) { answer(ERROR, "missing " + EXTRA_TEXT); return; }
        String text;
        try {
            text = new String(Base64.decode(b64, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) { answer(ERROR, "bad base64"); return; }
        boolean ok = ic.commitText(text, 1);
        answer(ok ? Activity.RESULT_OK : ERROR, ok ? "committed " + text.length() : "commitText returned false");
    }

    private void answer(int code, String data) { if (isOrderedBroadcast()) { setResultCode(code); setResultData(data); } }
}
