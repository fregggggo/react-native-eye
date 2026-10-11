// Derived from Maestro by mobile.dev (https://github.com/mobile-dev-inc/maestro, commit c436d39),
// maestro-android/src/main/java/dev/mobile/maestro/input/MaestroInputMethodService.kt, licensed under the Apache License, Version 2.0
// (see native/LICENSE-APACHE).
// Modified for react-native-eye: ported to Java, runs in process :ime.
package dev.rneye.server.input;

import android.inputmethodservice.InputMethodService;
import android.view.View;
import android.view.inputmethod.InputConnection;

/** Invisible IME: the host selects it, commits text through UnicodeInputReceiver, then restores the user's. */
public final class RneInputMethodService extends InputMethodService {
    private static RneInputMethodService instance;

    public static RneInputMethodService current() { return instance; }

    @Override public void onCreate() { super.onCreate(); instance = this; }
    @Override public void onDestroy() { if (instance == this) instance = null; super.onDestroy(); }
    @Override public View onCreateInputView() { return new View(this); }
    @Override public boolean onEvaluateFullscreenMode() { return false; }

    /** Null when no editable field is bound. */
    public InputConnection connection() { return getCurrentInputConnection(); }
}
