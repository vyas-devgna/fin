/* ui.js — the shared vocabulary of the interface.
 *
 * Bottom sheets, toasts, haptics, animated numbers, icons. Everything visual
 * that more than one screen needs, so no screen has to reinvent it and drift.
 */
import { S } from './store.js';
import { fmt, fmtCompact } from './core.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Build DOM from a template string. */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Currency, bound to the user's chosen symbol. */
export const $$$ = (paise, opts) => fmt(paise, { symbol: S.meta.currency || '₹', ...opts });
export const $c = (paise) => fmtCompact(paise, S.meta.currency || '₹');

export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── Haptics ──────────────────────────────────────────────────────────────────
 * Android honours this; iOS Safari ignores it silently. Cheap where supported,
 * harmless where not. */
const HAPTIC = { tap: 8, light: 4, select: [3], success: [10, 40, 18], warn: [18, 60, 18], heavy: 24 };
export function haptic(kind = 'tap') {
  if (S.meta.haptics === false) return;
  try { navigator.vibrate?.(HAPTIC[kind] ?? HAPTIC.tap); } catch {}
}

/* ── Icons ────────────────────────────────────────────────────────────────── */
const P = {
  home: 'M3 10.2 12 3l9 7.2M5 9.5V20a1 1 0 0 0 1 1h3.5v-5.5h5V21H18a1 1 0 0 0 1-1V9.5',
  wallet: 'M3 8.5A2.5 2.5 0 0 1 5.5 6H18a2 2 0 0 1 2 2v1M3 8.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2M3 8.5A2.5 2.5 0 0 0 5.5 11H20a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3.5a2.5 2.5 0 0 1 0-5H21',
  list: 'M4 7h16M4 12h16M4 17h10',
  rings: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  flag: 'M5 21V4.5M5 5.2c4-2 8 2 12 0v8.6c-4 2-8-2-12 0',
  plus: 'M12 5v14M5 12h14',
  in: 'M12 5v13m0 0-5.5-5.5M12 18l5.5-5.5',
  out: 'M12 19V6m0 0L6.5 11.5M12 6l5.5 5.5',
  move: 'M7 8h13m0 0-3.5-3.5M20 8l-3.5 3.5M17 16H4m0 0 3.5-3.5M4 16l3.5 3.5',
  shield: 'M12 21s7-3.2 7-9V6.2l-7-3-7 3V12c0 5.8 7 9 7 9Z',
  shieldOff: 'M12 21s7-3.2 7-9V6.2l-7-3-7 3V12c0 5.8 7 9 7 9ZM9 12h6',
  handIn: 'M4 12h9a3 3 0 0 1 0 6H8m12-12-4 4m4-4-4-4m4 4h-7',
  handOut: 'M20 12h-9a3 3 0 0 0 0 6h5M4 6l4 4M4 6l4-4M4 6h7',
  check: 'M4.5 12.5 9.5 17.5 19.5 7',
  chevron: 'M9 5.5 15.5 12 9 18.5',
  back: 'M15 5.5 8.5 12 15 18.5',
  down: 'M6 9.5 12 15.5 18 9.5',
  x: 'M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5',
  gear: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z|M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  edit: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3ZM14.5 7.5l2 2',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
  down2: 'M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14',
  up2: 'M12 16V5m0 0L7.5 9.5M12 5l4.5 4.5M5 19.5h14',
  repeat: 'M4 9V7a2 2 0 0 1 2-2h10m0 0-3-3m3 3-3 3M20 15v2a2 2 0 0 1-2 2H8m0 0 3 3m-3-3 3-3',
  calendar: 'M4 8h16M7 4v3M17 4v3M5 21h14a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1Z',
  note: 'M6 3h9l5 5v13H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM14.5 3v6H20M9 13h6M9 17h4',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  trend: 'M4 16.5 9.5 11l3.5 3.5L20 7M20 7h-4.5M20 7v4.5',
  alert: 'M12 8.5v5M12 17h.01M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  lock: 'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1ZM8 11V7.5a4 4 0 1 1 8 0V11',
  spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20.5a7.5 7.5 0 0 1 15 0',
  grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
  archive: 'M4 8h16M5 8V6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v2M6 8v11a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8M10 12h4',
  pie: 'M12 3v9h9a9 9 0 1 1-9-9Z|M21 12a9 9 0 0 0-9-9v9h9Z',
  wave: 'M3 12c2.5-5 5-5 7.5 0s5 5 7.5 0M3 17c2.5-5 5-5 7.5 0',
  qr: 'M3 3h6v6H3V3Zm2 2v2h2V5H5Zm8-2h6v6h-6V3Zm2 2v2h2V5h-2ZM3 13h6v6H3v-6Zm2 2v2h2v-2H5Zm11 0h2v2h-2v-2Zm-3-2h2v2h-2v-2Zm6 0h2v4h-4v-2h2v-2Zm-2 4h2v2h-2v-2Zm-4 0h2v2h-2v-2Z',
};

export function icon(name, cls = '') {
  const d = P[name];
  if (!d) return '';
  const paths = d.split('|').map((p) => `<path d="${p}"/>`).join('');
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

/* ── Animated numbers ─────────────────────────────────────────────────────────
 * A balance that snaps to a new value reads as a glitch. One that counts,
 * briefly, reads as a consequence of what you just did. */
export function animateNumber(node, to, format = $$$, ms = 620) {
  const from = Number(node.dataset.value || 0);
  node.dataset.value = to;
  if (from === to) { node.textContent = format(to); return; }
  if (reduceMotion() || Math.abs(to - from) < 100) { node.textContent = format(to); return; }
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 4); // easeOutQuart
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    node.textContent = format(Math.round(from + (to - from) * ease(p)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ── Toast ────────────────────────────────────────────────────────────────── */
let toastTimer;
export function toast(message, { action, onAction, tone = '', ms = 4200 } = {}) {
  const host = $('#toasts');
  host.innerHTML = '';
  clearTimeout(toastTimer);
  const node = el(`<div class="toast ${tone}" role="status">
    <span class="toast-msg">${esc(message)}</span>
    ${action ? `<button class="toast-action">${esc(action)}</button>` : ''}
  </div>`);
  host.append(node);
  requestAnimationFrame(() => node.classList.add('in'));
  const dismiss = () => { node.classList.remove('in'); setTimeout(() => node.remove(), 260); };
  node.querySelector('.toast-action')?.addEventListener('click', () => { haptic('tap'); onAction?.(); dismiss(); });
  toastTimer = setTimeout(dismiss, ms);
  return dismiss;
}

/* ── Bottom sheets ────────────────────────────────────────────────────────────
 * The app's only modal surface. Sheets stack, dim what's behind them, and can
 * be flicked away — a sheet you must aim at a close button to dismiss feels
 * heavier than one you can throw.
 */
const stack = [];

export function openSheet({ title, subtitle, body, actions = '', size = '', onMount, onClose, dismissable = true }) {
  const host = $('#sheets');
  const node = el(`<div class="sheet-layer">
    <div class="scrim"></div>
    <section class="sheet ${size}" role="dialog" aria-modal="true" ${title ? `aria-label="${esc(title)}"` : ''}>
      <div class="grabber"><i></i></div>
      ${title ? `<header class="sheet-head">
          <div class="sheet-titles"><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
          ${dismissable ? `<button class="icon-btn sheet-x" aria-label="Close">${icon('x')}</button>` : ''}
        </header>` : ''}
      <div class="sheet-body">${body}</div>
      ${actions ? `<footer class="sheet-actions">${actions}</footer>` : ''}
    </section>
  </div>`);
  host.append(node);
  document.body.classList.add('locked');

  const sheet = node.querySelector('.sheet');
  const handle = {
    node, sheet,
    close(result) {
      if (handle.closed) return;
      handle.closed = true;
      const i = stack.indexOf(handle);
      if (i >= 0) stack.splice(i, 1);
      node.classList.add('out');
      setTimeout(() => {
        node.remove();
        if (!stack.length) document.body.classList.remove('locked');
      }, 300);
      onClose?.(result);
    },
  };
  stack.push(handle);

  requestAnimationFrame(() => node.classList.add('in'));
  if (dismissable) {
    node.querySelector('.scrim').addEventListener('click', () => { haptic('light'); handle.close(); });
    node.querySelector('.sheet-x')?.addEventListener('click', () => { haptic('light'); handle.close(); });
    makeDraggable(sheet, handle);
  }
  onMount?.(sheet, handle);
  // Give focus to the first meaningful control, but never auto-open the keyboard
  // on a sheet whose primary input is our own keypad.
  const focusTarget = sheet.querySelector('[autofocus]');
  if (focusTarget) setTimeout(() => focusTarget.focus(), 320);
  return handle;
}

export const topSheet = () => stack[stack.length - 1];
export const closeTopSheet = () => { const t = topSheet(); if (t) { t.close(); return true; } return false; };
export const anySheetOpen = () => stack.length > 0;

/** Flick-to-dismiss. Tracks velocity so a fast short flick counts, while a
 *  slow long drag that returns does not. */
function makeDraggable(sheet, handle) {
  const grip = sheet.querySelector('.grabber');
  const head = sheet.querySelector('.sheet-head');
  const body = sheet.querySelector('.sheet-body');
  let y0 = 0, t0 = 0, dy = 0, dragging = false, lastY = 0, lastT = 0, v = 0;

  const start = (e) => {
    // Only drag from the top chrome, or from the body when it's scrolled to the top.
    const fromChrome = grip.contains(e.target) || head?.contains(e.target);
    if (!fromChrome && !(body.contains(e.target) && body.scrollTop <= 0)) return;
    if (e.target.closest('button, input, textarea, select, .chip, .row-tap')) return;
    dragging = true; y0 = lastY = e.clientY; t0 = lastT = performance.now(); dy = 0; v = 0;
    sheet.style.transition = 'none';
  };
  const move = (e) => {
    if (!dragging) return;
    dy = e.clientY - y0;
    if (dy < 0) dy = dy * 0.28; // rubber-band upward, don't let it lift off
    const now = performance.now();
    if (now > lastT) v = (e.clientY - lastY) / (now - lastT);
    lastY = e.clientY; lastT = now;
    sheet.style.transform = `translateY(${dy.toFixed(1)}px)`;
    const scrim = sheet.parentElement.querySelector('.scrim');
    scrim.style.opacity = String(Math.max(0, 1 - dy / (sheet.offsetHeight || 500)));
    if (dy > 4) e.preventDefault();
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    sheet.parentElement.querySelector('.scrim').style.opacity = '';
    const far = dy > sheet.offsetHeight * 0.32;
    const flicked = v > 0.75 && dy > 40;
    if (far || flicked) { haptic('light'); handle.close(); }
    else sheet.style.transform = '';
  };

  sheet.addEventListener('pointerdown', start);
  sheet.addEventListener('pointermove', move, { passive: false });
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
}

/* ── Confirm ──────────────────────────────────────────────────────────────── */
export function confirmSheet({ title, message, confirm = 'Confirm', tone = 'danger' }) {
  return new Promise((resolve) => {
    let done = false;
    const h = openSheet({
      size: 'compact',
      body: `<div class="confirm">
        <h3>${esc(title)}</h3>
        ${message ? `<p>${esc(message)}</p>` : ''}
      </div>`,
      actions: `<button class="btn btn-ghost" data-no>Cancel</button><button class="btn btn-${tone}" data-yes>${esc(confirm)}</button>`,
      onMount(sheet) {
        sheet.querySelector('[data-yes]').addEventListener('click', () => { done = true; haptic('heavy'); h.close(); resolve(true); });
        sheet.querySelector('[data-no]').addEventListener('click', () => { done = true; h.close(); resolve(false); });
      },
      onClose() { if (!done) resolve(false); },
    });
  });
}

/* ── Option picker ────────────────────────────────────────────────────────── */
/** items: [{ id, label, sub, swatch, emoji, right, selected }] */
export function pickSheet({ title, subtitle, items, onPick, footer = '', onFooter }) {
  const h = openSheet({
    title, subtitle,
    body: `<div class="picker">${items.map((it, i) => `
      <button class="pick-row ${it.selected ? 'on' : ''}" data-id="${esc(it.id)}" style="--d:${Math.min(i * 22, 260)}ms">
        ${it.emoji ? `<span class="pick-emoji">${it.emoji}</span>` : it.swatch ? `<span class="pick-dot" style="background:${it.swatch}"></span>` : ''}
        <span class="pick-text"><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>
        ${it.right ? `<span class="pick-right">${it.right}</span>` : ''}
        ${it.selected ? `<span class="pick-check">${icon('check')}</span>` : ''}
      </button>`).join('')}
      ${footer ? `<button class="pick-row pick-footer">${icon('plus')}<span class="pick-text"><b>${esc(footer)}</b></span></button>` : ''}
    </div>`,
    onMount(sheet) {
      sheet.querySelectorAll('.pick-row[data-id]').forEach((b) =>
        b.addEventListener('click', () => { haptic('select'); h.close(); onPick(b.dataset.id); }));
      sheet.querySelector('.pick-footer')?.addEventListener('click', () => { haptic('tap'); h.close(); onFooter?.(); });
    },
  });
  return h;
}

/* ── Swipe-to-reveal on list rows ─────────────────────────────────────────────
 * Horizontal drag reveals Edit/Delete. Locks to an axis on first movement so it
 * never fights the vertical scroll. */
export function swipeable(row, { onDelete, onEdit }) {
  let x0 = 0, y0 = 0, dx = 0, axis = null, open = false;
  const width = onEdit ? 152 : 76; // must match .swipe-actions button widths
  const surface = row.querySelector('.swipe-track') || row;

  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    x0 = e.clientX; y0 = e.clientY; axis = null;
    surface.style.transition = 'none';
  });
  row.addEventListener('pointermove', (e) => {
    if (!x0) return;
    const ddx = e.clientX - x0, ddy = e.clientY - y0;
    if (!axis) {
      if (Math.abs(ddx) < 6 && Math.abs(ddy) < 6) return;
      axis = Math.abs(ddx) > Math.abs(ddy) * 1.3 ? 'x' : 'y';
      if (axis === 'y') { x0 = 0; surface.style.transition = ''; return; }
      row.setPointerCapture(e.pointerId);
    }
    dx = Math.min(0, ddx + (open ? -width : 0));
    if (dx < -width) dx = -width + (dx + width) * 0.2; // resist past the buttons
    surface.style.transform = `translateX(${dx.toFixed(1)}px)`;
    e.preventDefault();
  }, { passive: false });

  const settle = () => {
    if (!x0 || axis !== 'x') { x0 = 0; return; }
    x0 = 0;
    surface.style.transition = '';
    open = dx < -width * 0.45;
    surface.style.transform = open ? `translateX(${-width}px)` : '';
    if (open) haptic('light');
  };
  row.addEventListener('pointerup', settle);
  row.addEventListener('pointercancel', settle);

  row.querySelector('.swipe-del')?.addEventListener('click', (e) => { e.stopPropagation(); close(); onDelete?.(); });
  row.querySelector('.swipe-edit')?.addEventListener('click', (e) => { e.stopPropagation(); close(); onEdit?.(); });
  function close() { open = false; surface.style.transform = ''; }
  row._closeSwipe = close;
}

/** Close any open swipe rows — called when the user scrolls or taps elsewhere. */
export const closeSwipes = (root = document) => $$('.swipe-row', root).forEach((r) => r._closeSwipe?.());

/* ── Long press ───────────────────────────────────────────────────────────── */
export function longPress(node, fn, ms = 450) {
  let timer, moved = false, sx = 0, sy = 0;
  node.addEventListener('pointerdown', (e) => {
    moved = false; sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { if (!moved) { haptic('heavy'); fn(e); } }, ms);
  });
  const cancel = (e) => {
    if (e && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) moved = true;
    clearTimeout(timer);
  };
  node.addEventListener('pointermove', cancel);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('contextmenu', (e) => e.preventDefault());
}

/* ── Staggered entrance ───────────────────────────────────────────────────────
 * Sets a per-item delay so lists assemble rather than appear. Capped, because
 * a 40-item list that takes two seconds to arrive is an annoyance, not polish. */
export function stagger(nodes, step = 32, cap = 8) {
  nodes.forEach((n, i) => { n.style.setProperty('--d', `${Math.min(i, cap) * step}ms`); n.classList.add('rise'); });
}
