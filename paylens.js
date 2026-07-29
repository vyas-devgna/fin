/* paylens.js — the payment moment.
 *
 * Scan → understand → warn → route → open the app → confirm → learn.
 *
 * The whole point of this app lives in the two seconds *before* the UPI app
 * opens: what you usually pay this person, what budget it eats, whether you
 * already paid them today. Everything else is bookkeeping.
 *
 * Money never passes through here. This builds a upi:// link and hands it to
 * an app you chose. The payment happens there.
 */
import * as St from './store.js';
import { S } from './store.js';
import { el, $, $$, esc, icon, haptic, toast, openSheet, pickSheet, confirmSheet, $$$, $c } from './ui.js';
import { parseAmount, fmt, monthKey, budgetStatus, relativeDay, uid } from './core.js';
import * as Native from './native.js';
import { parseUpiUri, buildUpiUri } from './upi.js';

/* ── Vendor memory ────────────────────────────────────────────────────────────
 * Derived from the ledger, never stored separately, so it cannot disagree with
 * it. Median rather than mean: one ₹4,000 outlier must not move "usually ₹80".
 */
export function vendorMemory(vpa, name = '') {
  const key = (vpa || '').toLowerCase().trim();
  if (!key) return null;
  const hits = S.txns.filter((t) => (t.vpa || '').toLowerCase() === key);
  if (!hits.length) return { key, name: name || key, isNew: true, count: 0 };

  const amounts = hits.map((t) => t.amount).sort((a, b) => a - b);
  const cats = new Map();
  for (const t of hits) if (t.category) cats.set(t.category, (cats.get(t.category) || 0) + 1);
  const topCat = [...cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const apps = new Map();
  for (const t of hits) if (t.paidVia) apps.set(t.paidVia, (apps.get(t.paidVia) || 0) + 1);
  const topApp = [...apps.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Names seen for this VPA. A change is the classic swapped-QR-sticker signal.
  const names = [...new Set(hits.map((t) => t.payeeName).filter(Boolean))];

  return {
    key,
    name: hits[0].payeeName || name || key,
    isNew: false,
    count: hits.length,
    median: amounts[Math.floor(amounts.length / 2)],
    min: amounts[0],
    max: amounts[amounts.length - 1],
    categoryId: topCat,
    preferredApp: topApp,
    lastPaid: hits[0].date,
    knownNames: names,
    paidToday: hits.filter((t) => relativeDay(t.date) === 'Today'),
  };
}

/* ── Risk checks ──────────────────────────────────────────────────────────────
 * Each returns a warning or null. Ordered by how much they should worry you.
 */
function assess(parsed, amount, mem) {
  const w = [];

  if (mem && !mem.isNew && parsed.payeeName && mem.knownNames.length &&
      !mem.knownNames.some((n) => n.toLowerCase() === parsed.payeeName.toLowerCase())) {
    w.push({ level: 'high', text: `This VPA used to show as "${mem.knownNames[0]}", now "${parsed.payeeName}".` });
  }

  if (mem && mem.paidToday?.length) {
    const same = mem.paidToday.find((t) => t.amount === amount);
    w.push({
      level: same ? 'high' : 'mid',
      text: same
        ? `You already paid ${mem.name} ${$$$(amount)} today.`
        : `You already paid ${mem.name} today (${mem.paidToday.map((t) => $$$(t.amount)).join(', ')}).`,
    });
  }

  if (mem && !mem.isNew && amount > mem.max * 1.8 && mem.count >= 3) {
    w.push({ level: 'mid', text: `Usually ${$$$(mem.min)}–${$$$(mem.max)} here. This is ${$$$(amount)}.` });
  }

  if (mem?.isNew) w.push({ level: 'low', text: 'First time paying this VPA.' });

  // Budget headroom for the category this vendor usually falls into.
  if (mem?.categoryId) {
    const b = S.budgets.find((x) => x.category === mem.categoryId);
    if (b) {
      const st = budgetStatus(b, S.txns, monthKey(Date.now()));
      const after = st.spent + amount;
      if (after > st.limit) {
        w.push({ level: 'high', text: `${St.category(mem.categoryId)?.name} budget: this puts you ${$c(after - st.limit)} over.` });
      } else if (after > st.limit * 0.85) {
        w.push({ level: 'mid', text: `${St.category(mem.categoryId)?.name} budget would be ${Math.round((after / st.limit) * 100)}% used.` });
      }
    }
  }

  const avail = St.snapshot().available;
  if (amount > avail) w.push({ level: 'high', text: `Only ${$$$(avail)} spendable across your accounts.` });

  return w.sort((a, b) => ({ high: 0, mid: 1, low: 2 }[a.level] - { high: 0, mid: 1, low: 2 }[b.level]));
}

/* ── Scanner ──────────────────────────────────────────────────────────────────
 * BarcodeDetector where available (Chrome/Android WebView), with a live
 * viewfinder, torch, and a manual-entry path that is a peer of scanning rather
 * than an error state.
 */
export function openScanner() {
  let stream = null, raf = 0, detector = null, torchOn = false;

  const h = openSheet({
    size: 'tall', title: 'Scan to pay',
    body: `<div class="scan">
      <div class="scan-stage">
        <video class="scan-video" playsinline muted autoplay></video>
        <div class="scan-frame"><i></i><i></i><i></i><i></i></div>
        <p class="scan-hint" data-hint>Point at a UPI QR</p>
        <button class="scan-torch" data-torch hidden>${icon('spark')}</button>
      </div>
      <div class="scan-alt">
        <button class="btn btn-ghost full" data-manual>${icon('user')} Enter a UPI ID instead</button>
        ${recentPayees().length ? `<div class="scan-recent">
          <h4 class="mini-head">Pay again</h4>
          ${recentPayees().slice(0, 5).map((p) => `<button class="row row-tap" data-again="${esc(p.key)}">
            <span class="row-face tone-move">${esc((p.name || '?')[0].toUpperCase())}</span>
            <span class="row-main"><b>${esc(p.name)}</b><small>${p.count}× · usually ${esc($c(p.median))}</small></span>
            ${icon('chevron')}
          </button>`).join('')}
        </div>` : ''}
      </div>
    </div>`,
    onClose() { stop(); },
    onMount(sheet) {
      const video = sheet.querySelector('.scan-video');
      const hint = sheet.querySelector('[data-hint]');
      const torchBtn = sheet.querySelector('[data-torch]');

      sheet.querySelector('[data-manual]').addEventListener('click', () => { haptic('tap'); h.close(); openManualEntry(); });
      sheet.querySelectorAll('[data-again]').forEach((b) => b.addEventListener('click', () => {
        const p = recentPayees().find((x) => x.key === b.dataset.again);
        if (!p) return;
        haptic('tap'); h.close();
        openPrePayment({ valid: true, payeeVpa: p.key, payeeName: p.name, amountPaise: 0, note: '' });
      }));

      if (!('BarcodeDetector' in window)) {
        hint.textContent = 'This device cannot scan. Use a UPI ID.';
        return;
      }
      detector = new window.BarcodeDetector({ formats: ['qr_code'] });

      navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      }).then((s) => {
        stream = s;
        video.srcObject = s;
        const track = s.getVideoTracks()[0];
        if (track.getCapabilities?.().torch) {
          torchBtn.hidden = false;
          torchBtn.addEventListener('click', () => {
            torchOn = !torchOn;
            track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {});
            torchBtn.classList.toggle('on', torchOn);
          });
        }
        tick();
      }).catch(() => { hint.textContent = 'Camera unavailable. Use a UPI ID.'; });

      async function tick() {
        if (!stream) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length) {
            const raw = codes[0].rawValue || '';
            const parsed = parseUpiUri(raw);
            if (parsed.valid) {
              haptic('success'); Native.haptic(30);
              stop(); h.close();
              openPrePayment(parsed, raw);
              return;
            }
            // A QR that is not UPI is worth saying out loud — fake payment
            // stickers that open a web page are a known scam shape.
            hint.textContent = /^https?:/i.test(raw) ? 'That QR opens a web page, not a UPI payment.' : 'Not a UPI QR.';
          }
        } catch { /* frames fail during focus; keep going */ }
        raf = requestAnimationFrame(tick);
      }
    },
  });

  function stop() {
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  return h;
}

/** VPAs you have paid before, most-used first. */
function recentPayees() {
  const seen = new Map();
  for (const t of S.txns) {
    const k = (t.vpa || '').toLowerCase();
    if (!k) continue;
    if (!seen.has(k)) seen.set(k, vendorMemory(k));
  }
  return [...seen.values()].filter(Boolean).sort((a, b) => b.count - a.count);
}

/* ── Manual VPA entry ─────────────────────────────────────────────────────── */

export function openManualEntry() {
  const h = openSheet({
    title: 'Pay a UPI ID', size: 'auto',
    body: `<div class="editor">
      <label class="field field-input"><span class="field-label">UPI ID</span>
        <input class="field-text" data-vpa placeholder="name@bank" autocapitalize="none" autocorrect="off" spellcheck="false" autofocus enterkeyhint="next"></label>
      <label class="field field-input"><span class="field-label">Amount</span>
        <input class="field-text num" data-amt inputmode="decimal" placeholder="0" enterkeyhint="done"></label>
      <p class="hint">Leave the amount blank to fill it in the payment app.</p>
    </div>`,
    actions: `<button class="btn btn-primary full" data-next>Continue</button>`,
    onMount(sheet) {
      sheet.querySelector('[data-next]').addEventListener('click', () => {
        const vpa = sheet.querySelector('[data-vpa]').value.trim();
        if (!vpa.includes('@')) { haptic('warn'); toast('That does not look like a UPI ID.'); return; }
        const amount = parseAmount(sheet.querySelector('[data-amt]').value || '0');
        h.close();
        openPrePayment({ valid: true, payeeVpa: vpa, payeeName: vpa.split('@')[0], amountPaise: amount, note: '' });
      });
    },
  });
}

/* ── Pre-payment decision card ────────────────────────────────────────────────
 * The differentiator. Everything you need to decide, before the money app opens.
 */
export function openPrePayment(parsed, rawQr = '') {
  const mem = vendorMemory(parsed.payeeVpa, parsed.payeeName);
  // A static QR carries no amount; suggest what you usually pay here.
  let amount = parsed.amountPaise || 0;
  const amountLocked = parsed.amountPaise > 0;
  if (!amount && mem && !mem.isNew) amount = mem.median;

  let categoryId = mem?.categoryId || null;
  let route = St.resolveUpiApp({ vpa: parsed.payeeVpa, categoryId, amount });
  if (!route.pkg && mem?.preferredApp) route = { pkg: mem.preferredApp, why: 'what you used here before' };

  const h = openSheet({
    size: 'tall',
    body: `<div class="prepay">
      <div class="pp-payee">
        <span class="pp-avatar">${esc((parsed.payeeName || '?')[0].toUpperCase())}</span>
        <div><b>${esc(parsed.payeeName || parsed.payeeVpa)}</b><small>${esc(parsed.payeeVpa)}</small></div>
        ${mem && !mem.isNew ? `<span class="pill pill-known">${mem.count}× before</span>` : '<span class="pill">New</span>'}
      </div>

      <button class="pp-amount ${amountLocked ? 'locked' : ''}" data-amount ${amountLocked ? 'disabled' : ''}>
        <span class="cur">${esc(S.meta.currency || '₹')}</span><span data-amtval>${esc(fmt(amount, { decimals: 'auto' }))}</span>
        ${amountLocked ? '<i class="pp-lock">fixed by the QR</i>' : '<i class="pp-lock">tap to change</i>'}
      </button>

      <div class="pp-warnings" data-warn></div>

      <div class="pp-rows">
        <button class="field" data-cat><span class="field-label">Category</span>
          <span class="field-value" data-catval></span>${icon('chevron', 'field-chev')}</button>
        <button class="field" data-app><span class="field-label">Pay with</span>
          <span class="field-value" data-appval></span>${icon('chevron', 'field-chev')}</button>
        <label class="field field-input"><span class="field-label">Note</span>
          <input class="field-text" data-note placeholder="Optional" value="${esc(parsed.note || '')}"></label>
      </div>
    </div>`,
    actions: `<button class="btn btn-ghost" data-logonly>Log only</button>
              <button class="btn btn-primary" data-pay>Pay</button>`,
    onMount(sheet) {
      const amtVal = sheet.querySelector('[data-amtval]');
      const warnBox = sheet.querySelector('[data-warn]');
      const catVal = sheet.querySelector('[data-catval]');
      const appVal = sheet.querySelector('[data-appval]');
      const payBtn = sheet.querySelector('[data-pay]');

      function paint() {
        amtVal.textContent = fmt(amount, { decimals: 'auto' });
        const c = St.category(categoryId);
        catVal.innerHTML = c ? `<span class="mini-acc"><i>${esc(c.emoji)}</i>${esc(c.name)}</span>` : '<span class="muted">None</span>';
        const label = route.pkg ? Native.labelFor(route.pkg) : 'Ask every time';
        appVal.innerHTML = `<span>${esc(label)}</span><small>${esc(route.why)}</small>`;

        const warnings = amount > 0 ? assess(parsed, amount, mem) : [];
        warnBox.innerHTML = warnings.map((w) => `<div class="pp-warn ${w.level}">${icon(w.level === 'high' ? 'alert' : 'trend')}<span>${esc(w.text)}</span></div>`).join('');
        payBtn.disabled = amount <= 0;
      }
      paint();

      sheet.querySelector('[data-amount]').addEventListener('click', () => {
        if (amountLocked) return;
        openAmountPad(amount, (v) => { amount = v; route = St.resolveUpiApp({ vpa: parsed.payeeVpa, categoryId, amount }); paint(); });
      });

      sheet.querySelector('[data-cat]').addEventListener('click', () => {
        pickSheet({
          title: 'Category',
          items: [{ id: '', label: 'None', emoji: '⚪️', selected: !categoryId },
            ...St.rankedCategories('spend').map((c) => ({ id: c.id, label: c.name, emoji: c.emoji, selected: categoryId === c.id }))],
          onPick(id) { categoryId = id || null; route = St.resolveUpiApp({ vpa: parsed.payeeVpa, categoryId, amount }); paint(); },
        });
      });

      sheet.querySelector('[data-app]').addEventListener('click', () => {
        const apps = Native.upiApps();
        if (!apps.length) { toast('No UPI apps found on this device.'); return; }
        pickSheet({
          title: 'Pay with',
          subtitle: 'Long-press a choice to make it the rule for this payee',
          items: apps.map((a) => ({
            id: a.package, label: Native.labelFor(a.package),
            sub: a.package === S.meta.defaultUpiApp ? 'your default' : '',
            selected: route.pkg === a.package,
          })),
          onPick(pkg) { route = { pkg, why: 'chosen for this payment' }; paint(); },
        });
      });

      sheet.querySelector('[data-logonly]').addEventListener('click', async () => {
        if (amount <= 0) { haptic('warn'); return; }
        await record({ parsed, amount, categoryId, note: sheet.querySelector('[data-note]').value, via: null, status: 'logged', rawQr });
        h.close(); toast('Logged.', { tone: 'good' });
      });

      payBtn.addEventListener('click', async () => {
        if (amount <= 0) return;
        const note = sheet.querySelector('[data-note]').value;
        const uri = buildUpiUri({
          payeeVpa: parsed.payeeVpa, payeeName: parsed.payeeName,
          amountPaise: amount, note: note || parsed.note || '',
        });
        // Stash the session so onResume can ask whether it went through.
        const session = { id: uid(), vpa: parsed.payeeVpa, payeeName: parsed.payeeName, amount, categoryId, note, via: route.pkg, at: Date.now(), rawQr };
        await St.setMeta('pendingPayment', session);
        haptic('success');
        const ok = Native.pay(uri, route.pkg, session);
        h.close();
        if (!ok) toast('Could not open a payment app.');
      });
    },
  });
  return h;
}

/* ── Amount pad ───────────────────────────────────────────────────────────── */

export function openAmountPad(initial, onDone) {
  let raw = initial ? String(initial / 100) : '';
  const h = openSheet({
    size: 'auto',
    body: `<div class="comp">
      <div class="comp-amount" data-box><span class="cur">${esc(S.meta.currency || '₹')}</span><span class="val" data-val>0</span></div>
      <div class="comp-quick" data-quick></div>
      <div class="pad">
        ${['1','2','3','4','5','6','7','8','9','.','0','00'].map((k) => `<button class="key" data-k="${k}">${k}</button>`).join('')}
        <button class="key key-back" data-k="del">${icon('back')}</button>
        <button class="key key-save" data-ok><span>Done</span></button>
      </div>
    </div>`,
    onMount(sheet) {
      const val = sheet.querySelector('[data-val]');
      const box = sheet.querySelector('[data-box]');
      const quick = sheet.querySelector('[data-quick]');
      const paint = () => {
        const p = parseAmount(raw || '0');
        const s = raw === '' ? '0' : fmt(p, { decimals: raw.includes('.') ? 'always' : 'auto' }) + (raw.endsWith('.') ? '.' : '');
        val.textContent = s;
        box.style.setProperty('--size', s.length > 12 ? '36px' : s.length > 9 ? '46px' : '58px');
        box.classList.toggle('zero', p === 0);
        quick.innerHTML = [1000, 5000, 10000, 50000].map((c) => `<button class="chip chip-add" data-add="${c}">+${esc($c(c).replace(S.meta.currency || '₹', ''))}</button>`).join('');
        quick.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
          haptic('tap'); raw = String((parseAmount(raw || '0') + Number(b.dataset.add)) / 100); paint();
        }));
      };
      paint();
      sheet.querySelectorAll('.key[data-k]').forEach((k) => k.addEventListener('click', () => {
        const v = k.dataset.k; haptic('light');
        if (v === 'del') raw = raw.slice(0, -1);
        else if (v === '.') { if (!raw.includes('.')) raw = (raw || '0') + '.'; }
        else if (v === '00') { if (raw && !/\.\d\d$/.test(raw)) raw += '00'; }
        else { if (/\.\d\d$/.test(raw)) return; raw = raw === '0' ? v : raw + v; }
        paint();
      }));
      sheet.querySelector('[data-ok]').addEventListener('click', () => { h.close(); onDone(parseAmount(raw || '0')); });
    },
  });
}

/* ── Post-payment confirmation ────────────────────────────────────────────────
 * An app opening is not evidence a payment happened. Nothing is written to the
 * ledger until this is answered.
 */
export function openPostPayment(session) {
  if (!session) return;
  const h = openSheet({
    size: 'auto', dismissable: false,
    body: `<div class="postpay">
      <span class="pp-avatar big">${esc((session.payeeName || '?')[0].toUpperCase())}</span>
      <h3>${esc($$$(session.amount))}</h3>
      <p>to ${esc(session.payeeName || session.vpa)}${session.via ? ` via ${esc(Native.labelFor(session.via))}` : ''}</p>
      <p class="hint">Did it go through?</p>
    </div>`,
    actions: `<button class="btn btn-ghost" data-no>No</button>
              <button class="btn btn-primary" data-yes>Paid</button>`,
    onMount(sheet) {
      sheet.querySelector('[data-yes]').addEventListener('click', async () => {
        haptic('success');
        await record({
          parsed: { payeeVpa: session.vpa, payeeName: session.payeeName },
          amount: session.amount, categoryId: session.categoryId,
          note: session.note, via: session.via, status: 'paid', rawQr: session.rawQr,
        });
        await St.setMeta('pendingPayment', null);
        h.close();
        toast(`Paid ${$$$(session.amount)}`, { tone: 'good' });
      });
      sheet.querySelector('[data-no]').addEventListener('click', async () => {
        await St.setMeta('pendingPayment', null);
        h.close();
        toast('Nothing recorded.');
      });
    },
  });
}

/* ── Writing it down ──────────────────────────────────────────────────────── */

async function record({ parsed, amount, categoryId, note, via, status, rawQr }) {
  const acc = St.spendAccounts()[0] || St.liveAccounts()[0];
  if (!acc) { toast('Create an account first.'); return null; }
  const t = await St.addTxn({
    type: 'spend', amount, account: acc.id, category: categoryId || undefined,
    note: (note || '').trim() || parsed.payeeName || '',
    vpa: parsed.payeeVpa, payeeName: parsed.payeeName,
    paidVia: via || undefined, status, rawQr: rawQr || undefined,
  });
  // Learn the route: paying this vendor through an app makes it the default here.
  if (via && parsed.payeeVpa) await St.setRoutingRule('vendor', parsed.payeeVpa, via);
  return t;
}
