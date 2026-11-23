import { t, type MessageKey } from './i18n.js';

// First-visit tour of the workspace: a modal dialog that dims the page, rings
// one part of it and explains it in a short card. It runs once per browser;
// skipping counts as seen, and Settings → General repeats it.
export type TourStep = { target?: string; title: MessageKey; body: MessageKey };
export const TOUR_STEPS: readonly TourStep[] = [
  { title: 'tour.welcomeTitle', body: 'tour.welcomeBody' },
  { target: '#backend', title: 'tour.adeTitle', body: 'tour.adeBody' },
  { target: '.dial', title: 'tour.callTitle', body: 'tour.callBody' },
  { target: '#stage', title: 'tour.sendTitle', body: 'tour.sendBody' },
  { target: '.convo', title: 'tour.conversationTitle', body: 'tour.conversationBody' },
  { target: '.side', title: 'tour.projectsTitle', body: 'tour.projectsBody' },
  { target: '#open-settings', title: 'tour.settingsTitle', body: 'tour.settingsBody' },
];

// Bump the version when the tour changes enough to show it again.
export const TOUR_KEY = 'tour-seen', TOUR_VERSION = '1';
// Storage that throws (blocked site data) counts as seen: a tour on every load is worse than none.
export function tourSeen(storage: Pick<Storage, 'getItem'>) {
  try { return storage.getItem(TOUR_KEY) === TOUR_VERSION; } catch { return true; }
}
export function markTourSeen(storage: Pick<Storage, 'setItem'>) {
  try { storage.setItem(TOUR_KEY, TOUR_VERSION); } catch { /* Not remembered; the tour may show again. */ }
}

export type Box = { top: number; left: number; width: number; height: number };
// The card goes below the target, else above it, else at the bottom of the
// screen over a target too tall for either; without a target, centered. It is
// always kept inside the viewport.
export function placeCard(target: Box | null, card: { width: number; height: number }, view: { width: number; height: number }, gap = 14, margin = 16) {
  const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, max - margin));
  const left = (center: number) => clamp(center - card.width / 2, view.width - card.width);
  if (!target) return { top: clamp((view.height - card.height) / 2, view.height - card.height), left: left(view.width / 2), side: 'center' as const };
  const center = target.left + target.width / 2, bottom = target.top + target.height;
  if (bottom + gap + card.height <= view.height - margin) return { top: bottom + gap, left: left(center), side: 'below' as const };
  if (target.top - gap - card.height >= margin) return { top: target.top - gap - card.height, left: left(center), side: 'above' as const };
  return { top: clamp(view.height - card.height, view.height - card.height), left: left(center), side: 'over' as const };
}
// The ringed area: the target with some air, cut to the viewport.
export function spotlight(target: Box, view: { width: number; height: number }, pad = 8): Box {
  const top = Math.max(0, target.top - pad), left = Math.max(0, target.left - pad);
  return { top, left, width: Math.min(view.width, target.left + target.width + pad) - left, height: Math.min(view.height, target.top + target.height + pad) - top };
}

type Parts = { dialog: HTMLDialogElement; spot: HTMLElement; card: HTMLElement; count: HTMLElement; title: HTMLElement; body: HTMLElement; skip: HTMLButtonElement; back: HTMLButtonElement; next: HTMLButtonElement };
export class Tour {
  private steps: { step: TourStep; element: Element | null }[] = [];
  private index = 0;
  private frame = 0;
  private readonly resized: ResizeObserver;
  constructor(private readonly parts: Parts, private readonly onEnd: () => void) {
    parts.skip.onclick = () => this.end();
    parts.back.onclick = () => this.show(this.index - 1);
    parts.next.onclick = () => this.index === this.steps.length - 1 ? this.end() : this.show(this.index + 1);
    // Escape skips the tour.
    parts.dialog.addEventListener('cancel', event => { event.preventDefault(); this.end(); });
    parts.dialog.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight' && this.index < this.steps.length - 1) this.show(this.index + 1);
      else if (event.key === 'ArrowLeft' && this.index > 0) this.show(this.index - 1);
    });
    // The page keeps changing under the tour (projects arrive, the viewport
    // turns), so the ring and the card follow the target.
    const follow = () => { cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(() => this.place()); };
    addEventListener('resize', follow); addEventListener('scroll', follow, { passive: true });
    this.resized = new ResizeObserver(follow);
  }
  get open() { return this.parts.dialog.open; }
  // Steps whose part of the page is not shown (one ADE, a hidden panel) are left out.
  start() {
    if (this.open) return;
    this.steps = TOUR_STEPS.map(step => ({ step, element: step.target ? document.querySelector(step.target) : null }))
      .filter(({ step, element }) => !step.target || (element && element.getClientRects().length));
    delete this.parts.dialog.dataset.ready;
    this.parts.dialog.showModal();
    this.show(0);
    requestAnimationFrame(() => { this.parts.dialog.dataset.ready = ''; });
  }
  private end() {
    if (!this.open) return;
    this.resized.disconnect();
    this.parts.dialog.close();
    this.onEnd();
  }
  private show(index: number) {
    const { step, element } = this.steps[index];
    this.index = index;
    this.parts.count.textContent = t('tour.count', { current: index + 1, total: this.steps.length });
    this.parts.title.textContent = t(step.title); this.parts.body.textContent = t(step.body);
    this.parts.back.hidden = index === 0;
    this.parts.next.textContent = t(index === this.steps.length - 1 ? 'tour.done' : 'tour.next');
    this.parts.skip.hidden = index === this.steps.length - 1;
    this.resized.disconnect(); this.resized.observe(this.parts.card); this.resized.observe(document.body);
    if (element) {
      this.resized.observe(element);
      const box = element.getBoundingClientRect();
      element.scrollIntoView({ block: box.height > innerHeight * 0.6 ? 'start' : 'center', behavior: 'auto' });
    }
    this.place();
    // Focus moves for keyboards and screen readers, without a ring on every tap.
    this.parts.next.focus({ focusVisible: false } as FocusOptions);
  }
  private place() {
    if (!this.open) return;
    const { element } = this.steps[this.index];
    const view = { width: document.documentElement.clientWidth, height: innerHeight };
    const target = element?.getBoundingClientRect() || null;
    const { spot, card } = this.parts;
    spot.toggleAttribute('data-empty', !target);
    const ring = target ? spotlight(target, view) : { top: view.height / 2, left: view.width / 2, width: 0, height: 0 };
    spot.style.top = `${ring.top}px`; spot.style.left = `${ring.left}px`;
    spot.style.width = `${ring.width}px`; spot.style.height = `${ring.height}px`;
    const { top, left, side } = placeCard(target && spotlight(target, view), { width: card.offsetWidth, height: card.offsetHeight }, view);
    card.style.top = `${top}px`; card.style.left = `${left}px`; card.dataset.side = side;
  }
}
