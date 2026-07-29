package com.example.fin

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * One parser for every source of transaction text.
 *
 * The notification listener and the SMS receiver were about to grow their own
 * copies of these regexes. Two copies of money-parsing logic is two things that
 * drift apart, so both call in here instead.
 *
 * Everything is integer paise. Never a float, never a Double.
 */
object FinTxnParser {

    private const val QUEUE_KEY = "notification_queue"
    private const val PREFS = "FinOSConfig"
    private const val MAX_QUEUE = 120

    /** Money markers: "Rs.450", "INR 1,200.50", "₹120", "450.00 debited" */
    private val AMOUNT = Regex(
        """(?:(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?))|(?:([\d,]+(?:\.\d{1,2})?)\s*(?:rs\.?|inr|₹))""",
        RegexOption.IGNORE_CASE
    )

    /** Words that mean money left the account. */
    private val DEBIT = Regex(
        """\b(debited|debit|paid|spent|sent|withdrawn|deducted|purchase|txn of|charged|transferred to)\b""",
        RegexOption.IGNORE_CASE
    )

    /** Words that mean money arrived. */
    private val CREDIT = Regex(
        """\b(credited|credit|received|deposited|refund(?:ed)?|cashback|added to|salary)\b""",
        RegexOption.IGNORE_CASE
    )

    /** Counterparty. Ordered: most specific phrasing first. */
    private val MERCHANT = listOf(
        Regex("""(?:paid to|sent to|transferred to|payment to)\s+([A-Za-z0-9@._&'\- ]{2,40}?)(?=\s+(?:on|via|using|ref|utr|txn|a/c|upi|dated|\.|,|$))""", RegexOption.IGNORE_CASE),
        Regex("""(?:received from|credited by|from)\s+([A-Za-z0-9@._&'\- ]{2,40}?)(?=\s+(?:on|via|using|ref|utr|txn|a/c|upi|dated|\.|,|$))""", RegexOption.IGNORE_CASE),
        Regex("""(?:at|towards)\s+([A-Za-z0-9@._&'\- ]{2,40}?)(?=\s+(?:on|via|using|ref|utr|txn|dated|\.|,|$))""", RegexOption.IGNORE_CASE),
        Regex("""\b(?:vpa|to vpa)\s+([A-Za-z0-9._\-]+@[A-Za-z]+)""", RegexOption.IGNORE_CASE)
    )

    private val REFERENCE = Regex(
        """(?:ref(?:erence)?|utr|txn|transaction)\s*(?:no\.?|number|id|#)?\s*[:\-=]?\s*([0-9A-Za-z]{6,25})""",
        RegexOption.IGNORE_CASE
    )

    /** OTP and promotional messages look like transactions but are not. */
    private val NOT_A_TXN = Regex(
        """\b(otp|one[ -]?time password|do not share|will expire|offer|cashback offer|apply now|loan|emi due|reward points|balance is|avl bal|available balance|statement|due date|min due)\b""",
        RegexOption.IGNORE_CASE
    )

    /** Paise, as an exact Long. "1,200.50" → 120050 */
    private fun toPaise(raw: String): Long {
        val clean = raw.replace(",", "").trim()
        val dot = clean.indexOf('.')
        return if (dot < 0) {
            clean.toLongOrNull()?.times(100) ?: 0L
        } else {
            val whole = clean.substring(0, dot).toLongOrNull() ?: 0L
            // Pad "5" → "50" so ".5" is 50 paise, not 5.
            val frac = clean.substring(dot + 1).padEnd(2, '0').take(2).toLongOrNull() ?: 0L
            whole * 100 + frac
        }
    }

    /**
     * @return a JSON transaction proposal, or null when the text is not a transaction.
     *         Returning null generously is correct: a missed SMS costs one manual
     *         entry, a false one silently corrupts the ledger.
     */
    fun parse(source: String, sender: String, body: String, timestamp: Long): JSONObject? {
        if (body.isBlank()) return null
        if (NOT_A_TXN.containsMatchIn(body)) return null

        val m = AMOUNT.find(body) ?: return null
        val amountPaise = toPaise(m.groupValues[1].ifBlank { m.groupValues[2] })
        if (amountPaise <= 0L) return null

        val isCredit = CREDIT.containsMatchIn(body) && !DEBIT.containsMatchIn(body)

        var merchant = ""
        for (r in MERCHANT) {
            val hit = r.find(body)?.groupValues?.getOrNull(1)?.trim()
            if (!hit.isNullOrBlank()) { merchant = hit.trimEnd('.', ',', ' '); break }
        }
        if (merchant.isBlank()) merchant = sender

        return JSONObject().apply {
            put("id", "sms_" + timestamp + "_" + amountPaise)
            put("type", if (isCredit) "receive" else "spend")
            put("amountPaise", amountPaise)
            put("merchant", merchant)
            put("sourceAppId", source)
            put("sourceAppName", sender)
            put("reference", REFERENCE.find(body)?.groupValues?.getOrNull(1) ?: JSONObject.NULL)
            put("timestamp", timestamp)
            put("rawText", body.take(200))
            put("status", "pending")
        }
    }

    /**
     * Append to the queue the WebView reads on resume.
     *
     * Deduplicated on reference, then on (amount, 90-second window): the same
     * payment routinely arrives twice, once from the bank SMS and once from the
     * UPI app notification.
     */
    @Synchronized
    fun enqueue(context: Context, item: JSONObject) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val queue = try { JSONArray(prefs.getString(QUEUE_KEY, "[]")) } catch (e: Exception) { JSONArray() }

        val ref = item.optString("reference", "")
        val amt = item.optLong("amountPaise")
        val ts = item.optLong("timestamp")
        for (i in 0 until queue.length()) {
            val e = queue.optJSONObject(i) ?: continue
            if (ref.isNotBlank() && ref == e.optString("reference", "")) return
            if (e.optLong("amountPaise") == amt && Math.abs(e.optLong("timestamp") - ts) < 90_000L) return
        }

        val out = JSONArray().put(item)
        for (i in 0 until minOf(queue.length(), MAX_QUEUE - 1)) out.put(queue.get(i))
        prefs.edit().putString(QUEUE_KEY, out.toString()).apply()

        MainActivity.pushToWeb("onCaptureReceived", item.toString())
    }

    /** Package allow-list for the notification listener. Empty means "everything". */
    fun isMonitored(context: Context, pkg: String): Boolean {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString("monitored_apps", null) ?: return true
        return try {
            val arr = JSONArray(raw)
            if (arr.length() == 0) return true
            (0 until arr.length()).any { arr.optString(it) == pkg }
        } catch (e: Exception) { true }
    }
}
