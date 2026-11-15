// Shared UI pieces. Port of Components.swift plus desktop controls.
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);

export function Tile({ title, value, unit, size = 40, tint }) {
  return html`<div class="tile">
    <div class="t">${title}</div>
    <div class="v"><span class="val num ${tint || ''}" style=${{ fontSize: typeof size === 'number' ? `${size}px` : size }}>${value}</span>${unit ? html`<span class="unit">${unit}</span>` : null}</div>
  </div>`;
}

export function LV({ k, v, mono }) {
  return html`<div class="item lv"><span class="k">${k}</span><span class="v ${mono ? 'mono' : ''}">${v ?? '—'}</span></div>`;
}

export function Section({ title, footer, children }) {
  return html`<div class="section">
    ${title ? html`<h3>${title}</h3>` : null}
    ${children}
    ${footer ? html`<div class="footer">${footer}</div>` : null}
  </div>`;
}

export function Modal({ title, onClose, children, footer, size = '', closeLabel = 'Close', hideClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose && !hideClose && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, hideClose]);
  return html`<div class="overlay">
    <div class="modal ${size}" role="dialog" aria-label=${title}>
      <div class="modal-head">
        <div class="title">${title}</div>
        ${onClose && !hideClose ? html`<button class="btn" onClick=${onClose}>${closeLabel}</button>` : null}
      </div>
      <div class="modal-body">${children}</div>
      ${footer ? html`<div class="modal-foot">${footer}</div>` : null}
    </div>
  </div>`;
}

export function Confirm({ title, message, buttons, onCancel }) {
  return html`<${Modal} title=${title} onClose=${onCancel} size="narrow" hideClose=${true}
    footer=${html`${buttons.map((b) => html`<button class="btn ${b.kind || ''}" onClick=${b.onClick}>${b.label}</button>`)}`}>
    <div class="welcome-big">${message}</div>
  </${Modal}>`;
}

export function Toggle({ checked, onChange, label }) {
  return html`<label class="item row" style="cursor:pointer">
    <span>${label}</span><span class="spacer"></span>
    <span class="switch"><input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.target.checked)} /><span></span></span>
  </label>`;
}

export function Select({ label, value, options, onChange }) {
  return html`<div class="item row">
    <span>${label}</span><span class="spacer"></span>
    <select value=${String(value)} onChange=${(e) => onChange(e.target.value)}>
      ${options.map(([v, l]) => html`<option value=${String(v)}>${l}</option>`)}
    </select>
  </div>`;
}

export function Stepper({ label, value, display, min, max, step, onChange }) {
  return html`<div class="item row">
    <span>${label}</span><span class="spacer"></span>
    <span class="num" style="min-width:90px;text-align:right">${display ?? value}</span>
    <span class="stepper">
      <button onClick=${() => onChange(Math.max(min, +(value - step).toFixed(2)))} aria-label="Decrease">−</button>
      <button onClick=${() => onChange(Math.min(max, +(value + step).toFixed(2)))} aria-label="Increase">+</button>
    </span>
  </div>`;
}

export const Spinner = () => html`<span class="spinner"></span>`;

export function Progress({ value, color = 'var(--green)' }) {
  return html`<div class="progress"><div style=${{ width: `${Math.max(0, Math.min(1, value || 0)) * 100}%`, background: color }}></div></div>`;
}

/** Line chart of `points` [{x, y}] on a canvas. */
export function LineChart({ points, color, height = 160, yLabel, xLabel = 'minutes', includeZero = true }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      canvas.width = w * dpr;
      canvas.height = height * dpr;
      const g = canvas.getContext('2d');
      g.scale(dpr, dpr);
      g.clearRect(0, 0, w, height);
      const pts = points.filter((p) => p.y != null);
      if (pts.length < 2) return;
      const left = 44, right = 10, top = 22, bottom = 24;
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const xMin = Math.min(...xs), xMax = Math.max(...xs) || 1;
      let yMin = includeZero ? 0 : Math.min(...ys), yMax = Math.max(...ys);
      if (yMax === yMin) yMax = yMin + 1;
      const pad = (yMax - yMin) * 0.08;
      if (!includeZero) yMin -= pad;
      yMax += pad;
      const X = (x) => left + ((x - xMin) / (xMax - xMin || 1)) * (w - left - right);
      const Y = (y) => top + (1 - (y - yMin) / (yMax - yMin)) * (height - top - bottom);
      g.strokeStyle = 'rgba(255,255,255,0.1)';
      g.fillStyle = '#9a9aa2';
      g.font = '12px Segoe UI, system-ui';
      g.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const v = yMin + ((yMax - yMin) * i) / 4;
        const y = Y(v);
        g.beginPath(); g.moveTo(left, y); g.lineTo(w - right, y); g.stroke();
        g.fillText(String(Math.round(v)), 4, y + 4);
      }
      const decimals = xMax - xMin < 5 ? 1 : 0;
      for (let i = 0; i < 5; i++) {
        const v = xMin + ((xMax - xMin) * i) / 5;
        g.fillText(v.toFixed(decimals), X(v) - 6, height - 6);
      }
      g.fillText(yLabel || '', 4, 12);
      g.textAlign = 'right';
      g.fillText(xLabel, w - right, height - 6);
      g.textAlign = 'left';
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.lineJoin = 'round';
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y))));
      g.stroke();
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [points, color, height]);
  return html`<canvas class="chart" ref=${ref} style=${{ height: `${height}px` }}></canvas>`;
}
