/*
 * Multi-touch gesture tracking with Pointer Events.
 *
 * Reports incremental changes so the caller can apply them in its own
 * coordinate system (the app maps screen points into canvas space through the
 * current homography, which keeps gestures correct even in perspective):
 *   begin(p)                 first finger down
 *   move(prev[], cur[])      1 or 2 finger positions before/after this move
 *   end()                    all fingers up
 *   tap(p)                   short touch without movement
 */
export class Gestures {
  constructor(el, handlers) {
    this.el = el;
    this.h = handlers;
    this.pointers = new Map(); // id -> {x, y}
    this.tapStart = null;
    el.addEventListener('pointerdown', e => this._down(e));
    el.addEventListener('pointermove', e => this._move(e));
    el.addEventListener('pointerup', e => this._up(e));
    el.addEventListener('pointercancel', e => this._up(e, true));
  }

  _pos(e) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _down(e) {
    this.el.setPointerCapture(e.pointerId);
    const p = this._pos(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.tapStart = { ...p, t: performance.now(), moved: false };
      this.h.begin && this.h.begin(p);
    } else if (this.tapStart) {
      this.tapStart.moved = true; // multi-finger is never a tap
    }
  }

  _move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const ids = [...this.pointers.keys()].slice(0, 2);
    const prev = ids.map(id => ({ ...this.pointers.get(id) }));
    const p = this._pos(e);
    this.pointers.set(e.pointerId, p);
    const cur = ids.map(id => ({ ...this.pointers.get(id) }));
    if (this.tapStart && Math.hypot(p.x - this.tapStart.x, p.y - this.tapStart.y) > 10) this.tapStart.moved = true;
    if (ids.includes(e.pointerId)) this.h.move && this.h.move(prev, cur);
  }

  _up(e, cancelled) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this._pos(e);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      const t = this.tapStart;
      this.tapStart = null;
      this.h.end && this.h.end();
      if (!cancelled && t && !t.moved && performance.now() - t.t < 350) this.h.tap && this.h.tap(p);
    }
  }
}
