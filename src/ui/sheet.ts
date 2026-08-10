/**
 * Bottom sheet (mobile) / side card (desktop ≥720px). On mobile the sheet
 * glides between half and full with the same damped easing as the camera;
 * dragging the grip or station title moves it directly; release snaps by
 * position + velocity.
 */

type SheetState = 'closed' | 'half' | 'full';

const HALF = 0.52; // translateY fraction when half-open

export class Sheet {
  private el = document.getElementById('sheet')!;
  private body = document.getElementById('sheet-body')!;
  private state: SheetState = 'closed';
  /** current/target translateY as fraction of sheet height (0 = full open) */
  private y = 1;
  private ty = 1;
  private raf = 0;
  private dragging = false;
  private desktop = matchMedia('(min-width: 720px)');
  onClose: (() => void) | null = null;

  constructor() {
    let startY = 0;
    let startFrac = 0;
    let lastY = 0;
    let lastT = 0;
    let vel = 0;

    this.el.addEventListener('pointerdown', (e) => {
      if (this.desktop.matches) return;
      const target = e.target as Element;
      if (!target.closest('#sheet-grip, .sheet-title')) return;
      this.dragging = true;
      this.el.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startFrac = this.y;
      lastY = e.clientY;
      lastT = performance.now();
      vel = 0;
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const h = this.el.clientHeight;
      const now = performance.now();
      const dt = Math.max(1, now - lastT);
      vel = ((e.clientY - lastY) / h) * (1000 / dt);
      lastY = e.clientY;
      lastT = now;
      this.y = Math.max(0, Math.min(1.05, startFrac + (e.clientY - startY) / h));
      this.apply();
    });
    const release = () => {
      if (!this.dragging) return;
      this.dragging = false;
      const proj = this.y + vel * 0.18; // project a bit ahead
      if (proj > 0.8) this.close();
      else this.setState(proj > HALF / 2 ? 'half' : 'full');
    };
    this.el.addEventListener('pointerup', release);
    this.el.addEventListener('pointercancel', release);
  }

  get isOpen() {
    return this.state !== 'closed';
  }

  open(content: HTMLElement, state: Exclude<SheetState, 'closed'> = 'half') {
    this.body.replaceChildren(content);
    this.body.scrollTop = 0;
    if (this.state === 'closed' && !this.desktop.matches) this.y = 1;
    this.el.dataset.state = state;
    this.setState(state);
  }

  /** Swap content without moving the sheet. */
  setContent(content: HTMLElement) {
    this.body.replaceChildren(content);
  }

  /** Grow to full height (mobile); no-op state refresh on desktop. */
  expand() {
    if (this.state !== 'closed') this.setState('full');
  }

  close() {
    if (this.state === 'closed') return;
    this.setState('closed');
    this.onClose?.();
  }

  private setState(s: SheetState) {
    this.state = s;
    if (this.desktop.matches) {
      this.el.dataset.state = s;
      return;
    }
    this.ty = s === 'closed' ? 1 : s === 'half' ? HALF : 0;
    if (s !== 'closed') this.el.dataset.state = s;
    this.animate();
  }

  private animate() {
    cancelAnimationFrame(this.raf);
    let last = performance.now();
    const step = (now: number) => {
      if (this.dragging) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const k = 1 - Math.exp(-11 * dt);
      this.y += (this.ty - this.y) * k;
      if (Math.abs(this.ty - this.y) < 0.002) {
        this.y = this.ty;
        this.apply();
        if (this.state === 'closed') this.el.dataset.state = 'closed';
        return;
      }
      this.apply();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private apply() {
    this.el.style.transform = `translateY(${(this.y * 100).toFixed(2)}%)`;
  }
}
