import { AsciiRenderer } from "./renderer";
import { World, type SharkSpec } from "./world";

const STEP = 1 / 60;
const MAX_STEPS = 4;

export interface OceanOptions {
  sharks?: SharkSpec[];
  /** Render rate cap; the simulation still steps at 60 Hz. */
  fps?: number;
  /** Which pointer-downs splash (all inside the canvas when absent). */
  canSplash?: (e: PointerEvent) => boolean;
}

/**
 * Wires World + AsciiRenderer to a canvas: fixed-timestep loop, resize,
 * pointer input, pausing off-screen, and prefers-reduced-motion.
 *
 * Dotline: the loop also runs only while the app window has focus (the
 * harness's own window when embedded in its iframe) and the tab is visible,
 * capped at `fps`; otherwise the last frame stays on screen.
 */
export class OceanEngine {
  private canvas: HTMLCanvasElement;
  private world: World;
  private renderer: AsciiRenderer;
  private raf = 0;
  private last = 0;
  private lastPaint = 0;
  private acc = 0;
  private frameMs: number;
  private canSplash?: (e: PointerEvent) => boolean;
  private visible = true;
  private focused = true;
  private focusTimer = 0;
  /** Windows whose focus/blur we follow: our own, plus the embedding host's. */
  private focusWindows: Window[];
  private reducedMotion: MediaQueryList;
  private resizeObserver: ResizeObserver;
  private intersectionObserver: IntersectionObserver;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: OceanOptions = {}) {
    this.canvas = canvas;
    this.frameMs = 1000 / (options.fps ?? 60);
    this.canSplash = options.canSplash;
    this.world = new World(options.sharks);
    this.renderer = new AsciiRenderer(canvas);
    this.renderer.setFontFamily(getComputedStyle(canvas).fontFamily);
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.focusWindows = [window];
    const host = sameOriginTop();
    if (host && host !== window) this.focusWindows.push(host);
    this.focused = this.hasFocus();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.schedule();
    });
    this.intersectionObserver.observe(canvas);

    this.reducedMotion.addEventListener("change", this.onMotionPreference);
    window.addEventListener("pointermove", this.onPointerMove, { passive: true });
    window.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    document.documentElement.addEventListener("pointerleave", this.onPointerLeave);
    window.addEventListener("blur", this.onPointerLeave);
    for (const w of this.focusWindows) {
      w.addEventListener("focus", this.onFocusChange);
      w.addEventListener("blur", this.onFocusChange);
    }
    document.addEventListener("visibilitychange", this.onFocusChange);

    this.resize();
    // Canvas text can't trigger a webfont load; once the mono face is in, redraw.
    document.fonts?.load(`600 16px ${getComputedStyle(canvas).fontFamily}`).then(() => {
      if (!this.disposed && this.reducedMotion.matches) this.drawStill();
    });
    this.schedule();
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.focusTimer);
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.reducedMotion.removeEventListener("change", this.onMotionPreference);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    document.documentElement.removeEventListener("pointerleave", this.onPointerLeave);
    window.removeEventListener("blur", this.onPointerLeave);
    for (const w of this.focusWindows) {
      w.removeEventListener("focus", this.onFocusChange);
      w.removeEventListener("blur", this.onFocusChange);
    }
    document.removeEventListener("visibilitychange", this.onFocusChange);
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.resize(rect.width, rect.height, dpr);
    this.world.resize(rect.width, rect.height, this.renderer.cellWidth, this.renderer.cellHeight);
    // A resize clears the canvas; a paused ocean still shows its last state.
    if (this.reducedMotion.matches || !this.focused) this.drawStill();
  }

  private schedule() {
    cancelAnimationFrame(this.raf);
    if (this.disposed || !this.visible || !this.focused || this.reducedMotion.matches) return;
    this.last = performance.now();
    this.lastPaint = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    // a few ms of slack so a 60 Hz display lands on every other vsync
    if (now - this.lastPaint < this.frameMs - 4) return;
    this.lastPaint = now;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_STEPS) {
      this.world.step(STEP);
      this.acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;
    this.renderer.render(this.world, dt);
  };

  /** Reduced motion: let the ecosystem settle, then show a single frame. */
  private drawStill() {
    if (this.world.time < 4) {
      for (let i = 0; i < 240; i++) this.world.step(STEP);
    }
    this.renderer.render(this.world, STEP);
  }

  private hasFocus() {
    if (document.hidden) return false;
    // The host document has focus whenever anything in its window does,
    // our iframe included; our own document only when focus is inside it.
    return this.focusWindows.some((w) => {
      try {
        return w.document.hasFocus();
      } catch {
        return false;
      }
    });
  }

  private onFocusChange = () => {
    // Focus moving between the host and our iframe blurs one window before
    // the other takes focus: settle before deciding.
    clearTimeout(this.focusTimer);
    this.focusTimer = window.setTimeout(() => {
      const focused = this.hasFocus();
      if (focused === this.focused) return;
      this.focused = focused;
      this.schedule();
    }, 50);
  };

  private onMotionPreference = () => {
    if (this.reducedMotion.matches) {
      cancelAnimationFrame(this.raf);
      this.drawStill();
    } else {
      this.schedule();
    }
  };

  private toLocal(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
    return { x, y, inside };
  }

  private onPointerMove = (e: PointerEvent) => {
    const { x, y, inside } = this.toLocal(e);
    const p = this.world.pointer;
    p.x = x;
    p.y = y;
    p.active = inside && e.pointerType !== "touch";
  };

  private onPointerDown = (e: PointerEvent) => {
    const { x, y, inside } = this.toLocal(e);
    if (!inside || this.reducedMotion.matches || !this.focused) return;
    if (this.canSplash && !this.canSplash(e)) return;
    this.world.splash(x, y);
  };

  private onPointerLeave = () => {
    this.world.pointer.active = false;
  };
}

function sameOriginTop(): Window | null {
  try {
    // reading a cross-origin parent's document throws
    return window.top && window.top.document ? window.top : null;
  } catch {
    return null;
  }
}
