// Display formatting. Port of Format in Components.swift.

const pad2 = (n) => String(n).padStart(2, '0');

export function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 3600)}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
}

export function shortDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${pad2(Math.floor(s / 60) % 60)}m` : `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
}

export function speed(kph, units) {
  if (kph == null) return '--';
  return (units === 'imperial' ? kph * 0.621371 : kph).toFixed(1);
}

export const speedMS = (v, units) => speed(v == null ? null : v * 3.6, units);
export const speedUnit = (units) => (units === 'imperial' ? 'mph' : 'km/h');
export const distance = (metres, units) => (units === 'imperial' ? metres / 1609.344 : metres / 1000).toFixed(2);
export const distanceUnit = (units) => (units === 'imperial' ? 'mi' : 'km');
export const watts = (w) => (w == null ? '--' : String(Math.round(w)));
export const rpm = (c) => (c == null ? '--' : String(Math.round(c)));

export function dateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function time(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
