// Keep a panel's focused text field above the on-screen keyboard (iOS Safari / WebView: the keyboard overlays the
// page and shrinks only the visual viewport). Browser only. Returns a disposer.
export function keepAboveKeyboard(root: HTMLElement, panel: HTMLElement): () => void {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  let focused: HTMLElement | null = null;
  let raf = 0;
  const place = () => {
    raf = 0;
    if (!vv || !focused || !focused.isConnected) { panel.style.transform = ""; return; }
    panel.style.transform = "";
    const r = focused.getBoundingClientRect();
    const top = vv.offsetTop + 12, bottom = vv.offsetTop + vv.height - 16;
    let dy = 0;
    if (r.bottom > bottom) dy = bottom - r.bottom;
    if (r.top + dy < top) dy = top - r.top;
    panel.style.transform = dy ? `translateY(${Math.round(dy)}px)` : "";
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(place); };
  const isText = (t: EventTarget | null): t is HTMLElement =>
    t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !/^(range|checkbox|radio|button|submit)$/.test(t.type));
  const onIn = (e: FocusEvent) => { if (isText(e.target)) { focused = e.target; schedule(); setTimeout(schedule, 350); } };
  const onOut = (e: FocusEvent) => {
    if (e.target !== focused) return;
    focused = null;
    panel.style.transform = "";
    // iOS leaves the page scrolled after the keyboard closes
    setTimeout(() => { if (!focused && (window.scrollY || document.documentElement.scrollTop)) window.scrollTo(0, 0); }, 50);
  };
  root.addEventListener("focusin", onIn);
  root.addEventListener("focusout", onOut);
  vv?.addEventListener("resize", schedule);
  vv?.addEventListener("scroll", schedule);
  return () => {
    root.removeEventListener("focusin", onIn);
    root.removeEventListener("focusout", onOut);
    vv?.removeEventListener("resize", schedule);
    vv?.removeEventListener("scroll", schedule);
    if (raf) cancelAnimationFrame(raf);
    panel.style.transform = "";
  };
}
