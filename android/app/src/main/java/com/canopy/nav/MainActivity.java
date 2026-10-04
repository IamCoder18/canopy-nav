package com.canopy.nav;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * Hosts the WebView for a car head unit.
 *
 * The activity is immersive: the status and navigation bars are hidden and the
 * app owns the whole display. That is not just cosmetic — Android Auto and
 * Automotive OS both run their apps distraction-free, and a navigation app has no
 * useful content for a status bar. It also removes the edge-to-edge overlap that
 * Android 15 introduces, where the bars are drawn over the WebView and CSS
 * `env(safe-area-inset-*)` reports nothing, leaving the app bar behind the clock.
 *
 * Transient bars are allowed to reappear on a swipe and auto-hide again, so the
 * driver is never trapped.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyImmersiveMode();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // The system restores the bars after dialogs, recents and rotation;
        // re-assert immersive mode whenever we regain focus.
        if (hasFocus) {
            applyImmersiveMode();
        }
    }

    private void applyImmersiveMode() {
        // Draw behind the system bars so the map fills the display.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller == null) {
            return;
        }
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Belt and braces: the platform API as well as the compat wrapper.
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        }

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
