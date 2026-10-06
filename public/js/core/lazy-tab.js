// Share code loading without cancelling shared collection or data reads.
// Navigation cancellation belongs to the shell, immediately before rendering.
export function lazyTab(meta, importer) {
  let loaded = null;
  let pending = null;
  return {
    meta,
    load() {
      if (loaded) return Promise.resolve(loaded);
      if (!pending) pending = Promise.resolve().then(importer).then(module => {
        loaded = module;
        return module;
      }).catch(error => { pending = null; throw error; });
      return pending;
    },
    render(ctx) { return loaded.render(ctx); },
    destroy() { loaded?.destroy?.(); },
  };
}
