/* sheets.js — every editor and composer in the app.
 *
 * All user-supplied text passes through esc() before it reaches innerHTML.
 * That matters because restoring a backup file is a real trust boundary: a
 * .json someone else hands you could otherwise carry script in a note field
 * and run inside your own ledger.
 */
import * as St from './store.js';
import { S } from './store.js';
import {
  el, $, $$, esc, icon, haptic, toast, openSheet, pickSheet, confirmSheet,
  $$$, $c, stagger,
} from './ui.js';
import {
  TYPES, fmt, parseAmount, effects, debtOutstanding, debtsByPerson, goalProgress,
  monthKey, monthLabel, relativeDay, uid,
} from './core.js';

const todayISO = (ts = Date.now()) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fromISO = (s, keepTime = Date.now()) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(keepTime);
  return new Date(y, m - 1, d, t.getHours(), t.getMinutes()).getTime();
};

/* ── The action picker: the eight things money can do ─────────────────────── */

const ACTION_ORDER = ['spend', 'receive', 'receivable', 'transfer', 'save', 'lend', 'borrow', 'repay', 'withdraw'];

export function openActions() {
  const outstanding = St.S.debts.filter((d) => debtOutstanding(d, S.txns) > 0).length;
  const body = `<div class="actions-grid">${ACTION_ORDER.map((k, i) => {
    const t = TYPES[k];
    const dim = k === 'repay' && !outstanding;
    return `<button class="action ${dim ? 'dim' : ''}" data-t="${k}" style="--d:${i * 34}ms">
      <span class="action-ico tone-${t.tone}">${icon(iconFor(k))}</span>
      <b>${t.label}</b>
      <small>${dim ? 'Nothing outstanding' : esc(t.hint)}</small>
    </button>`;
  }).join('')}</div>`;

  const h = openSheet({
    title: 'What happened?', size: 'auto', body,
    onMount(sheet) {
      sheet.querySelectorAll('.action').forEach((b) =>
        b.addEventListener('click', () => {
          const t = b.dataset.t;
          if (t === 'repay' && !outstanding) { haptic('warn'); toast('No open debts to settle.'); return; }
          haptic('tap'); h.close(); openComposer({ type: t });
        }));
    },
  });
  return h;
}

const iconFor = (t) => ({ receive: 'in', spend: 'out', transfer: 'move', save: 'shield', withdraw: 'shieldOff', borrow: 'handIn', lend: 'handOut', repay: 'check', receivable: 'note' }[t] || 'plus');

/* ── The composer ─────────────────────────────────────────────────────────────
 * One sheet handles all eight actions. The fields shown are derived from the
 * verb, so there is never an irrelevant input on screen.
 */
export function openComposer({ type, prefill = {}, editing = null }) {
  const meta = TYPES[type];
  const last = St.lastUsed(type);
  const spend = St.spendAccounts(), savings = St.savingsAccounts(), live = St.liveAccounts();

  if (!live.length) { toast('Create an account first.'); return; }
  if ((type === 'save' || type === 'withdraw') && !savings.length) {
    toast('Add a savings account first.', { action: 'Add', onAction: () => openAccountEditor({ kind: 'savings' }) });
    return;
  }

  // Sensible defaults so the common case is: type the amount, hit save.
  const openDebts = S.debts.map((d) => ({ ...d, outstanding: debtOutstanding(d, S.txns) })).filter((d) => d.outstanding > 0);
  const st = {
    raw: editing ? String(editing.amount / 100) : '',
    account: prefill.account || editing?.account || last.account || (type === 'withdraw' ? savings[0]?.id : spend[0]?.id) || live[0].id,
    to: prefill.to || editing?.to || last.to || (type === 'save' ? savings[0]?.id : type === 'withdraw' ? spend[0]?.id : live.find((a) => a.id !== (last.account || live[0].id))?.id),
    category: prefill.category || editing?.category || last.category || null,
    goalId: prefill.goalId || editing?.goalId || null,
    debtId: prefill.debtId || editing?.debtId || openDebts[0]?.id || null,
    person: prefill.person || editing?.person || '',
    note: editing?.note || prefill.note || '',
    date: editing?.date || prefill.date || Date.now(),
    dueDate: prefill.dueDate || null,
    repeat: null,
  };
  if (type === 'save' && st.account === st.to) st.account = spend[0]?.id || live[0].id;

  const amount = () => parseAmount(st.raw || '0');

  const h = openSheet({
    size: 'tall composer',
    dismissable: true,
    body: `
      <div class="comp">
        <div class="comp-top">
          <span class="comp-verb tone-${meta.tone}">${icon(iconFor(type))}<b>${esc(editing ? 'Edit ' + meta.label.toLowerCase() : meta.label)}</b></span>
          <button class="comp-switch" data-switch>${esc(editing ? '' : 'Change')}${editing ? '' : icon('down')}</button>
        </div>
        <div class="comp-amount" data-amount><span class="cur">${esc(S.meta.currency || '₹')}</span><span class="val" data-val>0</span></div>
        <div class="comp-quick" data-quick></div>
        <div class="comp-fields" data-fields></div>
        <div class="pad">
          ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '00'].map((k) => `<button class="key" data-k="${k}">${k}</button>`).join('')}
          <button class="key key-back" data-k="del" aria-label="Delete">${icon('back')}</button>
          <button class="key key-save" data-save><span>${esc(editing ? 'Save changes' : meta.label)}</span></button>
        </div>
      </div>`,
    onMount(sheet, handle) {
      const valNode = sheet.querySelector('[data-val]');
      const amountBox = sheet.querySelector('[data-amount]');
      const fields = sheet.querySelector('[data-fields]');
      const quick = sheet.querySelector('[data-quick]');
      const saveBtn = sheet.querySelector('[data-save]');

      /* ── Amount display ── */
      function paintAmount() {
        const p = amount();
        const shown = st.raw === '' ? '0'
          : fmt(p, { decimals: st.raw.includes('.') ? 'always' : 'auto' })
            // keep a trailing "." visible while it is being typed
            + (st.raw.endsWith('.') ? '.' : '');
        valNode.textContent = shown;
        // Shrink the type as the number grows so a crore still fits on one line.
        const len = shown.length;
        amountBox.style.setProperty('--size', len > 15 ? '30px' : len > 12 ? '36px' : len > 9 ? '44px' : len > 6 ? '52px' : '62px');
        amountBox.classList.toggle('zero', p === 0);
        saveBtn.disabled = p <= 0 || (needsPerson() && !st.person.trim()) || (type === 'repay' && !st.debtId);
        paintQuick();
      }

      /* ── Quick amount chips: they adapt to the size of what you're typing ── */
      function paintQuick() {
        const p = amount();
        const base = p >= 5000000 ? [1000000, 5000000, 10000000] : p >= 100000 ? [50000, 100000, 500000] : p >= 10000 ? [10000, 50000, 100000] : [10000, 50000, 100000];
        const chips = p === 0
          ? [10000, 50000, 100000, 500000]
          : base;
        quick.innerHTML = chips.map((c) => `<button class="chip chip-add" data-add="${c}">+${esc($c(c).replace(S.meta.currency || '₹', ''))}</button>`).join('')
          + (p > 0 ? `<button class="chip chip-clear" data-clear>${icon('x')}</button>` : '');
        quick.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
          haptic('tap');
          st.raw = String((amount() + Number(b.dataset.add)) / 100);
          paintAmount();
        }));
        quick.querySelector('[data-clear]')?.addEventListener('click', () => { haptic('light'); st.raw = ''; paintAmount(); });
      }

      const needsPerson = () => type === 'lend' || type === 'borrow' || type === 'receivable';

      /* ── Contextual fields ── */
      function row(key, label, value, sub) {
        return `<button class="field" data-f="${key}">
          <span class="field-label">${esc(label)}</span>
          <span class="field-value">${value}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
          ${icon('chevron', 'field-chev')}
        </button>`;
      }
      const accChip = (id) => {
        const a = St.account(id);
        return a ? `<span class="mini-acc"><i>${esc(a.icon || '•')}</i>${esc(a.name)}</span>` : '<span class="muted">Choose</span>';
      };

      function paintFields() {
        let html = '';
        if (type === 'spend' || type === 'receive') {
          html += row('account', type === 'spend' ? 'From' : 'Into', accChip(st.account));
          const c = St.category(st.category);
          html += row('category', 'Category', c ? `<span class="mini-acc"><i>${esc(c.emoji)}</i>${esc(c.name)}</span>` : '<span class="muted">Optional</span>');
        } else if (type === 'transfer' || type === 'save' || type === 'withdraw') {
          html += row('account', 'From', accChip(st.account));
          html += row('to', 'To', accChip(st.to));
          if (type === 'save' || type === 'withdraw') {
            const g = St.goal(st.goalId);
            html += row('goal', 'For goal', g ? `<span class="mini-acc"><i>${esc(g.emoji || '🎯')}</i>${esc(g.name)}</span>` : '<span class="muted">Optional</span>');
          }
        } else if (needsPerson()) {
          html += `<label class="field field-input">
            <span class="field-label">${type === 'lend' ? 'To whom' : type === 'receivable' ? 'Client / Payee' : 'From whom'}</span>
            <input class="field-text" data-person list="people" placeholder="${type === 'receivable' ? 'Client Name' : 'Name'}" value="${esc(st.person)}" autocomplete="off" enterkeyhint="done">
          </label>`;
          if (type !== 'receivable') {
            html += row('account', type === 'lend' ? 'From' : 'Into', accChip(st.account));
          }
          html += row('dueDate', type === 'receivable' ? 'Expected by' : 'Due back', st.dueDate ? esc(relativeDay(st.dueDate)) : '<span class="muted">Optional</span>');
        } else if (type === 'repay') {
          const d = St.debt(st.debtId);
          const isLentOrRec = d?.direction === 'lent' || d?.direction === 'receivable';
          html += row('debt', 'Settle', d
            ? `<span class="mini-acc"><i>${isLentOrRec ? '↙' : '↗'}</i>${esc(d.person)}</span>`
            : '<span class="muted">Choose</span>',
            d ? `${d.direction === 'lent' ? 'owes you' : d.direction === 'receivable' ? 'pending payment' : 'you owe'} ${$$$(debtOutstanding(d, S.txns))}` : '');
          html += row('account', isLentOrRec ? 'Into' : 'From', accChip(st.account));
        }
        html += row('date', 'When', esc(relativeDay(st.date)));
        html += `<label class="field field-input">
          <span class="field-label">Note</span>
          <input class="field-text" data-note placeholder="Optional" value="${esc(st.note)}" enterkeyhint="done">
        </label>`;
        if (!editing && (type === 'spend' || type === 'receive' || type === 'transfer' || type === 'save')) {
          html += `<button class="field field-repeat ${st.repeat ? 'on' : ''}" data-f="repeat">
            <span class="field-label">${icon('repeat')} Repeat</span>
            <span class="field-value">${st.repeat ? esc(repeatLabel(st.repeat)) : '<span class="muted">Never</span>'}</span>
          </button>`;
        }
        fields.innerHTML = html;
        bindFields();
      }

      function bindFields() {
        fields.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => onField(b.dataset.f)));
        const pn = fields.querySelector('[data-person]');
        pn?.addEventListener('input', () => { st.person = pn.value; paintAmount(); });
        const nt = fields.querySelector('[data-note]');
        nt?.addEventListener('input', () => { st.note = nt.value; });
      }

      function onField(f) {
        haptic('select');
        if (f === 'account' || f === 'to') {
          const pool = f === 'account' && type === 'withdraw' ? savings
            : f === 'to' && type === 'save' ? savings
              : f === 'to' && type === 'withdraw' ? spend
                : live;
          pickSheet({
            title: f === 'account' ? 'From which account' : 'Into which account',
            items: pool.map((a) => ({ id: a.id, label: a.name, emoji: a.icon, sub: $$$(balanceOf(a.id)), selected: st[f] === a.id })),
            onPick(id) {
              st[f] = id;
              // Never let a transfer point at itself.
              if (st.account === st.to && ['transfer', 'save', 'withdraw'].includes(type)) {
                const other = pool.find((a) => a.id !== id) || live.find((a) => a.id !== id);
                if (f === 'account') st.to = other?.id; else st.account = other?.id;
              }
              paintFields();
            },
            footer: 'New account', onFooter: () => openAccountEditor({}),
          });
        } else if (f === 'category') {
          const kind = type === 'receive' ? 'receive' : 'spend';
          pickSheet({
            title: 'Category',
            items: [{ id: '', label: 'No category', emoji: '⚪️', selected: !st.category },
            ...St.rankedCategories(kind).map((c) => ({ id: c.id, label: c.name, emoji: c.emoji, selected: st.category === c.id }))],
            onPick(id) { st.category = id || null; paintFields(); },
            footer: 'New category', onFooter: () => openCategoryEditor({ kind }, () => paintFields()),
          });
        } else if (f === 'goal') {
          const gs = S.goals.filter((g) => !g.archivedAt);
          if (!gs.length) { toast('No goals yet.', { action: 'Create', onAction: () => openGoalEditor({}) }); return; }
          pickSheet({
            title: 'Which goal', items: [{ id: '', label: 'Not for a goal', emoji: '⚪️', selected: !st.goalId },
            ...gs.map((g) => ({ id: g.id, label: g.name, emoji: g.emoji || '🎯', sub: `${$$$(goalProgress(g, S.txns).saved)} of ${$$$(g.target)}`, selected: st.goalId === g.id }))],
            onPick(id) {
              st.goalId = id || null;
              // Saving toward a goal should land in the account that goal lives in.
              const g = St.goal(id);
              if (g?.accountId && type === 'save') st.to = g.accountId;
              if (g?.accountId && type === 'withdraw') st.account = g.accountId;
              paintFields();
            },
          });
        } else if (f === 'debt') {
          pickSheet({
            title: 'Which debt',
            items: openDebts.map((d) => ({
              id: d.id, label: d.person, emoji: (d.direction === 'lent' || d.direction === 'receivable') ? '↙️' : '↗️',
              sub: `${d.direction === 'lent' ? 'owes you' : d.direction === 'receivable' ? 'pending payment' : 'you owe'} ${$$$(d.outstanding)}`, selected: st.debtId === d.id,
            })),
            onPick(id) {
              st.debtId = id;
              const d = St.debt(id);
              // Pre-fill the full remaining amount — settling in full is the common case.
              if (d && !st.raw) { st.raw = String(debtOutstanding(d, S.txns) / 100); paintAmount(); }
              paintFields();
            },
          });
        } else if (f === 'date' || f === 'dueDate') {
          openDatePicker({
            value: f === 'date' ? st.date : st.dueDate || Date.now(),
            title: f === 'date' ? 'When did this happen?' : 'When is it due back?',
            allowClear: f === 'dueDate',
            onPick(ts) { st[f] = ts; paintFields(); },
          });
        } else if (f === 'repeat') {
          openRepeatPicker(st.repeat, (r) => { st.repeat = r; paintFields(); });
        }
      }

      // Balance excluding the transaction being edited, so the picker shows what
      // the account holds without this entry. Goes through effects() rather than
      // re-deriving the signs — duplicated money logic is how ledgers drift.
      const balanceOf = (id) => {
        const a = St.account(id);
        if (!a) return 0;
        let b = a.opening || 0;
        for (const t of S.txns) {
          if (editing && t.id === editing.id) continue;
          for (const e of effects(t)) if (e.account === id) b += e.delta;
        }
        return b;
      };

      /* ── Keypad ── */
      sheet.querySelectorAll('.key[data-k]').forEach((k) => k.addEventListener('click', () => {
        const v = k.dataset.k;
        haptic('light');
        if (v === 'del') st.raw = st.raw.slice(0, -1);
        else if (v === '.') { if (!st.raw.includes('.')) st.raw = (st.raw || '0') + '.'; }
        else if (v === '00') { if (st.raw && !/\.\d\d$/.test(st.raw)) st.raw += '00'; }
        else {
          // Two decimal places is the whole of the paise, so stop there.
          if (/\.\d\d$/.test(st.raw)) return;
          st.raw = st.raw === '0' ? v : st.raw + v;
        }
        paintAmount();
      }));

      // Hardware keyboard, for anyone using this on a laptop.
      sheet.addEventListener('keydown', (e) => {
        if (e.target.matches('input')) return;
        if (/^[0-9]$/.test(e.key)) { st.raw += e.key; paintAmount(); }
        else if (e.key === '.') { if (!st.raw.includes('.')) st.raw += '.'; paintAmount(); }
        else if (e.key === 'Backspace') { st.raw = st.raw.slice(0, -1); paintAmount(); }
        else if (e.key === 'Enter') saveBtn.click();
        else return;
        e.preventDefault();
      });

      sheet.querySelector('[data-switch]')?.addEventListener('click', () => {
        if (editing) return;
        haptic('tap'); handle.close(); openActions();
      });

      /* ── Commit ── */
      saveBtn.addEventListener('click', async () => {
        const amt = amount();
        if (amt <= 0) return;
        haptic('success');

        if (editing) {
          await St.updateTxn(editing.id, {
            amount: amt, account: st.account, to: st.to, category: st.category,
            goalId: st.goalId, note: st.note.trim(), date: st.date,
          });
          handle.close();
          toast('Updated.');
          return;
        }

        if (type === 'lend' || type === 'borrow' || type === 'receivable') {
          await St.addDebt({
            person: st.person, direction: type === 'lend' ? 'lent' : type === 'receivable' ? 'receivable' : 'borrowed',
            amount: amt, account: st.account, note: st.note.trim(), dueDate: st.dueDate, date: st.date,
          });
        } else if (type === 'repay') {
          await St.repay({ debtId: st.debtId, amount: amt, account: st.account, note: st.note.trim(), date: st.date });
          const d = St.debt(st.debtId);
          if (d && debtOutstanding(d, S.txns) === 0) setTimeout(() => toast(`Settled up with ${d.person}.`, { tone: 'good' }), 260);
        } else {
          await St.addTxn({
            type, amount: amt, account: st.account,
            to: ['transfer', 'save', 'withdraw'].includes(type) ? st.to : undefined,
            category: ['spend', 'receive'].includes(type) ? st.category : undefined,
            goalId: st.goalId || undefined, note: st.note.trim(), date: st.date,
          });
        }

        if (st.repeat) {
          await St.addRecurring({
            ...st.repeat,
            nextAt: nextFrom(st.repeat, st.date),
            template: {
              type, amount: amt, account: st.account,
              to: ['transfer', 'save', 'withdraw'].includes(type) ? st.to : undefined,
              category: ['spend', 'receive'].includes(type) ? st.category : undefined,
              goalId: st.goalId || undefined, note: st.note.trim(),
            },
          });
        }

        handle.close();
        celebrate(type, amt);
      });

      paintAmount();
      paintFields();
      if (!$('#people')) {
        // Names you've already used, offered by the browser's own autocomplete.
        document.body.append(el(`<datalist id="people">${[...new Set(S.debts.map((d) => d.person))].map((p) => `<option value="${esc(p)}"></option>`).join('')}</datalist>`));
      }
    },
  });
}

function celebrate(type, amt) {
  const t = TYPES[type];
  toast(`${t.verb} ${$$$(amt)}`, { tone: t.tone === 'out' || t.tone === 'due' ? '' : 'good', ms: 2400 });
}

const repeatLabel = (r) => ({ day: 'Every day', week: 'Every week', month: 'Every month', year: 'Every year' }[r.freq] || 'Custom');
const nextFrom = (rule, from) => {
  const d = new Date(from);
  return ({
    day: () => new Date(d.setDate(d.getDate() + 1)),
    week: () => new Date(d.setDate(d.getDate() + 7)),
    month: () => new Date(d.setMonth(d.getMonth() + 1)),
    year: () => new Date(d.setFullYear(d.getFullYear() + 1)),
  }[rule.freq]?.() ?? d).getTime();
};

function openRepeatPicker(current, onPick) {
  pickSheet({
    title: 'Repeat this',
    subtitle: 'It will be added automatically from now on',
    items: [
      { id: '', label: 'Never', selected: !current },
      { id: 'week', label: 'Every week', emoji: '📅', selected: current?.freq === 'week' },
      { id: 'month', label: 'Every month', emoji: '🗓️', sub: 'Rent, salary, EMI', selected: current?.freq === 'month' },
      { id: 'year', label: 'Every year', emoji: '🎂', sub: 'Insurance, renewals', selected: current?.freq === 'year' },
    ],
    onPick: (id) => onPick(id ? { freq: id, interval: 1, anchorDay: new Date().getDate() } : null),
  });
}

/* ── Date picker: the native control, dressed up ──────────────────────────── */
export function openDatePicker({ value, title = 'Pick a date', onPick, allowClear = false }) {
  const quick = [
    ['Today', 0], ['Yesterday', -1], ['2 days ago', -2], ['A week ago', -7],
  ];
  const h = openSheet({
    title, size: 'auto',
    body: `<div class="datepick">
      <div class="chips">${quick.map(([l, d]) => `<button class="chip" data-off="${d}">${esc(l)}</button>`).join('')}</div>
      <label class="field field-input"><span class="field-label">Exact date</span>
        <input type="date" class="field-text" data-date value="${todayISO(value)}" max="${todayISO(Date.now() + 5 * 365 * 86400000)}"></label>
      ${allowClear ? '<button class="btn btn-ghost full" data-clear>Clear</button>' : ''}
    </div>`,
    onMount(sheet) {
      sheet.querySelectorAll('[data-off]').forEach((b) => b.addEventListener('click', () => {
        haptic('select'); h.close(); onPick(Date.now() + Number(b.dataset.off) * 86400000);
      }));
      sheet.querySelector('[data-date]').addEventListener('change', (e) => {
        if (!e.target.value) return;
        haptic('select'); h.close(); onPick(fromISO(e.target.value, value));
      });
      sheet.querySelector('[data-clear]')?.addEventListener('click', () => { h.close(); onPick(null); });
    },
  });
}

/* ── Account editor ───────────────────────────────────────────────────────── */

const ACCOUNT_ICONS = ['👛', '🏦', '🛡️', '💵', '💳', '🏠', '✈️', '🎓', '💼', '🚗', '💍', '🪙', '📦', '❤️', '🎁', '📈'];

export function openAccountEditor(acc = {}, onDone) {
  const editing = !!acc.id;
  const st = {
    name: acc.name || '', kind: acc.kind || 'spend',
    icon: acc.icon || '👛', color: acc.color || St.COLORS[S.accounts.length % St.COLORS.length],
    opening: acc.opening || 0,
  };
  const h = openSheet({
    title: editing ? 'Edit account' : 'New account',
    subtitle: editing ? null : 'Where some of your money lives',
    body: `<div class="editor">
      <div class="ed-preview"><span class="ed-avatar" data-preview style="--c:${st.color}">${st.icon}</span></div>
      <label class="field field-input"><span class="field-label">Name</span>
        <input class="field-text" data-name placeholder="Emergency Fund" value="${esc(st.name)}" autofocus enterkeyhint="done" maxlength="40"></label>
      <div class="seg" data-kind>
        <button class="${st.kind === 'spend' ? 'on' : ''}" data-v="spend">Spendable</button>
        <button class="${st.kind === 'savings' ? 'on' : ''}" data-v="savings">Set aside</button>
      </div>
      <p class="hint" data-kindhint></p>
      ${editing ? '' : `<label class="field field-input"><span class="field-label">Balance right now</span>
        <input class="field-text num" data-open inputmode="decimal" placeholder="0" enterkeyhint="done"></label>`}
      <div class="swatches" data-icons>${ACCOUNT_ICONS.map((i) => `<button class="swatch-i ${i === st.icon ? 'on' : ''}" data-i="${i}">${i}</button>`).join('')}</div>
      <div class="swatches" data-colors>${St.COLORS.map((c) => `<button class="swatch ${c === st.color ? 'on' : ''}" data-c="${c}" style="--c:${c}"></button>`).join('')}</div>
      ${editing ? `<button class="btn btn-ghost full danger-text" data-remove>${icon('trash')} ${St.accountInUse(acc.id) ? 'Archive account' : 'Delete account'}</button>` : ''}
    </div>`,
    actions: `<button class="btn btn-primary full" data-save>${editing ? 'Save' : 'Create account'}</button>`,
    onMount(sheet) {
      const preview = sheet.querySelector('[data-preview]');
      const hint = sheet.querySelector('[data-kindhint]');
      const paintHint = () => {
        hint.textContent = st.kind === 'spend'
          ? 'Counts towards “Available to spend”.'
          : 'Held back from “Available to spend”, and counted as savings.';
      };
      paintHint();
      sheet.querySelector('[data-name]').addEventListener('input', (e) => { st.name = e.target.value; });
      sheet.querySelectorAll('[data-kind] button').forEach((b) => b.addEventListener('click', () => {
        haptic('select'); st.kind = b.dataset.v;
        sheet.querySelectorAll('[data-kind] button').forEach((x) => x.classList.toggle('on', x === b));
        paintHint();
      }));
      sheet.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
        haptic('select'); st.icon = b.dataset.i; preview.textContent = st.icon;
        sheet.querySelectorAll('[data-i]').forEach((x) => x.classList.toggle('on', x === b));
      }));
      sheet.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => {
        haptic('select'); st.color = b.dataset.c; preview.style.setProperty('--c', st.color);
        sheet.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('on', x === b));
      }));
      sheet.querySelector('[data-remove]')?.addEventListener('click', async () => {
        const inUse = St.accountInUse(acc.id);
        const ok = await confirmSheet({
          title: inUse ? `Archive ${acc.name}?` : `Delete ${acc.name}?`,
          message: inUse
            ? 'Its history stays intact and its balance stops counting towards your totals. You can bring it back later.'
            : 'This account has no transactions, so nothing will be lost.',
          confirm: inUse ? 'Archive' : 'Delete',
        });
        if (!ok) return;
        if (inUse) await St.save('accounts', { ...acc, archived: true });
        else await St.remove('accounts', acc.id);
        h.close(); onDone?.();
        toast(inUse ? 'Archived.' : 'Deleted.');
      });
      sheet.querySelector('[data-save]').addEventListener('click', async () => {
        if (!st.name.trim()) { haptic('warn'); sheet.querySelector('[data-name]').focus(); return; }
        const opening = editing ? acc.opening : parseAmount(sheet.querySelector('[data-open]').value || '0');
        haptic('success');
        const saved = await St.save('accounts', {
          ...(editing ? acc : {}), name: st.name.trim(), kind: st.kind, icon: st.icon,
          color: st.color, opening, order: acc.order ?? S.accounts.length,
        });
        h.close(); onDone?.(saved);
      });
    },
  });
}

/* ── Category editor ──────────────────────────────────────────────────────── */

const CAT_EMOJI = ['🍜', '🚕', '💡', '🛍️', '💊', '🏠', '🎬', '📚', '☕️', '⛽️', '🎧', '🐾', '👕', '🧾', '🎁', '💼', '📈', '🧡', '✈️', '🏋️'];

export function openCategoryEditor(cat = {}, onDone) {
  const editing = !!cat.id;
  const st = { name: cat.name || '', emoji: cat.emoji || '🍜', color: cat.color || St.COLORS[S.categories.length % St.COLORS.length], kind: cat.kind || 'spend' };
  const h = openSheet({
    title: editing ? 'Edit category' : 'New category', size: 'auto',
    body: `<div class="editor">
      <label class="field field-input"><span class="field-label">Name</span>
        <input class="field-text" data-name value="${esc(st.name)}" placeholder="Groceries" autofocus maxlength="24" enterkeyhint="done"></label>
      <div class="seg" data-kind>
        <button class="${st.kind === 'spend' ? 'on' : ''}" data-v="spend">Spending</button>
        <button class="${st.kind === 'receive' ? 'on' : ''}" data-v="receive">Income</button>
      </div>
      <div class="swatches" data-icons>${CAT_EMOJI.map((e) => `<button class="swatch-i ${e === st.emoji ? 'on' : ''}" data-i="${e}">${e}</button>`).join('')}</div>
      <div class="swatches" data-colors>${St.COLORS.map((c) => `<button class="swatch ${c === st.color ? 'on' : ''}" data-c="${c}" style="--c:${c}"></button>`).join('')}</div>
      ${editing ? '<button class="btn btn-ghost full danger-text" data-remove>Delete category</button>' : ''}
    </div>`,
    actions: `<button class="btn btn-primary full" data-save>${editing ? 'Save' : 'Create'}</button>`,
    onMount(sheet) {
      sheet.querySelector('[data-name]').addEventListener('input', (e) => { st.name = e.target.value; });
      sheet.querySelectorAll('[data-kind] button').forEach((b) => b.addEventListener('click', () => {
        haptic('select'); st.kind = b.dataset.v;
        sheet.querySelectorAll('[data-kind] button').forEach((x) => x.classList.toggle('on', x === b));
      }));
      sheet.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
        haptic('select'); st.emoji = b.dataset.i;
        sheet.querySelectorAll('[data-i]').forEach((x) => x.classList.toggle('on', x === b));
      }));
      sheet.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => {
        haptic('select'); st.color = b.dataset.c;
        sheet.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('on', x === b));
      }));
      sheet.querySelector('[data-remove]')?.addEventListener('click', async () => {
        const used = S.txns.filter((t) => t.category === cat.id).length;
        const ok = await confirmSheet({
          title: `Delete ${cat.name}?`,
          message: used ? `${used} transaction${used > 1 ? 's' : ''} will simply become uncategorised. No money is affected.` : null,
          confirm: 'Delete',
        });
        if (!ok) return;
        await St.remove('categories', cat.id);
        h.close(); onDone?.();
      });
      sheet.querySelector('[data-save]').addEventListener('click', async () => {
        if (!st.name.trim()) { haptic('warn'); return; }
        haptic('success');
        await St.save('categories', { ...(editing ? cat : {}), name: st.name.trim(), emoji: st.emoji, color: st.color, kind: st.kind });
        h.close(); onDone?.();
      });
    },
  });
}

/* ── Budget editor ────────────────────────────────────────────────────────── */

export function openBudgetEditor(b = {}, onDone) {
  const editing = !!b.id;
  const st = { category: b.category ?? null, amount: b.amount || 0 };
  const h = openSheet({
    title: editing ? 'Edit budget' : 'New budget',
    subtitle: 'A monthly ceiling, not a plan you have to follow',
    body: `<div class="editor">
      <label class="field field-input"><span class="field-label">Monthly limit</span>
        <input class="field-text num" data-amt inputmode="decimal" placeholder="0" value="${b.amount ? b.amount / 100 : ''}" autofocus enterkeyhint="done"></label>
      <button class="field" data-cat><span class="field-label">Applies to</span>
        <span class="field-value" data-catval></span>${icon('chevron', 'field-chev')}</button>
      <p class="hint">Only spending counts. Transfers and savings never touch a budget.</p>
      ${editing ? '<button class="btn btn-ghost full danger-text" data-remove>Delete budget</button>' : ''}
    </div>`,
    actions: `<button class="btn btn-primary full" data-save>${editing ? 'Save' : 'Create budget'}</button>`,
    onMount(sheet) {
      const catval = sheet.querySelector('[data-catval]');
      const paint = () => {
        const c = St.category(st.category);
        catval.innerHTML = c ? `<span class="mini-acc"><i>${esc(c.emoji)}</i>${esc(c.name)}</span>` : 'Everything I spend';
      };
      paint();
      sheet.querySelector('[data-cat]').addEventListener('click', () => {
        pickSheet({
          title: 'Budget applies to',
          items: [{ id: '', label: 'Everything I spend', emoji: '🌐', selected: !st.category },
          ...St.rankedCategories('spend').map((c) => ({ id: c.id, label: c.name, emoji: c.emoji, selected: st.category === c.id }))],
          onPick(id) { st.category = id || null; paint(); },
        });
      });
      sheet.querySelector('[data-remove]')?.addEventListener('click', async () => {
        if (!await confirmSheet({ title: 'Delete this budget?', message: 'Your spending history is untouched.', confirm: 'Delete' })) return;
        await St.remove('budgets', b.id); h.close(); onDone?.();
      });
      sheet.querySelector('[data-save]').addEventListener('click', async () => {
        const amt = parseAmount(sheet.querySelector('[data-amt]').value);
        if (amt <= 0) { haptic('warn'); return; }
        const clash = S.budgets.find((x) => x.id !== b.id && (x.category ?? null) === st.category);
        if (clash) { haptic('warn'); toast('A budget already covers that.'); return; }
        haptic('success');
        await St.save('budgets', { ...(editing ? b : {}), category: st.category, amount: amt });
        h.close(); onDone?.();
      });
    },
  });
}

/* ── Goal editor ──────────────────────────────────────────────────────────── */

const GOAL_EMOJI = ['🎯', '✈️', '🏠', '🚗', '🎓', '💍', '📱', '💻', '🛡️', '🏝️', '🎸', '👶', '🏥', '🎁', '📈', '🪙'];

export function openGoalEditor(g = {}, onDone) {
  const editing = !!g.id;
  const savings = St.savingsAccounts();
  const st = {
    name: g.name || '', target: g.target || 0, deadline: g.deadline || null,
    emoji: g.emoji || '🎯', color: g.color || St.COLORS[S.goals.length % St.COLORS.length],
    accountId: g.accountId || savings[0]?.id || St.liveAccounts()[0]?.id,
  };
  const h = openSheet({
    title: editing ? 'Edit goal' : 'New goal',
    subtitle: editing ? null : 'Something specific you are putting money towards',
    body: `<div class="editor">
      <div class="ed-preview"><span class="ed-avatar" data-preview style="--c:${st.color}">${st.emoji}</span></div>
      <label class="field field-input"><span class="field-label">What for</span>
        <input class="field-text" data-name value="${esc(st.name)}" placeholder="Japan trip" autofocus maxlength="40" enterkeyhint="done"></label>
      <label class="field field-input"><span class="field-label">Target</span>
        <input class="field-text num" data-target inputmode="decimal" value="${g.target ? g.target / 100 : ''}" placeholder="0" enterkeyhint="done"></label>
      <button class="field" data-acc><span class="field-label">Money kept in</span>
        <span class="field-value" data-accval></span>${icon('chevron', 'field-chev')}</button>
      <button class="field" data-when><span class="field-label">By when</span>
        <span class="field-value" data-whenval></span>${icon('chevron', 'field-chev')}</button>
      <p class="hint" data-pace></p>
      <div class="swatches" data-icons>${GOAL_EMOJI.map((e) => `<button class="swatch-i ${e === st.emoji ? 'on' : ''}" data-i="${e}">${e}</button>`).join('')}</div>
      <div class="swatches" data-colors>${St.COLORS.map((c) => `<button class="swatch ${c === st.color ? 'on' : ''}" data-c="${c}" style="--c:${c}"></button>`).join('')}</div>
      ${editing ? '<button class="btn btn-ghost full danger-text" data-remove>Delete goal</button>' : ''}
    </div>`,
    actions: `<button class="btn btn-primary full" data-save>${editing ? 'Save' : 'Create goal'}</button>`,
    onMount(sheet) {
      const preview = sheet.querySelector('[data-preview]');
      const accval = sheet.querySelector('[data-accval]');
      const whenval = sheet.querySelector('[data-whenval]');
      const pace = sheet.querySelector('[data-pace]');
      const paint = () => {
        const a = St.account(st.accountId);
        accval.innerHTML = a ? `<span class="mini-acc"><i>${esc(a.icon || '•')}</i>${esc(a.name)}</span>` : '<span class="muted">Choose</span>';
        whenval.innerHTML = st.deadline ? esc(relativeDay(st.deadline)) : '<span class="muted">No deadline</span>';
        const target = parseAmount(sheet.querySelector('[data-target]').value);
        if (st.deadline && target > 0) {
          const p = goalProgress({ ...st, target, id: g.id || 'x' }, S.txns);
          pace.textContent = p.perMonth ? `About ${$$$(p.perMonth)} a month to get there.` : 'That deadline has passed.';
        } else pace.textContent = 'A deadline is optional — it just tells you the monthly pace.';
      };
      paint();
      sheet.querySelector('[data-name]').addEventListener('input', (e) => { st.name = e.target.value; });
      sheet.querySelector('[data-target]').addEventListener('input', paint);
      sheet.querySelector('[data-acc]').addEventListener('click', () => {
        pickSheet({
          title: 'Where this money sits',
          subtitle: 'Usually a savings account',
          items: St.liveAccounts().map((a) => ({ id: a.id, label: a.name, emoji: a.icon, sub: a.kind === 'savings' ? 'Set aside' : 'Spendable', selected: st.accountId === a.id })),
          onPick(id) { st.accountId = id; paint(); },
          footer: 'New account', onFooter: () => openAccountEditor({ kind: 'savings' }),
        });
      });
      sheet.querySelector('[data-when]').addEventListener('click', () => {
        openDatePicker({ value: st.deadline || Date.now() + 180 * 86400000, title: 'Target date', allowClear: true, onPick(ts) { st.deadline = ts; paint(); } });
      });
      sheet.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
        haptic('select'); st.emoji = b.dataset.i; preview.textContent = st.emoji;
        sheet.querySelectorAll('[data-i]').forEach((x) => x.classList.toggle('on', x === b));
      }));
      sheet.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => {
        haptic('select'); st.color = b.dataset.c; preview.style.setProperty('--c', st.color);
        sheet.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('on', x === b));
      }));
      sheet.querySelector('[data-remove]')?.addEventListener('click', async () => {
        const saved = goalProgress(g, S.txns).saved;
        if (!await confirmSheet({
          title: `Delete ${g.name}?`,
          message: saved > 0 ? `The ${$$$(saved)} you put aside stays in ${St.account(g.accountId)?.name || 'your account'}. Only the goal disappears.` : null,
          confirm: 'Delete',
        })) return;
        await St.remove('goals', g.id); h.close(); onDone?.();
      });
      sheet.querySelector('[data-save]').addEventListener('click', async () => {
        const target = parseAmount(sheet.querySelector('[data-target]').value);
        if (!st.name.trim() || target <= 0) { haptic('warn'); return; }
        haptic('success');
        await St.save('goals', { ...(editing ? g : {}), name: st.name.trim(), target, deadline: st.deadline, emoji: st.emoji, color: st.color, accountId: st.accountId });
        h.close(); onDone?.();
      });
    },
  });
}

/* ── Transaction detail ───────────────────────────────────────────────────── */

export function openTxnDetail(t, onChange) {
  const meta = TYPES[t.type];
  const acc = St.account(t.account), to = St.account(t.to), cat = St.category(t.category), g = St.goal(t.goalId);
  const rows = [
    ['Amount', $$$(t.amount)],
    [t.type === 'receive' || t.type === 'borrow' || t.type === 'repay' ? 'Into' : t.type === 'receivable' ? 'Expected' : 'From', acc ? `${acc.icon || ''} ${esc(acc.name)}` : '—'],
    to && ['To', `${to.icon || ''} ${esc(to.name)}`],
    cat && ['Category', `${cat.emoji} ${esc(cat.name)}`],
    g && ['Goal', `${g.emoji || '🎯'} ${esc(g.name)}`],
    t.person && ['Person', esc(t.person)],
    ['When', new Date(t.date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })],
    t.note && ['Note', esc(t.note)],
    t.recurringId && ['Repeats', 'Added automatically'],
  ].filter(Boolean);

  const h = openSheet({
    size: 'auto',
    body: `<div class="detail">
      <div class="detail-hero tone-${meta.tone}">
        ${icon(iconFor(t.type), 'detail-ico')}
        <b>${esc(meta.verb)}</b>
        <span class="detail-amt">${esc($$$(t.amount))}</span>
      </div>
      <dl class="detail-rows">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>
      <div class="detail-acts">
        <button class="btn btn-ghost" data-repeat>${icon('repeat')} Do it again</button>
        ${t.type !== 'lend' && t.type !== 'borrow' && t.type !== 'repay' && t.type !== 'receivable' ? `<button class="btn btn-ghost" data-edit>${icon('edit')} Edit</button>` : ''}
        <button class="btn btn-ghost danger-text" data-del>${icon('trash')} Delete</button>
      </div>
    </div>`,
    onMount(sheet) {
      sheet.querySelector('[data-repeat]').addEventListener('click', () => {
        haptic('tap'); h.close();
        openComposer({ type: t.type, prefill: { account: t.account, to: t.to, category: t.category, goalId: t.goalId, person: t.person, note: t.note, debtId: t.debtId } });
      });
      sheet.querySelector('[data-edit]')?.addEventListener('click', () => { haptic('tap'); h.close(); openComposer({ type: t.type, editing: t }); });
      sheet.querySelector('[data-del]').addEventListener('click', async () => {
        h.close();
        await deleteWithUndo(t, onChange);
      });
    },
  });
}

/** Delete with a real undo, rather than a confirmation dialog you learn to
 *  dismiss without reading. */
export async function deleteWithUndo(t, onChange) {
  const isDebt = t.type === 'lend' || t.type === 'borrow' || t.type === 'receivable';
  if (isDebt) {
    const d = St.debt(t.debtId);
    const repaid = d ? (d.principal - debtOutstanding(d, S.txns)) : 0;
    if (repaid > 0 && !await confirmSheet({
      title: `Delete this ${t.type === 'lend' ? 'loan' : t.type === 'receivable' ? 'receivable' : 'borrowing'}?`,
      message: `${$$$(repaid)} of repayments recorded against it will be removed too.`,
      confirm: 'Delete everything',
    })) return;
  }
  const removed = await St.deleteTxn(t.id);
  haptic('warn');
  onChange?.();
  toast('Deleted.', { action: 'Undo', onAction: async () => { await St.restoreTxn(removed); onChange?.(); haptic('success'); } });
}

/* ── Debt detail ──────────────────────────────────────────────────────────── */

export function openDebtDetail(group, onChange) {
  const lent = group.direction === 'lent' || group.direction === 'receivable';
  const isRec = group.direction === 'receivable';
  const items = group.items.filter((i) => i.outstanding > 0 || !i.settledAt);
  const history = S.txns.filter((t) => group.items.some((i) => i.id === t.debtId)).slice(0, 40);

  const h = openSheet({
    title: group.person,
    subtitle: isRec ? 'pending service payment' : lent ? 'owes you' : 'you owe',
    body: `<div class="debtview">
      <div class="debt-hero ${lent ? 'tone-due' : 'tone-owe'}">
        <span class="debt-amt">${esc($$$(group.outstanding))}</span>
        <small>${isRec ? 'pending collection' : lent ? 'still to come back' : 'still to pay back'} · of ${esc($$$(group.principal))}</small>
      </div>
      ${items.map((i) => `<div class="debt-item">
        <div><b>${esc($$$(i.outstanding))}</b><small>${esc(relativeDay(i.date || i.createdAt))}${i.note ? ' · ' + esc(i.note) : ''}</small></div>
        ${i.dueDate ? `<span class="pill ${i.dueDate < Date.now() ? 'pill-late' : ''}">${i.dueDate < Date.now() ? 'Overdue' : 'Due ' + esc(relativeDay(i.dueDate))}</span>` : ''}
      </div>`).join('')}
      ${history.length ? `<h4 class="mini-head">History</h4>
        <div class="debt-hist">${history.map((t) => `<div class="debt-hrow">
          <span>${esc(TYPES[t.type].verb)}</span>
          <b class="${t.type === 'repay' ? 'good' : ''}">${esc($$$(t.amount))}</b>
          <small>${esc(relativeDay(t.date))}</small>
        </div>`).join('')}</div>` : ''}
    </div>`,
    actions: group.outstanding > 0
      ? `<button class="btn btn-ghost" data-part>${isRec ? 'Part collection' : 'Part payment'}</button><button class="btn btn-primary" data-settle>${isRec ? 'Collect' : 'Settle'} ${esc($c(group.outstanding))}</button>`
      : `<button class="btn btn-ghost full" data-close>Done</button>`,
    onMount(sheet) {
      const first = items[0];
      sheet.querySelector('[data-part]')?.addEventListener('click', () => {
        haptic('tap'); h.close(); openComposer({ type: 'repay', prefill: { debtId: first?.id } });
      });
      sheet.querySelector('[data-settle]')?.addEventListener('click', async () => {
        haptic('success');
        const acc = St.spendAccounts()[0] || St.liveAccounts()[0];
        if (!acc) { toast('Create an account first.'); return; }
        for (const i of items) if (i.outstanding > 0) await St.repay({ debtId: i.id, amount: i.outstanding, account: acc.id });
        h.close(); onChange?.();
        toast(`Settled up with ${group.person}.`, { tone: 'good' });
      });
      sheet.querySelector('[data-close]')?.addEventListener('click', () => h.close());
    },
  });
}

/* ── Onboarding ───────────────────────────────────────────────────────────── */

export function openOnboarding(onDone) {
  const accounts = St.liveAccounts();
  openSheet({
    size: 'tall', dismissable: false,
    body: `<div class="onboard">
      <div class="ob-mark">${icon('wave')}</div>
      <h1>How much do you have<br>right now?</h1>
      <p>Just a rough number for each. You can change it any time, and everything else follows from here.</p>
      <div class="ob-list">${accounts.map((a) => `<label class="field field-input">
        <span class="field-label"><i class="ob-emoji">${esc(a.icon)}</i>${esc(a.name)}</span>
        <input class="field-text num" data-acc="${a.id}" inputmode="decimal" placeholder="0" enterkeyhint="next">
      </label>`).join('')}</div>
      <button class="ob-add" data-add>${icon('plus')} Add another account</button>
    </div>`,
    actions: `<button class="btn btn-primary full" data-start>Start</button>`,
    onMount(sheet, handle) {
      sheet.querySelector('[data-add]').addEventListener('click', () => {
        haptic('tap');
        openAccountEditor({}, () => { handle.close(); openOnboarding(onDone); });
      });
      sheet.querySelector('[data-start]').addEventListener('click', async () => {
        haptic('success');
        for (const inp of sheet.querySelectorAll('[data-acc]')) {
          const a = St.account(inp.dataset.acc);
          if (a) await St.save('accounts', { ...a, opening: parseAmount(inp.value || '0') });
        }
        await St.setMeta('onboarded', true);
        handle.close();
        onDone?.();
      });
    },
  });
}
