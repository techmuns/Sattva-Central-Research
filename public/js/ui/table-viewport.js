/** Fit a table to its actual remaining viewport; observe chrome, never the table's own height. */
export function fitTableViewport(root, { bottomGap = 24, minHeight = 120, scrollerSelector = '[data-table-scroll]' } = {}) {
  const scroller = root.querySelector(scrollerSelector);
  if (!scroller) return () => {};
  scroller.style.overflowY = 'auto';
  let frame = 0;
  const apply = () => {
    frame = 0;
    if (!scroller.isConnected) return;
    // Measure from the document origin. A resize or late toolbar measurement can arrive
    // after the reader scrolls the page; viewport-relative top would grow the table by scrollY.
    const documentTop = scroller.getBoundingClientRect().top + window.scrollY;
    const gap = typeof bottomGap === 'function' ? bottomGap() : bottomGap;
    const height = Math.max(minHeight, Math.floor(innerHeight - documentTop - gap));
    scroller.style.height = scroller.style.maxHeight = `${height}px`;
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
  const observer = new ResizeObserver(schedule);
  for (const node of document.querySelectorAll('[data-app-header], [data-app-nav], #subview-mount')) observer.observe(node);
  for (const node of root.querySelectorAll('[data-table-toolbar], [data-news-toolbar], [data-section-head], [data-news-more], [data-mf-sizes], [data-chatter-toolbar]')) observer.observe(node);
  window.addEventListener('resize', schedule);
  schedule();
  return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); };
}
