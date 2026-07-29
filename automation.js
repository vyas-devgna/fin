/* automation.js — Selective Notification & SMS Automation Manager.
 *
 * Configures OS-level app filtering (only inspecting user-selected apps) and
 * applies financial NLP heuristics to transform incoming debits/credits into
 * ready-to-log ledger items without compromise to privacy or calculation exactitude.
 */
import { parseAmount, uid } from './core.js';

const MONITORED_APPS_KEY = 'fin_monitored_apps';
const NOTIFY_QUEUE_KEY = 'fin_notification_queue';

/**
 * Standard banking, UPI, and SMS messaging packages available for monitoring.
 */
export const POPULAR_FINANCE_APPS = [
  { id: 'com.google.android.apps.nbu.paisa.user', name: 'Google Pay (GPay)', icon: 'gpay', type: 'upi' },
  { id: 'com.phonepe.app', name: 'PhonePe', icon: 'phonepe', type: 'upi' },
  { id: 'net.one97.paytm', name: 'Paytm Payments', icon: 'paytm', type: 'upi' },
  { id: 'com.dreamplug.androidapp', name: 'CRED Club', icon: 'cred', type: 'upi' },
  { id: 'in.org.npci.upiapp', name: 'BHIM NPCI UPI', icon: 'bhim', type: 'upi' },
  { id: 'com.snapwork.hdfc', name: 'HDFC Bank Mobile', icon: 'hdfc', type: 'bank' },
  { id: 'com.sbi.lotusintouch', name: 'YONO SBI', icon: 'sbi', type: 'bank' },
  { id: 'com.csam.icici.bank.imobile', name: 'ICICI iMobile Pay', icon: 'icici', type: 'bank' },
  { id: 'com.google.android.apps.messaging', name: 'Google Messages (Bank SMS)', icon: 'sms', type: 'sms' },
  { id: 'com.samsung.android.messaging', name: 'Samsung SMS Messages', icon: 'sms', type: 'sms' },
];

/**
 * Retreives currently user-whitelisted package IDs for selective monitoring.
 */
export function getMonitoredApps() {
  try {
    const raw = localStorage.getItem(MONITORED_APPS_KEY);
    if (!raw) {
      // Default initial selection: GPay and PhonePe only
      return ['com.google.android.apps.nbu.paisa.user', 'com.phonepe.app'];
    }
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Updates monitored app checklist and instantly syncs to native Android OS Service via bridge.
 */
export function setMonitoredApps(packageList = []) {
  const cleanList = Array.from(new Set(packageList.filter(Boolean)));
  localStorage.setItem(MONITORED_APPS_KEY, JSON.stringify(cleanList));
  
  // Sync immediately to Android native SharedPreferences if bridge is active
  if (window.FinNative && typeof window.FinNative.updateMonitoredApps === 'function') {
    window.FinNative.updateMonitoredApps(JSON.stringify(cleanList));
  }
  return cleanList;
}

/**
 * Parses financial notification/SMS text into clean amount, transaction direction, and merchant metadata.
 */
export function parseNotificationText(packageId, text = '', title = '', timestamp = Date.now()) {
  if (!text || !text.trim()) return null;
  const fullText = `${title} ${text}`.trim();
  const lower = fullText.toLowerCase();

  // Ensure notification contains monetary reference or banking keywords
  const hasMoneyMarker = /(?:₹|rs\.?|inr|amt|amount)/i.test(fullText) || 
                         /(?:debited|credited|paid to|received from|spent|sent to)/i.test(fullText);
  if (!hasMoneyMarker) return null;

  // Extract amount: handles "Rs. 450", "INR 1,200.50", "Rs 50.00", "₹120"
  const amtMatch = fullText.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i) || 
                   fullText.match(/amount(?: of)?\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!amtMatch || !amtMatch[1]) return null;

  const amountPaise = parseAmount(amtMatch[1]);
  if (isNaN(amountPaise) || amountPaise <= 0) return null;

  // Determine transaction direction
  let type = 'spend';
  if (/\b(?:credited|received|refunded|deposited|added|got)\b/i.test(fullText) && 
      !/\b(?:debited|paid|spent|sent|deducted)\b/i.test(fullText)) {
    type = 'receive';
  }

  // Extract merchant / counterparty entity name
  let merchant = 'Unknown Merchant';
  const merchMatch = fullText.match(/(?:paid to|sent to|received from|credited to|at|by|(?:\bto\b))\s+(?!(?:your|account|a\/c|bank)\b)([A-Za-z0-9\s&._-]+?)(?:\s+(?:via|using|ref|utr|on|for|from|a\/c|upi|in|with|\.|\d)|$)/i) ||
                     fullText.match(/(?:from)\s+(?!(?:your|account|a\/c|bank)\b)([A-Za-z0-9\s&._-]+?)(?:\s+(?:via|using|ref|utr|on|for|to|a\/c|upi|in|with|\.|\d)|$)/i);
  if (merchMatch && merchMatch[1].trim().length >= 2) {
    merchant = merchMatch[1].trim().replace(/[.\s]+$/, '');
  } else if (title && !title.toLowerCase().includes('bank') && !title.toLowerCase().includes('pay')) {
    merchant = title.trim();
  }

  // Extract UPI Reference Number or Bank UTR if available
  const refMatch = fullText.match(/(?:ref|utr|txn|id)(?: no\.?| number| #)?\s*[:=-]?\s*([0-9a-zA-Z]{6,20})/i);
  const reference = refMatch ? refMatch[1].trim() : null;

  const appInfo = POPULAR_FINANCE_APPS.find((a) => a.id === packageId) || { name: packageId || 'System Alert' };

  return {
    id: uid(),
    type,
    amountPaise,
    merchant,
    note: `${merchant}${reference ? ` (Ref: ${reference})` : ''}`,
    sourceAppId: packageId || 'unknown',
    sourceAppName: appInfo.name,
    timestamp,
    rawText: text.slice(0, 140),
    status: 'pending',
  };
}

/**
 * Returns currently queued transaction suggestions detected from OS notifications.
 */
export function getNotificationQueue() {
  try {
    return JSON.parse(localStorage.getItem(NOTIFY_QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

/**
 * Appends a new detected transaction proposal to the live review queue.
 */
export function addToNotificationQueue(proposal) {
  if (!proposal || !proposal.amountPaise) return;
  const queue = getNotificationQueue();
  // Prevent duplication of identical reference or exact simultaneous timestamps
  if (queue.some((i) => (proposal.reference && i.note.includes(proposal.reference)) || 
                        (i.amountPaise === proposal.amountPaise && Math.abs(i.timestamp - proposal.timestamp) < 5000))) {
    return;
  }
  queue.unshift(proposal);
  localStorage.setItem(NOTIFY_QUEUE_KEY, JSON.stringify(queue.slice(0, 30))); // Cap at 30 recent notifications
}

/**
 * Removes a processed or dismissed transaction item from the review queue.
 */
export function removeFromQueue(id) {
  const queue = getNotificationQueue().filter((item) => item.id !== id);
  localStorage.setItem(NOTIFY_QUEUE_KEY, JSON.stringify(queue));
  return queue;
}

/**
 * Clears the entire notification review queue.
 */
export function clearNotificationQueue() {
  localStorage.removeItem(NOTIFY_QUEUE_KEY);
}
