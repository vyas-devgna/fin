/* native.js — the entire web ↔ Android contract, in one file.
 *
 * Kotlin calls `window.FinApp.<fn>(…)`. Everything it can call is registered
 * here and nowhere else, so the bridge surface is auditable in one screen
 * instead of scattered across the UI.
 *
 * Every function degrades to a no-op in a plain browser, so the same build runs
 * on the phone and on the web without branching at the call sites.
 */
import * as St from './store.js';
import { S } from './store.js';

const N = () => (typeof window !== 'undefined' ? window.FinNative : null);
export const isNative = () => !!N();

/* Handlers the UI registers against native events. */
const handlers = {
  capture: [],      // a transaction was detected from SMS or a notification
  payment: [],      // returned from a UPI app
  back: [],         // hardware back pressed; first handler to return true wins
  quick: [],        // launcher shortcut
  resume: [],
};
export const on = (evt, fn) => { handlers[evt]?.push(fn); return () => { handlers[evt] = handlers[evt].filter((f) => f !== fn); }; };
const fire = (evt, arg) => handlers[evt].map((f) => { try { return f(arg); } catch (e) { console.error(`[native:${evt}]`, e); return false; } });

/* ── Biometric ────────────────────────────────────────────────────────────────
 * The lock is a promise resolved by a native callback. The previous build had
 * no callback at all, so this promise never settled and the shield stayed up
 * forever — that was the whole of "biometric lock not working".
 */
let pendingUnlock = null;

export function unlock() {
  const n = N();
  if (!n?.requestBiometricLock) return Promise.resolve({ ok: true, reason: 'no-native' });
  if (pendingUnlock) return pendingUnlock.promise;
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  // If the OS dialog never returns (killed, backgrounded, vendor bug) the app
  // must not be bricked behind a shield that cannot be dismissed.
  const timer = setTimeout(() => settleUnlock(false, 'timeout'), 90000);
  pendingUnlock = { resolve, timer, promise };
  try { n.requestBiometricLock(); } catch (e) { settleUnlock(false, 'bridge-error'); }
  return promise;
}

function settleUnlock(ok, reason) {
  if (!pendingUnlock) return;
  clearTimeout(pendingUnlock.timer);
  const { resolve } = pendingUnlock;
  pendingUnlock = null;
  resolve({ ok, reason });
}

export const biometricAvailable = () => { try { return !!N()?.isBiometricAvailable?.(); } catch { return false; } };

/* ── UPI ──────────────────────────────────────────────────────────────────── */

/** Installed apps that can handle upi://pay. Empty array off-device. */
export function upiApps() {
  try { return JSON.parse(N()?.getInstalledUpiApps?.() || '[]'); } catch { return []; }
}

/**
 * Open a payment. `pkg` skips the system chooser entirely — that is what makes
 * a "default UPI app" mean anything.
 */
export function pay(uri, pkg = null, session = null) {
  const n = N();
  if (n?.launchUpiIntent) return !!n.launchUpiIntent(uri, pkg || '', session ? JSON.stringify(session) : '');
  if (/Android/i.test(navigator.userAgent)) { window.location.href = uri; return true; }
  console.info('[upi] would launch', uri, pkg);
  return false;
}

/* ── Notifications & SMS ──────────────────────────────────────────────────── */

export const notificationAccess = () => { try { return !!N()?.isNotificationAccessGranted?.(); } catch { return false; } };
export const requestNotificationAccess = () => N()?.requestNotificationAccess?.();
export const smsPermission = () => { try { return !!N()?.hasSmsPermission?.(); } catch { return false; } };
export const requestSmsPermission = () => N()?.requestSmsPermission?.();

export function installedApps() {
  try { return JSON.parse(N()?.getInstalledApps?.() || '[]'); } catch { return []; }
}

export function setMonitoredApps(list) {
  try { N()?.updateMonitoredApps?.(JSON.stringify(list)); } catch {}
  return St.setMeta('monitoredApps', list);
}

/** Back-fill from the SMS inbox on demand. */
export function readSms(limit = 200, since = 0) {
  try { return JSON.parse(N()?.readRecentSms?.(limit, since) || '[]'); } catch { return []; }
}

/**
 * Everything native has captured but you have not yet accepted or dismissed.
 * These are *proposals*. Nothing here has touched the ledger — a regex is not
 * allowed to move money on its own.
 */
export function drainCaptureQueue() {
  const n = N();
  if (!n?.getCaptureQueue) return [];
  let items = [];
  try { items = JSON.parse(n.getCaptureQueue() || '[]'); } catch { return []; }
  const seen = new Set((S.meta.handledCaptures || []));
  return items.filter((i) => i && i.amountPaise > 0 && !seen.has(i.id));
}

/** Mark a proposal handled without deleting the rest of the queue. */
export async function markCaptureHandled(id) {
  const handled = [...(S.meta.handledCaptures || []), id].slice(-400);
  await St.setMeta('handledCaptures', handled);
}

export const haptic = (ms = 12) => { try { N()?.vibrate?.(ms); } catch {} };
export const toast = (m) => N()?.toast?.(m);

/* ── Device health ────────────────────────────────────────────────────────────
 * Xiaomi's power manager kills background services within hours unless the app
 * is granted Autostart and exempted from battery optimisation. Neither is
 * grantable from code; both need a one-time trip to a settings screen. Without
 * them the SMS and notification capture silently stops working, which is the
 * worst possible failure mode — it looks like the feature simply does nothing.
 */
export const isXiaomi = () => { try { return !!N()?.isXiaomi?.(); } catch { return false; } };
export const openAutostart = () => N()?.openAutostartSettings?.();
export const batteryUnrestricted = () => { try { return N()?.isBatteryUnrestricted?.() !== false; } catch { return true; } };
export const requestBatteryUnrestricted = () => N()?.requestBatteryUnrestricted?.();
export const hasPackage = (p) => { try { return !!N()?.hasPackage?.(p); } catch { return false; } };

/** Everything that must be true for automation to keep running unattended. */
export function healthCheck() {
  if (!isNative()) return [];
  const issues = [];
  if (!notificationAccess()) issues.push({ id: 'notif', label: 'Notification access is off', fix: requestNotificationAccess, why: 'Bank and UPI alerts cannot be read.' });
  if (!smsPermission()) issues.push({ id: 'sms', label: 'SMS permission not granted', fix: requestSmsPermission, why: 'Bank SMS cannot be captured.' });
  if (!batteryUnrestricted()) issues.push({ id: 'battery', label: 'Battery optimisation is on', fix: requestBatteryUnrestricted, why: 'Android will kill the capture service in the background.' });
  if (isXiaomi() && !S.meta.autostartConfirmed) issues.push({ id: 'autostart', label: 'Autostart not confirmed', fix: openAutostart, why: 'HyperOS stops the capture service within hours without it.' });
  return issues;
}

/* ── First-run device profile ────────────────────────────────────────────────
 * Seeds the monitoring list from what is genuinely installed, so the defaults
 * match this phone instead of a generic list of apps you do not have.
 */
/* Apps worth watching for transaction alerts. Verified against this device;
 * anything not installed is skipped, and QUERY_ALL_PACKAGES means new installs
 * are picked up without editing this list. */
const CANDIDATES = [
  // UPI apps
  'indwin.c3.shareapp',                    // slice — keeps its original Indwin/C3 id
  'com.google.android.apps.nbu.paisa.user', // Google Pay
  'in.org.npci.upiapp',                     // BHIM
  'com.phonepe.app', 'net.one97.paytm',
  'money.super.payments', 'com.fampay.in', 'com.yield.curie_money',
  'in.amazon.mShop.android.shopping', 'com.whatsapp',
  'com.dreamplug.androidapp', 'com.samsung.android.spay', 'com.mobikwik_new',
  // Banks — these send the SMS and notifications worth capturing
  'com.kotak811mobilebankingapp.instantsavingsupiscanandpayrecharge', // Kotak 811
  'com.kotak.neo', 'com.naviapp',
  'com.snapwork.hdfc', 'com.sbi.lotusintouch',
  'com.csam.icici.bank.imobile', 'com.msf.kbank.mobile', 'com.axis.mobile',
  // SMS
  'com.google.android.apps.messaging', 'com.samsung.android.messaging',
];

/**
 * Preferred payment route, most-wanted first.
 *
 * slice leads because it is the account actually used. Note that PhonePe and
 * Paytm are deliberately absent: both are installed on this device but register
 * no `upi://pay` handler, so a directed intent at them resolves to nothing. They
 * would need their own schemes, and until then the chooser fallback covers them.
 */
const UPI_PREFERENCE = [
  'indwin.c3.shareapp',
  'com.google.android.apps.nbu.paisa.user',
  'in.org.npci.upiapp',
  'money.super.payments',
];

export async function profileDevice() {
  if (!isNative() || S.meta.deviceProfiled) return null;
  const present = CANDIDATES.filter(hasPackage);
  if (present.length) await setMonitoredApps(present);

  // Only ever route to an app that genuinely resolves upi://pay — an installed
  // app that does not handle the scheme is not a payment target.
  const canPay = upiApps().map((a) => a.package);
  const preferred = UPI_PREFERENCE.find((p) => canPay.includes(p)) || canPay[0] || null;
  if (preferred && !S.meta.defaultUpiApp) await St.setMeta('defaultUpiApp', preferred);

  await St.setMeta('deviceProfiled', true);
  return { monitored: present.length, canPay, defaultUpiApp: preferred };
}

/** Friendly names for the apps this phone actually has. */
export const APP_LABELS = {
  'indwin.c3.shareapp': 'slice',
  'com.google.android.apps.nbu.paisa.user': 'Google Pay',
  'in.org.npci.upiapp': 'BHIM',
  'com.phonepe.app': 'PhonePe',
  'net.one97.paytm': 'Paytm',
  'money.super.payments': 'super.money',
  'com.fampay.in': 'FamPay',
  'com.yield.curie_money': 'Curie Money',
  'com.whatsapp': 'WhatsApp',
  'in.amazon.mShop.android.shopping': 'Amazon Pay',
  'com.kotak811mobilebankingapp.instantsavingsupiscanandpayrecharge': 'Kotak 811',
  'com.kotak.neo': 'Kotak Neo',
  'com.naviapp': 'Navi',
  'com.google.android.apps.messaging': 'Messages',
};
export const labelFor = (pkg) => APP_LABELS[pkg] || pkg;

/* ── Registration ─────────────────────────────────────────────────────────────
 * Kotlin looks up window.FinApp.<name> and calls it if it is a function.
 */
export function install() {
  if (typeof window === 'undefined') return;
  window.FinApp = {
    onBiometricResult: (ok, reason) => settleUnlock(!!ok, reason || ''),
    onBiometricAttemptFailed: () => haptic(30),
    onCaptureReceived: (item) => fire('capture', item),
    onReturnFromPayment: (session) => fire('payment', typeof session === 'string' ? safeJson(session) : session),
    onSmsPermissionResult: (ok) => fire('resume', { smsPermission: !!ok }),
    onResumed: () => fire('resume', {}),
    quickAction: (a) => fire('quick', a),
    // Returning true tells Kotlin the web layer consumed the gesture, so the
    // activity does not finish. Returning false exits the app.
    handleBack: () => fire('back').some(Boolean),
  };
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
