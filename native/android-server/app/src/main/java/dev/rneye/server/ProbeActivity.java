package dev.rneye.server;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Bundle;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import dev.rneye.server.receivers.UnicodeInputReceiver;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * A known screen for tests: an input (id probe_input) and a button that counts taps and
 * long presses. A long press also shows the toast "rne probe toast".
 *
 * Security checks for scripts/smoke-android-server.sh, run from this app's uid, which is
 * what any other app on the device gets (the result lands in the text of id probe_check):
 * - extra `rne_connect <socket>`: connect to the server's abstract socket and ask /status.
 *   The server must refuse (only adbd's uid may connect).
 * - extra `rne_broadcast true`: send the IME status broadcast. It must not be delivered
 *   (the receiver requires android.permission.DUMP): result 0, not the receiver's 1.
 */
public final class ProbeActivity extends Activity {
    private int taps;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 200, 48, 48);
        EditText input = new EditText(this);
        input.setId(R.id.probe_input);
        input.setHint("rne probe input");
        input.setSingleLine(true);
        Button button = new Button(this);
        button.setId(R.id.probe_button);
        button.setText("tap me");
        button.setOnClickListener(v -> button.setText("tapped " + (++taps)));
        button.setOnLongClickListener(v -> {
            button.setText("long-pressed");
            Toast.makeText(this, "rne probe toast", Toast.LENGTH_LONG).show();
            return true;
        });
        TextView check = new TextView(this);
        check.setId(R.id.probe_check);
        root.addView(input, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 160));
        root.addView(button, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 200));
        root.addView(check, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 160));
        setContentView(root);
        input.requestFocus();

        String socket = getIntent().getStringExtra("rne_connect");
        if (socket != null) {
            new Thread(() -> {
                String r = connect(socket);
                runOnUiThread(() -> check.setText(r));
            }).start();
        }
        if (getIntent().getBooleanExtra("rne_broadcast", false)) {
            Intent i = new Intent(UnicodeInputReceiver.ACTION_STATUS).setClassName(getPackageName(), UnicodeInputReceiver.class.getName());
            sendOrderedBroadcast(i, null, new BroadcastReceiver() {
                @Override public void onReceive(Context c, Intent intent) { check.setText("broadcast: result=" + getResultCode()); }
            }, null, 0, null, null);
        }
    }

    private static String connect(String name) {
        try (LocalSocket s = new LocalSocket()) {
            s.connect(new LocalSocketAddress(name, LocalSocketAddress.Namespace.ABSTRACT));
            s.setSoTimeout(3000);
            s.getOutputStream().write("GET /status HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            InputStream in = s.getInputStream();
            byte[] buf = new byte[64];
            int n = in.read(buf);
            if (n <= 0) return "connect: closed without an answer";
            return "connect: answered " + new String(buf, 0, n, StandardCharsets.US_ASCII).split("\r\n")[0];
        } catch (IOException e) {
            return "connect: " + e.getClass().getSimpleName() + " " + e.getMessage();
        }
    }
}
