package com.example.fin

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log

/**
 * Live bank-SMS capture.
 *
 * Fires on every incoming message, keeps the ones that look like transactions,
 * and drops them into the review queue. Nothing is ever written to the ledger
 * from here — a regex is not allowed to move money on its own.
 *
 * Never calls abortBroadcast(): the messaging app must still receive the SMS.
 */
class FinSmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        try {
            // Multipart messages arrive as several PDUs that must be stitched back
            // together per sender, or a long bank SMS parses as fragments.
            val bySender = HashMap<String, StringBuilder>()
            var stamp = System.currentTimeMillis()

            for (msg in Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return) {
                val from = msg.displayOriginatingAddress ?: msg.originatingAddress ?: "SMS"
                bySender.getOrPut(from) { StringBuilder() }.append(msg.displayMessageBody ?: "")
                if (msg.timestampMillis > 0) stamp = msg.timestampMillis
            }

            for ((sender, body) in bySender) {
                val parsed = FinTxnParser.parse("sms", sender, body.toString(), stamp)
                if (parsed != null) {
                    FinTxnParser.enqueue(context, parsed)
                    Log.d(TAG, "captured ${parsed.optLong("amountPaise")}p from $sender")
                }
            }
        } catch (e: Exception) {
            // A crash in a broadcast receiver takes down SMS delivery for the device.
            Log.e(TAG, "sms parse failed", e)
        }
    }

    companion object { private const val TAG = "FinSmsReceiver" }
}
