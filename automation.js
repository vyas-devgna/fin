/* automation.js — transaction text parsing for the web build.
 *
 * On Android the real work happens natively in FinTxnParser.kt, which runs even
 * when the app is closed. This is the browser-side equivalent, kept for the web
 * build and because test.js pins its behaviour.
 *
 * The queue itself used to live here in localStorage. It now lives in the
 * native SharedPreferences queue read through native.js, so it survives the app
 * being killed and is covered by backup/export. Everything related to that has
 * been removed rather than left to rot alongside a second source of truth.
 */
import { parseAmount, uid } from './core.js';

/** "Rs.450", "INR 1,200.50", "₹120", "450.00 debited" */
const AMOUNT = /(?:(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?))|(?:([\d,]+(?:\.\d{1,2})?)\s*(?:rs\.?|inr|₹))/i;
const DEBIT = /\b(debited|debit|paid|spent|sent|withdrawn|deducted|purchase|charged|transferred to)\b/i;
const CREDIT = /\b(credited|credit|received|deposited|refund(?:ed)?|cashback|added to|salary)\b/i;

/* OTPs and offers look like transactions and are not. Dropping a real one costs
 * a manual entry; accepting a fake one corrupts the ledger. */
const NOT_A_TXN = /\b(otp|one[ -]?time password|do not share|will expire|offer|apply now|reward points|avl bal|available balance|balance is|statement|min due|due date)\b/i;

/* The counterparty follows "to" or "from", but bank SMS says "debited from bank
 * account XX4567 to SWIGGY STORES" — so both prepositions appear and the first
 * one points at your own account, not the merchant. NOISE skips those. */
const NOISE = String.raw`(?!(?:your|the|a\/c|ac|acct|account|bank|card|wallet|vpa|upi)\b)`;
const TAIL = String.raw`(?=\s+(?:on|via|using|ref|utr|txn|dated|a\/c|upi|to|from|for)\b|[.,]|$)`;
const MERCHANT = [
  new RegExp(String.raw`(?:paid to|sent to|transferred to|payment to|\bto)\s+${NOISE}([A-Za-z0-9@._&'\- ]{2,40}?)${TAIL}`, 'i'),
  new RegExp(String.raw`(?:received from|credited by|\bfrom)\s+${NOISE}([A-Za-z0-9@._&'\- ]{2,40}?)${TAIL}`, 'i'),
  new RegExp(String.raw`(?:\bat|towards)\s+${NOISE}([A-Za-z0-9@._&'\- ]{2,40}?)${TAIL}`, 'i'),
];
const REFERENCE = /(?:ref(?:erence)?|utr|txn|transaction)\s*(?:no\.?|number|id|#)?\s*[:\-=]?\s*([0-9A-Za-z]{6,25})/i;

/* Package → readable name, for "where did this come from" on a capture card. */
export const APP_NAMES = {
  'com.phonepe.app': 'PhonePe',
  'com.google.android.apps.nbu.paisa.user': 'Google Pay',
  'net.one97.paytm': 'Paytm',
  'in.org.npci.upiapp': 'BHIM',
  'indwin.c3.shareapp': 'slice',
  'money.super.payments': 'super.money',
  'com.naviapp': 'Navi',
  'com.kotak811mobilebankingapp.instantsavingsupiscanandpayrecharge': 'Kotak 811',
  'com.kotak.neo': 'Kotak Neo',
  'com.snapwork.hdfc': 'HDFC',
  'com.sbi.lotusintouch': 'SBI',
  'com.csam.icici.bank.imobile': 'ICICI',
  'com.google.android.apps.messaging': 'Messages',
  sms: 'SMS',
};

/** @returns a transaction proposal, or null when the text is not one. */
export function parseNotificationText(packageId, text = '', title = '', timestamp = Date.now()) {
  const full = `${title} ${text}`.trim();
  if (!full || NOT_A_TXN.test(full)) return null;

  const m = full.match(AMOUNT);
  if (!m) return null;
  const amountPaise = parseAmount(m[1] || m[2]);
  if (!(amountPaise > 0)) return null;

  const type = CREDIT.test(full) && !DEBIT.test(full) ? 'receive' : 'spend';

  let merchant = '';
  for (const r of MERCHANT) {
    const hit = full.match(r)?.[1]?.trim();
    if (hit) { merchant = hit.replace(/[.,\s]+$/, ''); break; }
  }
  if (!merchant) merchant = title.trim() || packageId || 'Unknown';

  const reference = full.match(REFERENCE)?.[1] || null;

  return {
    id: uid(),
    type,
    amountPaise,
    merchant,
    note: `${merchant}${reference ? ` (Ref: ${reference})` : ''}`,
    reference,
    sourceAppId: packageId || 'unknown',
    sourceAppName: APP_NAMES[packageId] || title || packageId || 'Alert',
    timestamp,
    rawText: text.slice(0, 200),
    status: 'pending',
  };
}
