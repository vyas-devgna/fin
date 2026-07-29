/* upi.js — UPI Payment Manager, intent parsing, and scanner integration.
 *
 * Handles zero-drift integer paise conversion from UPI QR strings and intents,
 * interfacing directly with native Android payment apps (GPay, PhonePe, Paytm, CRED)
 * via FinNative bridge or custom protocol fallbacks.
 */
import { parseAmount, fmt } from './core.js';

/**
 * Parses a UPI payment string (e.g. upi://pay?pa=merchant@upi&pn=Shop&am=180.50)
 * into validated integer paise and clean metadata.
 */
export function parseUpiUri(uri = '') {
  if (typeof uri !== 'string' || !uri.trim()) {
    return { valid: false, error: 'Empty UPI URI' };
  }
  const cleanUri = uri.trim();
  let url;
  try {
    // UPI URIs might not strictly conform if protocol is missing, ensure prefix
    const str = cleanUri.startsWith('upi://') ? cleanUri : `upi://pay?${cleanUri.split('?')[1] || cleanUri}`;
    url = new URL(str);
  } catch (err) {
    return { valid: false, error: 'Invalid format for UPI QR code' };
  }

  const params = url.searchParams;
  const pa = params.get('pa') || '';
  const pn = params.get('pn') || params.get('amName') || '';
  const amStr = params.get('am') || '';
  const tn = params.get('tn') || params.get('tr') || '';
  const cu = params.get('cu') || 'INR';

  if (!pa || !pa.includes('@')) {
    return { valid: false, error: 'Missing or invalid Virtual Payment Address (VPA)' };
  }

  let amountPaise = 0;
  if (amStr) {
    amountPaise = parseAmount(amStr);
    if (isNaN(amountPaise) || amountPaise < 0) {
      return { valid: false, error: 'Invalid amount in UPI QR string' };
    }
  }

  return {
    valid: true,
    payeeVpa: pa,
    payeeName: pn || pa.split('@')[0].toUpperCase(),
    amountPaise,
    note: decodeURIComponent(tn),
    currency: cu,
    rawUri: cleanUri,
  };
}

/**
 * Builds a valid UPI deep link URI from transaction parameters.
 */
export function buildUpiUri({ payeeVpa, payeeName, amountPaise = 0, note = '', currency = 'INR' }) {
  if (!payeeVpa || !payeeVpa.includes('@')) throw new Error('Invalid VPA');
  const params = new URLSearchParams();
  params.set('pa', payeeVpa);
  if (payeeName) params.set('pn', payeeName);
  if (amountPaise > 0) {
    // Convert paise to string decimals cleanly (e.g. 15000 -> "150.00")
    const rupees = (amountPaise / 100).toFixed(2);
    params.set('am', rupees);
  }
  if (note) params.set('tn', note);
  params.set('cu', currency);
  return `upi://pay?${params.toString()}`;
}
