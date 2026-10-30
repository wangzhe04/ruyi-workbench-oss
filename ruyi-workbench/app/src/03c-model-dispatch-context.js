// Carries only an original owner's private prepare/assert callbacks across its
// engine's async calls until its first accepted dispatch. Derived workflows keep
// their original lifetimes; a consumed parent context supplies no callbacks.
// No permission facts, storage, timers or IO live here.
const ModelDispatchContext = ((AsyncLocalStorage) => {
  const local = new AsyncLocalStorage();
  return Object.freeze({ run: (callbacks, work) => local.run(callbacks, work), current: () => {
    const callbacks = local.getStore();
    return callbacks?.active && !callbacks.active() ? null : callbacks;
  } });
})(require('node:async_hooks').AsyncLocalStorage);
