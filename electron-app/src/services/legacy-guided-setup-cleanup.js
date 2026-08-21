const fs = require("fs");
const path = require("path");

function withNoAsar(processRef, callback) {
  const hadNoAsar = Object.prototype.hasOwnProperty.call(processRef, "noAsar");
  const previousNoAsar = processRef.noAsar;

  try {
    processRef.noAsar = true;
    return callback();
  } finally {
    if (hadNoAsar) {
      processRef.noAsar = previousNoAsar;
    } else {
      delete processRef.noAsar;
    }
  }
}

function removePathRecursivelyNoAsar(targetPath, {
  fsRef = fs,
  processRef = process,
} = {}) {
  withNoAsar(processRef, () => {
    fsRef.rmSync(targetPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });
}

function removeLegacyGuidedSetupDir(managedDir, {
  fsRef = fs,
  pathRef = path,
  processRef = process,
} = {}) {
  const guidedSetupDir = pathRef.join(managedDir, "guided-setup");
  if (!fsRef.existsSync(guidedSetupDir)) {
    return {
      existed: false,
      path: guidedSetupDir,
      removed: false,
    };
  }

  removePathRecursivelyNoAsar(guidedSetupDir, { fsRef, processRef });
  return {
    existed: true,
    path: guidedSetupDir,
    removed: !fsRef.existsSync(guidedSetupDir),
  };
}

module.exports = {
  removeLegacyGuidedSetupDir,
  removePathRecursivelyNoAsar,
  withNoAsar,
};
