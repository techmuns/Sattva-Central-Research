/** Fit a table to its actual remaining viewport; observe chrome, never the table's own height. */
export function fitTableViewport(root, { bottomGap = 24, minHeight = 120 } = {}) {
  const scroller = root.querySelector('[data-table-scroll]');
  if (!scroller) return () => {};
  scroller.style.overflowY = 'auto';
  let frame = 0;
  const apply = () => {
    frame = 0;
    if (!scroller.isConnected) return;
    const height = Math.max(minHeight, Math.floor(innerHeight - scroller.getBoundingClientRect().top - bottomGap));
    scroller.style.height = scroller.style.maxHeight = `${height}px`;
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
  const observer = new ResizeObserver(schedule);
  for (const node of document.querySelectorAll('[data-app-header], [data-app-nav], #subview-mount')) observer.observe(node);
  for (const node of root.querySelectorAll('[data-table-toolbar], [data-mf-sizes], [data-chatter-toolbar]')) observer.observe(node);
  window.addEventListener('resize', schedule);
  schedule();
  return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); };
}
