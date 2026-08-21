let pendingQuit = null;

function normalizeReason(reason) {
  if (typeof reason !== "string") {
    return "unspecified-app-quit";
  }
  const normalized = reason.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized || "unspecified-app-quit";
}

function tagAppQuit(reason) {
  pendingQuit = {
    appOwned: true,
    reason: normalizeReason(reason),
    taggedAt: new Date().toISOString(),
  };
  console.log(`[Quit] App-owned quit requested: ${pendingQuit.reason}`);
  return { ...pendingQuit };
}

function getQuitProvenance() {
  if (pendingQuit) {
    return { ...pendingQuit };
  }
  return {
    appOwned: false,
    reason: "user/OS/external",
    taggedAt: null,
  };
}

function resetQuitProvenanceForTests() {
  pendingQuit = null;
}

module.exports = {
  getQuitProvenance,
  resetQuitProvenanceForTests,
  tagAppQuit,
};
