package io.ionic.starter;

import android.os.Bundle;

import androidx.activity.EdgeToEdge;

import com.getcapacitor.BridgeActivity;

/**
 * Edge-to-edge is only enforced by the system on Android 15+; on Android 14 and
 * below the WebView otherwise stops above the gesture/navigation bar, leaving a
 * darker system-painted band at the bottom that doesn't match the app theme.
 *
 * NOTE: EdgeToEdge.enable() MUST run AFTER super.onCreate(). Capacitor's
 * BridgeActivity.onCreate swaps the theme to AppTheme.NoActionBar; calling it
 * first forces the decor to be created with the launch theme before that swap,
 * which leaves a native ActionBar (app title band) overlaying the WebView.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this);
    }
}