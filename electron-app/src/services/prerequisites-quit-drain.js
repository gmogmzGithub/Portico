function createPrerequisitesQuitDrain({
  cancelPrerequisites,
  continueQuit,
  onDrainError = () => {},
}) {
  let drainPromise = null;
  let drainComplete = false;

  return function drainPrerequisitesBeforeQuit(event) {
    if (drainComplete) {
      return false;
    }

    if (drainPromise) {
      event.preventDefault();
      return true;
    }

    const activeDrain = cancelPrerequisites();
    if (!activeDrain || typeof activeDrain.then !== "function") {
      drainComplete = true;
      return false;
    }

    event.preventDefault();
    drainPromise = Promise.resolve(activeDrain)
      .catch((error) => {
        onDrainError(error);
      })
      .finally(() => {
        drainComplete = true;
        drainPromise = null;
        continueQuit();
      });
    return true;
  };
}

module.exports = {
  createPrerequisitesQuitDrain,
};
