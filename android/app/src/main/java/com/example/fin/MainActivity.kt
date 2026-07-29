package com.example.fin

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricPrompt
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.provider.Telephony
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var prefs: SharedPreferences

    companion object {
        private const val TAG = "FinNative"
        private const val REQ_DEVICE_CREDENTIAL = 102
        private const val REQ_SMS_PERMISSION = 103

        /* BiometricConstants error codes. The framework BiometricPrompt only
         * exposes some of these as public fields, and not on every API level,
         * so the two we branch on are pinned here by value. */
        private const val ERR_NEGATIVE_BUTTON = 13
        private const val ERR_USER_CANCELED = 10

        var instance: MainActivity? = null

        /**
         * The only way native code talks to the web layer.
         *
         * Everything funnels through here so the JSON is escaped exactly once and
         * a missing handler on the JS side is a no-op rather than a crash.
         */
        fun pushToWeb(fn: String, jsonArg: String) {
            val a = instance ?: return
            a.runOnUiThread {
                a.webView.evaluateJavascript(
                    "window.FinApp && typeof window.FinApp.$fn === 'function' && window.FinApp.$fn($jsonArg);",
                    null
                )
            }
        }

        @Deprecated("use pushToWeb", ReplaceWith("pushToWeb(\"onCaptureReceived\", txnJson)"))
        fun notifyLiveWebInstance(txnJson: String) = pushToWeb("onCaptureReceived", txnJson)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = this
        prefs = getSharedPreferences("FinOSConfig", Context.MODE_PRIVATE)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.allowFileAccess = false          // assets are served through the interceptor
            settings.allowContentAccess = false
            settings.mediaPlaybackRequiresUserGesture = false
            settings.cacheMode = WebSettings.LOAD_DEFAULT

            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest?) {
                    if (request?.resources?.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) == true) {
                        if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA)
                            == PackageManager.PERMISSION_GRANTED) {
                            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                        } else {
                            ActivityCompat.requestPermissions(this@MainActivity, arrayOf(Manifest.permission.CAMERA), 101)
                            request.deny()   // grant on the retry after the OS dialog resolves
                        }
                    } else super.onPermissionRequest(request)
                }

                override fun onConsoleMessage(m: ConsoleMessage?): Boolean {
                    Log.d("FinWebConsole", "${m?.message()} [${m?.sourceId()}:${m?.lineNumber()}]")
                    return true
                }
            }

            webViewClient = object : WebViewClient() {
                // Assets are served from a real https origin so ES modules, IndexedDB
                // and getUserMedia all behave. A file:// origin is treated as null and
                // blocks every one of them.
                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                    val url = request?.url ?: return null
                    if (url.scheme != "https" || url.host != "fin.local") return null
                    val path = url.path?.removePrefix("/").orEmpty()
                    val assetPath = if (path.isEmpty()) "www/index.html" else "www/$path"
                    return try {
                        WebResourceResponse(mimeOf(assetPath), "UTF-8", assets.open(assetPath)).apply {
                            responseHeaders = mapOf("Cache-Control" to "no-cache")
                        }
                    } catch (e: Exception) {
                        Log.e("FinAssetLoader", "missing asset: $assetPath")
                        null
                    }
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    intent.getStringExtra("quick_action")?.takeIf { it.isNotEmpty() }?.let {
                        pushToWeb("quickAction", "\"$it\"")
                    }
                }
            }

            addJavascriptInterface(FinNativeBridge(), "FinNative")
        }

        setContentView(webView)
        webView.loadUrl("https://fin.local/index.html")

        onBackPressedDispatcher.addCallback(this) {
            // Let the web layer handle back first (close a sheet, pop a screen).
            webView.evaluateJavascript(
                "(window.FinApp && typeof window.FinApp.handleBack === 'function') ? window.FinApp.handleBack() : false;"
            ) { result -> if (result != "true") finish() }
        }
    }

    private fun mimeOf(p: String) = when {
        p.endsWith(".html", true) -> "text/html"
        p.endsWith(".js", true) || p.endsWith(".mjs", true) -> "text/javascript"
        p.endsWith(".css", true) -> "text/css"
        p.endsWith(".webmanifest", true) -> "application/manifest+json"
        p.endsWith(".json", true) -> "application/json"
        p.endsWith(".svg", true) -> "image/svg+xml"
        p.endsWith(".png", true) -> "image/png"
        p.endsWith(".woff2", true) -> "font/woff2"
        else -> "application/octet-stream"
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra("quick_action")?.takeIf { it.isNotEmpty() }?.let {
            pushToWeb("quickAction", "\"$it\"")
        }
    }

    override fun onResume() {
        super.onResume()
        // Coming back from a UPI app is the moment to ask "did that go through?"
        prefs.getString("pending_payment", null)?.let {
            prefs.edit().remove("pending_payment").apply()
            pushToWeb("onReturnFromPayment", it)
        }
        pushToWeb("onResumed", "{}")
    }

    /** Device-credential fallback lands here. Without this the PIN path was silent. */
    @Deprecated("startActivityForResult")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_DEVICE_CREDENTIAL) {
            emitBiometric(resultCode == Activity.RESULT_OK, if (resultCode == Activity.RESULT_OK) "credential" else "cancelled")
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_SMS_PERMISSION) {
            val ok = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            pushToWeb("onSmsPermissionResult", if (ok) "true" else "false")
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (instance == this) instance = null
    }

    /** Single exit point for every biometric outcome, success or otherwise. */
    private fun emitBiometric(ok: Boolean, reason: String) =
        pushToWeb("onBiometricResult", "$ok, ${JSONObject.quote(reason)}")

    // ─────────────────────────────────────────────────────────────────────────
    inner class FinNativeBridge {

        @JavascriptInterface
        fun platform(): String = "android"

        /* ── UPI ───────────────────────────────────────────────────────────── */

        /**
         * Every installed app that can handle upi://pay, as [{package,label}].
         * Requires the <queries> block in the manifest on Android 11+.
         */
        @JavascriptInterface
        fun getInstalledUpiApps(): String {
            val probe = Intent(Intent.ACTION_VIEW, Uri.parse("upi://pay?pa=test@upi&pn=Test&cu=INR"))
            val out = JSONArray()
            try {
                val flags = if (Build.VERSION.SDK_INT >= 33)
                    PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_ALL.toLong()) else null
                @Suppress("DEPRECATION")
                val list = if (flags != null) packageManager.queryIntentActivities(probe, flags)
                           else packageManager.queryIntentActivities(probe, PackageManager.MATCH_ALL)
                val seen = HashSet<String>()
                for (ri in list) {
                    val pkg = ri.activityInfo?.packageName ?: continue
                    if (!seen.add(pkg)) continue
                    out.put(JSONObject().apply {
                        put("package", pkg)
                        put("label", ri.loadLabel(packageManager).toString())
                    })
                }
            } catch (e: Exception) {
                Log.e(TAG, "upi app query failed", e)
            }
            return out.toString()
        }

        /**
         * Launch a payment.
         *
         * With targetPackage set, the intent goes straight to that app and the
         * system chooser never appears — that is the whole point of a default app.
         * Falls back to the chooser if the package is missing or cannot resolve,
         * because failing to open anything is worse than showing a picker.
         */
        @JavascriptInterface
        fun launchUpiIntent(uriString: String, targetPackage: String?, sessionJson: String?): Boolean {
            return try {
                if (!sessionJson.isNullOrBlank()) prefs.edit().putString("pending_payment", sessionJson).apply()
                val base = Intent(Intent.ACTION_VIEW, Uri.parse(uriString))
                if (!targetPackage.isNullOrBlank()) {
                    val direct = Intent(base).setPackage(targetPackage)
                    if (direct.resolveActivity(packageManager) != null) {
                        direct.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        startActivity(direct)
                        return true
                    }
                    Log.w(TAG, "$targetPackage cannot handle upi://, falling back to chooser")
                }
                Intent.createChooser(base, "Pay with").apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(this)
                }
                true
            } catch (e: Exception) {
                Log.e(TAG, "upi launch failed", e)
                false
            }
        }

        @JavascriptInterface
        fun canHandleUpi(): Boolean =
            Intent(Intent.ACTION_VIEW, Uri.parse("upi://pay")).resolveActivity(packageManager) != null

        /* ── Notifications ─────────────────────────────────────────────────── */

        @JavascriptInterface
        fun isNotificationAccessGranted(): Boolean =
            Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
                ?.contains(packageName) == true

        @JavascriptInterface
        fun requestNotificationAccess() {
            try {
                startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Settings → Notification access → enable Fin", Toast.LENGTH_LONG).show()
            }
        }

        /** Every launchable app on the device, so you can pick which ones to monitor. */
        @JavascriptInterface
        fun getInstalledApps(): String {
            val out = JSONArray()
            try {
                val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                @Suppress("DEPRECATION")
                for (ri in packageManager.queryIntentActivities(launcher, 0)) {
                    val pkg = ri.activityInfo?.packageName ?: continue
                    if (pkg == packageName) continue
                    out.put(JSONObject().apply {
                        put("package", pkg)
                        put("label", ri.loadLabel(packageManager).toString())
                    })
                }
            } catch (e: Exception) { Log.e(TAG, "app list failed", e) }
            return out.toString()
        }

        @JavascriptInterface
        fun updateMonitoredApps(appListJson: String) {
            prefs.edit().putString("monitored_apps", appListJson).apply()
        }

        @JavascriptInterface
        fun getCaptureQueue(): String = prefs.getString("notification_queue", "[]") ?: "[]"

        @JavascriptInterface
        fun clearCaptureQueue() { prefs.edit().putString("notification_queue", "[]").apply() }

        /* ── SMS ───────────────────────────────────────────────────────────── */

        @JavascriptInterface
        fun hasSmsPermission(): Boolean =
            ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.READ_SMS) ==
                PackageManager.PERMISSION_GRANTED

        @JavascriptInterface
        fun requestSmsPermission() {
            runOnUiThread {
                ActivityCompat.requestPermissions(
                    this@MainActivity,
                    arrayOf(Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS),
                    REQ_SMS_PERMISSION
                )
            }
        }

        /**
         * Back-fill from the inbox. Runs on demand, not on a schedule — reading the
         * whole SMS history in the background is not something this app should do
         * without you asking for it.
         */
        @JavascriptInterface
        fun readRecentSms(limit: Int, sinceMillis: Double): String {
            if (!hasSmsPermission()) return "[]"
            val out = JSONArray()
            try {
                val since = sinceMillis.toLong()
                contentResolver.query(
                    Telephony.Sms.Inbox.CONTENT_URI,
                    arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE),
                    if (since > 0) "${Telephony.Sms.DATE} > ?" else null,
                    if (since > 0) arrayOf(since.toString()) else null,
                    "${Telephony.Sms.DATE} DESC LIMIT ${limit.coerceIn(1, 500)}"
                )?.use { c ->
                    val iA = c.getColumnIndex(Telephony.Sms.ADDRESS)
                    val iB = c.getColumnIndex(Telephony.Sms.BODY)
                    val iD = c.getColumnIndex(Telephony.Sms.DATE)
                    while (c.moveToNext()) {
                        FinTxnParser.parse("sms", c.getString(iA) ?: "SMS", c.getString(iB) ?: "", c.getLong(iD))
                            ?.let { out.put(it) }
                    }
                }
            } catch (e: Exception) { Log.e(TAG, "sms read failed", e) }
            return out.toString()
        }

        /* ── Biometric ─────────────────────────────────────────────────────── */

        /**
         * The previous version overrode only onAuthenticationSucceeded and showed a
         * Toast, so the web layer was never told anything and the lock screen hung
         * forever. All four outcomes now report back.
         */
        @JavascriptInterface
        fun requestBiometricLock() {
            runOnUiThread {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) { deviceCredential(); return@runOnUiThread }
                try {
                    val prompt = BiometricPrompt.Builder(this@MainActivity)
                        .setTitle("Unlock Fin")
                        .setDescription("Verify your identity to open your ledger")
                        .setNegativeButton("Use PIN", mainExecutor) { _, _ -> deviceCredential() }
                        .build()

                    prompt.authenticate(CancellationSignal(), mainExecutor,
                        object : BiometricPrompt.AuthenticationCallback() {
                            override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult?) =
                                emitBiometric(true, "biometric")

                            override fun onAuthenticationError(code: Int, msg: CharSequence?) {
                                // The negative button routes to the PIN path; don't
                                // report failure or the shield would close early.
                                if (code == ERR_NEGATIVE_BUTTON) return
                                if (code == ERR_USER_CANCELED) { emitBiometric(false, "cancelled"); return }
                                if (code == BiometricPrompt.BIOMETRIC_ERROR_NO_BIOMETRICS ||
                                    code == BiometricPrompt.BIOMETRIC_ERROR_HW_UNAVAILABLE ||
                                    code == BiometricPrompt.BIOMETRIC_ERROR_HW_NOT_PRESENT) {
                                    deviceCredential()
                                    return
                                }
                                emitBiometric(false, msg?.toString() ?: "error $code")
                            }

                            // Fires on a bad finger; the prompt stays up for a retry,
                            // so this is informational only, never a final answer.
                            override fun onAuthenticationFailed() =
                                pushToWeb("onBiometricAttemptFailed", "{}")
                        })
                } catch (e: Exception) {
                    Log.e(TAG, "biometric failed", e)
                    deviceCredential()
                }
            }
        }

        @JavascriptInterface
        fun isBiometricAvailable(): Boolean {
            val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            return km.isKeyguardSecure
        }

        /* ── Misc ──────────────────────────────────────────────────────────── */

        /* ── Staying alive on Xiaomi ──────────────────────────────────────────
         * HyperOS/MIUI terminates background services far more aggressively than
         * stock Android. Without Autostart granted, the notification listener and
         * the SMS receiver are killed within hours and the automation quietly
         * stops. Neither permission can be granted programmatically — both need a
         * one-time visit to a Xiaomi settings screen, so the app has to be able
         * to send you straight there.
         */
        @JavascriptInterface
        fun isXiaomi(): Boolean =
            Build.MANUFACTURER.equals("Xiaomi", true) ||
            Build.BRAND.equals("Redmi", true) || Build.BRAND.equals("Poco", true)

        @JavascriptInterface
        fun openAutostartSettings(): Boolean {
            // Ordered most- to least-specific; MIUI versions moved this activity.
            val targets = listOf(
                "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
                "com.miui.securitycenter" to "com.miui.permcenter.permissions.PermissionsEditorActivity",
                "com.letv.android.letvsafe" to "com.letv.android.letvsafe.AutobootManageActivity",
                "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity"
            )
            for ((pkg, cls) in targets) {
                try {
                    val i = Intent().setClassName(pkg, cls).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    if (i.resolveActivity(packageManager) != null) { startActivity(i); return true }
                } catch (e: Exception) { /* try the next one */ }
            }
            return try {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:$packageName"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                true
            } catch (e: Exception) { false }
        }

        @JavascriptInterface
        fun isBatteryUnrestricted(): Boolean = try {
            (getSystemService(Context.POWER_SERVICE) as android.os.PowerManager)
                .isIgnoringBatteryOptimizations(packageName)
        } catch (e: Exception) { true }

        @JavascriptInterface
        fun requestBatteryUnrestricted() {
            try {
                startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:$packageName"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: Exception) {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }

        /** Which of the apps we care about are actually on this phone. */
        @JavascriptInterface
        fun hasPackage(pkg: String): Boolean = try {
            packageManager.getPackageInfo(pkg, 0); true
        } catch (e: Exception) { false }

        @JavascriptInterface
        fun vibrate(ms: Int) {
            try {
                val v = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                    (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
                else @Suppress("DEPRECATION") (getSystemService(Context.VIBRATOR_SERVICE) as Vibrator)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    v.vibrate(VibrationEffect.createOneShot(ms.toLong().coerceIn(5, 200), VibrationEffect.DEFAULT_AMPLITUDE))
                else @Suppress("DEPRECATION") v.vibrate(ms.toLong())
            } catch (e: Exception) { /* vibration is never worth a crash */ }
        }

        @JavascriptInterface
        fun toast(msg: String) = runOnUiThread {
            Toast.makeText(this@MainActivity, msg, Toast.LENGTH_SHORT).show()
        }
    }

    private fun deviceCredential() {
        val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        if (!km.isKeyguardSecure) {
            // No lock on the device: refusing entry would strand you out of your own
            // ledger, so report success and let the web layer decide.
            emitBiometric(true, "no-device-lock")
            return
        }
        @Suppress("DEPRECATION")
        val i = km.createConfirmDeviceCredentialIntent("Unlock Fin", "Verify your identity")
        if (i != null) {
            @Suppress("DEPRECATION")
            startActivityForResult(i, REQ_DEVICE_CREDENTIAL)
        } else emitBiometric(false, "no-credential-ui")
    }
}
