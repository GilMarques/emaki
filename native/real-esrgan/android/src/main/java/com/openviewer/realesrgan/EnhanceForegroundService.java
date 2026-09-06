package com.openviewer.realesrgan;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service that keeps the process (and CPU) alive while a scan
 * enhancement batch runs, so it keeps progressing when the app is backgrounded
 * or the screen turns off.
 *
 * The actual work still runs on the CapacitorPlugin thread; this service only
 * holds the process foreground (notification) and a partial wake lock so Doze /
 * screen-off can't suspend it. Progress is pushed in from the JS layer via
 * {@link RealEsrganPlugin#updateForeground}.
 */
public class EnhanceForegroundService extends Service {

    private static final String CHANNEL_ID = "openviewer-enhance";
    private static final int NOTIFICATION_ID = 1701;

    private static volatile EnhanceForegroundService sInstance;
    private static volatile int sDone = 0;
    private static volatile int sTotal = 0;

    private PowerManager.WakeLock wakeLock;

    /** Update the cached progress and refresh the live notification, if any. */
    public static void setProgress(int done, int total) {
        sDone = done;
        sTotal = total;
        EnhanceForegroundService svc = sInstance;
        if (svc != null) svc.refreshNotification();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        createChannel();
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "openviewer:enhance");
            wakeLock.acquire();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, buildNotification());
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        sInstance = null;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    private void refreshNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification());
    }

    private Notification buildNotification() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("Enhancing scans")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi);
        if (sTotal > 0) {
            b.setProgress(sTotal, Math.min(sDone, sTotal), false)
             .setContentText(sDone + " / " + sTotal + " pages");
        } else {
            b.setContentText("Preparing…");
        }
        return b.build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Scan enhancement", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Progress for background scan enhancement");
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }
}