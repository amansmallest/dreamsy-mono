// Web (PWA) on a laptop / desktop: the app's horizontal shelves (feed rows, pills, chips) are touch
// swipers. Trackpads already scroll them sideways and vertical lists scroll with the wheel; this
// adds mouse drag: press and drag sideways on any horizontal scroller to scroll it. A drag doesn't
// count as a tap on the card under the pointer. Installed once on import (app/_layout.tsx).

type Drag = { el: HTMLElement; x: number; left: number; moved: boolean };

const SLOP = 6;
let drag: Drag | null = null;

function horizontalScroller(start: EventTarget | null): HTMLElement | null {
  for (let el = start instanceof HTMLElement ? start : null; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const o = getComputedStyle(el).overflowX;
      if (o === 'auto' || o === 'scroll') return el;
    }
  }
  return null;
}

function swallowClick(e: MouseEvent) {
  e.stopPropagation();
  e.preventDefault();
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, iframe, [contenteditable="true"]')) return;
      const el = horizontalScroller(t);
      drag = el ? { el, x: e.clientX, left: el.scrollLeft, moved: false } : null;
    },
    true,
  );
  window.addEventListener(
    'pointermove',
    (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved) {
        if (Math.abs(dx) < SLOP) return;
        drag.moved = true;
        document.body.classList.add('dreamsy-dragging');
      }
      drag.el.scrollLeft = drag.left - dx;
      e.preventDefault();
    },
    true,
  );
  const end = () => {
    if (drag?.moved) {
      document.body.classList.remove('dreamsy-dragging');
      // The click that follows a drag isn't a tap.
      window.addEventListener('click', swallowClick, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallowClick, true), 0);
    }
    drag = null;
  };
  // Cards hold images / links; the browser's own drag-and-drop would take over the gesture.
  window.addEventListener(
    'dragstart',
    (e) => {
      if (drag) e.preventDefault();
    },
    true,
  );
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
}

export {};
