package com.example.fin

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/**
 * Watches notifications from the apps you selected and turns the ones that look
 * like transactions into review-queue entries.
 *
 * All parsing lives in FinTxnParser. This file used to carry its own copy, which
 * had drifted: it multiplied a Double by 100 to get paise (losing a paisa on
 * amounts like 450.55) and emitted a different JSON shape than the SMS path, so
 * the shared queue held two incompatible record types.
 */
class FinNotificationListener : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        super.onNotificationPosted(sbn)
        val n = sbn ?: return
        val pkg = n.packageName ?: return

        if (!FinTxnParser.isMonitored(applicationContext, pkg)) return

        val extras = n.notification?.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        // BIG_TEXT carries the full body; EXTRA_TEXT is often truncated with an ellipsis
        // and would cut the amount off a long bank notification.
        val body = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
            ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()

        val full = "$title $body".trim()
        if (full.isEmpty()) return

        try {
            FinTxnParser.parse(pkg, title.ifBlank { pkg }, full, n.postTime)?.let {
                Log.i(TAG, "captured ${it.optLong("amountPaise")}p from $pkg")
                FinTxnParser.enqueue(applicationContext, it)
            }
        } catch (e: Exception) {
            Log.e(TAG, "notification parse failed for $pkg", e)
        }
    }

    companion object { private const val TAG = "FinNotification" }
}
