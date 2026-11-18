import { t, locale } from './i18n.js';

/** A paired browser as GET /api/browsers lists it. */
export interface PairedBrowser { id: string; name: string; lastSeen: number; expiresAt: number; revokedAt: number | null }

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/** The last access as short relative text ("5 minutes ago"), or a date after a week. */
export function lastAccess(at: number, now = Date.now()) {
  const age = Math.max(0, now - at);
  const relative = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (age < MINUTE) return relative.format(0, 'second');
  if (age < HOUR) return relative.format(-Math.floor(age / MINUTE), 'minute');
  if (age < DAY) return relative.format(-Math.floor(age / HOUR), 'hour');
  if (age < 7 * DAY) return relative.format(-Math.floor(age / DAY), 'day');
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(locale(), { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Browsers that can still sign in: this one first, then by most recent access. */
export function activeBrowsers(devices: PairedBrowser[], currentId: string | null, now = Date.now()) {
  return devices.filter(device => !device.revokedAt && device.expiresAt > now)
    .sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId) || b.lastSeen - a.lastSeen);
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** One list row with a status text instead of a browser (loading, empty, failed). */
export function browserNote(key: 'browsers.loading' | 'browsers.empty' | 'browsers.loadFailed') {
  return node('li', 'device-note', t(key));
}

/** Rows for the paired browsers, built as text nodes only. The current browser has no
 * Unpair button of its own: "Unpair this browser" below the list does that. */
export function browserRows(devices: PairedBrowser[], currentId: string | null, onUnpair: (device: PairedBrowser) => void, now = Date.now()) {
  const active = activeBrowsers(devices, currentId, now);
  if (!active.length) return [browserNote('browsers.empty')];
  return active.map(device => {
    const row = node('li', 'device'), main = node('div', 'device-main'), title = node('div', 'device-title');
    title.append(node('span', 'device-name', device.name));
    if (device.id === currentId) { row.dataset.current = ''; title.append(node('span', 'device-badge', t('browsers.current'))); }
    const seen = node('time', 'device-meta', t('browsers.lastSeen', { time: lastAccess(device.lastSeen, now) }));
    seen.dateTime = new Date(device.lastSeen).toISOString();
    seen.title = new Date(device.lastSeen).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
    main.append(title, seen); row.append(main);
    if (device.id !== currentId) {
      const button = node('button', 'btn btn-ghost btn-compact', t('browsers.unpair'));
      button.type = 'button'; button.setAttribute('aria-label', t('browsers.unpairNamed', { name: device.name }));
      button.onclick = () => onUnpair(device);
      row.append(button);
    }
    return row;
  });
}
