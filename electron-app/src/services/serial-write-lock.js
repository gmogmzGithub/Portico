// Serial write lock for the JSON sidecar registries (skill links, agent
// links, agent local flags, the marketplace registry).
//
// Each of those files is a read-modify-write store: two concurrent mutations
// that both read before either writes would lose one update. Chaining every
// task onto a single promise makes the read-modify-write sequence atomic per
// registry.
//
// A failed task must not wedge the chain, so the tail always settles to
// undefined and the next task runs regardless of the previous outcome.
// Dependency-free on purpose: every consumer is a low-level store.

function createWriteLock() {
  let chain = Promise.resolve();

  return function withWriteLock(task) {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

module.exports = { createWriteLock };
