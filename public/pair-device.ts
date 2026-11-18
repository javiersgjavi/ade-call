import { t, type MessageKey } from './i18n.js';
import { errorMessage } from './errors.js';
import type { PairedBrowser } from './browser-list.js';

/** What POST /api/browsers/pair returns. `expiresIn` is the server's remaining time
 * in milliseconds, so a wrong clock on this device does not shorten the countdown. */
export interface PairInvite { code: string; link: string; expiresAt: string; expiresIn: number; name: string }

/** Same rule as the server (BrowserAccess.name): trimmed, 1–80 characters, no control characters. */
export const NAME_LIMIT = 80;
export function deviceName(value: string) {
  const name = value.trim();
  return name && name.length <= NAME_LIMIT && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ? name : null;
}

/** Remaining time as m:ss, rounded up: it reads 0:00 only once the code has expired. */
export function countdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const REASONS: Record<string, MessageKey> = { origin_missing: 'pair.noOrigin', invalid_name: 'pair.invalidName', too_many_codes: 'pair.tooMany' };
/** A failed request as text: the server's known reasons translated, anything else as it came. */
export function pairError(error: unknown) {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' && Object.hasOwn(REASONS, reason) ? t(REASONS[reason]) : errorMessage(error);
}

/** The browser that redeemed the invite: active, with its name and not listed before the code existed. */
export function redeemedBy(devices: PairedBrowser[], before: ReadonlySet<string>, name: string, now = Date.now()) {
  return devices.find(device => !before.has(device.id) && device.name === name && !device.revokedAt && device.expiresAt > now) || null;
}

interface Options {
  create: (name: string) => Promise<PairInvite>;
  devices: () => Promise<PairedBrowser[]>;
  /** Redraws the Paired browsers list. */
  refreshList: () => void;
}
type View = 'closed' | 'form' | 'result' | 'ended';
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** "Pair another device" in Settings. The code lives only in this object and the panel's
 * DOM while it is shown: never in storage or the address bar, and it is removed when the
 * panel is dismissed, the code expires or the other device redeems it. */
export class PairDevice {
  private panel = byId<HTMLElement>('pair-panel');
  private open = byId<HTMLButtonElement>('pair-open');
  private form = byId<HTMLFormElement>('pair-form');
  private name = byId<HTMLInputElement>('pair-name');
  private submit = byId<HTMLButtonElement>('pair-submit');
  private link = byId<HTMLInputElement>('pair-link');
  private code = byId<HTMLElement>('pair-code');
  private timer = byId<HTMLElement>('pair-timer');
  private status = byId<HTMLElement>('pair-status');
  private invite: PairInvite | null = null;
  private deadline = 0;
  private ticks: ReturnType<typeof setInterval> | undefined;
  private polls: ReturnType<typeof setInterval> | undefined;
  private generation = 0;

  constructor(private options: Options) {
    this.name.placeholder = t('pair.namePlaceholder');
    this.name.maxLength = NAME_LIMIT;
    this.open.onclick = () => this.show('form');
    this.form.onsubmit = event => { event.preventDefault(); void this.create(); };
    byId('pair-cancel').onclick = () => this.dismiss();
    byId('pair-done').onclick = () => this.dismiss();
    byId('pair-end-done').onclick = () => this.dismiss();
    byId('pair-again').onclick = () => this.show('form');
    byId('pair-copy').onclick = () => void this.copy();
    const share = byId<HTMLButtonElement>('pair-share');
    share.hidden = typeof navigator.share !== 'function';
    share.onclick = () => void this.share();
    // Selecting the whole link at once makes copying by hand easy on a phone.
    this.link.onfocus = () => this.link.select();
  }

  private say(text: string) { this.status.textContent = text; }

  private show(view: View) {
    if (view !== 'result') this.clear();
    this.panel.hidden = view === 'closed';
    this.open.hidden = view !== 'closed';
    this.open.setAttribute('aria-expanded', String(view !== 'closed'));
    this.form.hidden = view !== 'form';
    byId('pair-result').hidden = view !== 'result';
    byId('pair-ended').hidden = view !== 'ended';
    if (view !== 'ended') this.say('');
    if (view === 'form') { this.submit.disabled = false; this.submit.textContent = t('pair.create'); this.name.focus(); }
  }

  /** Forgets the code: stops the timers and removes it from the page. */
  private clear() {
    this.generation++;
    clearInterval(this.ticks); clearInterval(this.polls);
    this.invite = null; this.link.value = ''; this.code.textContent = ''; this.timer.textContent = ''; byId('pair-for').textContent = '';
  }

  /** Hides the panel without a code; the list is refreshed in case a device paired meanwhile. */
  dismiss() {
    if (this.panel.hidden) return;
    const focused = this.panel.contains(document.activeElement);
    this.show('closed'); this.options.refreshList();
    if (focused) this.open.focus();
  }

  private async create() {
    const name = deviceName(this.name.value);
    if (!name) { this.say(t('pair.invalidName')); this.name.focus(); return; }
    const generation = ++this.generation;
    this.submit.disabled = true; this.submit.textContent = t('pair.creating'); this.say('');
    try {
      const before = new Set((await this.options.devices()).map(device => device.id));
      const invite = await this.options.create(name);
      if (generation !== this.generation) return;
      this.show('result');
      this.invite = invite; this.deadline = Date.now() + invite.expiresIn;
      byId('pair-for').textContent = t('pair.for', { name: invite.name });
      this.link.value = invite.link; this.code.textContent = invite.code;
      this.tick(); this.ticks = setInterval(() => this.tick(), 1000);
      this.polls = setInterval(() => void this.poll(before, generation), 4000);
      byId('pair-copy').focus();
    } catch (error) {
      if (generation !== this.generation) return;
      this.submit.disabled = false; this.submit.textContent = t('pair.create');
      this.say(pairError(error));
    }
  }

  private tick() {
    const left = this.deadline - Date.now();
    if (left <= 0) { this.end(t('pair.expired'), true); return; }
    this.timer.textContent = t('pair.expiresIn', { time: countdown(left) });
  }

  /** While the link is shown, notices when the other device has used it. */
  private async poll(before: ReadonlySet<string>, generation: number) {
    const invite = this.invite;
    if (!invite) return;
    const devices = await this.options.devices().catch(() => null);
    if (devices && generation === this.generation && redeemedBy(devices, before, invite.name)) {
      this.end(t('pair.paired', { name: invite.name }), false); this.options.refreshList();
    }
  }

  private end(text: string, expired: boolean) {
    const focused = this.panel.contains(document.activeElement);
    this.show('ended'); this.say(text);
    byId('pair-again').hidden = !expired;
    if (focused) byId(expired ? 'pair-again' : 'pair-end-done').focus();
  }

  private async copy() {
    const link = this.invite?.link;
    if (!link) return;
    try { await navigator.clipboard.writeText(link); this.say(t('pair.copied')); }
    catch { this.link.focus(); this.link.select(); this.say(t('pair.copyManual')); }
  }

  private async share() {
    const link = this.invite?.link;
    if (!link) return;
    try { await navigator.share({ title: t('pair.shareTitle'), url: link }); }
    catch (error) { if ((error as { name?: string })?.name !== 'AbortError') this.say(t('pair.copyManual')); }
  }
}
