const setupAuth = require("./setup-auth");
const {
  OPEN_WEBUI_HOME_URL,
  postHumanSession,
  safeRedirectPath,
  waitForOwuiReady,
} = require("./owui-auth-bridge-client");

const OWUI_AUTH_SEED_TTL_MS = 5 * 60 * 1000;

function isOwuiUiUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || OPEN_WEBUI_HOME_URL, OPEN_WEBUI_HOME_URL);
    if (url.origin !== OPEN_WEBUI_HOME_URL) {
      return false;
    }
    if (url.pathname.startsWith("/api/")) {
      return false;
    }
    if (url.pathname === "/auth") {
      return false;
    }
    return true;
  } catch (_error) {
    return false;
  }
}

async function ensureSetupSession() {
  let session;
  try {
    session = await setupAuth.getAuthorizedSession();
  } catch (_error) {
    const result = await setupAuth.startSetupAuth();
    if (!result?.success) {
      throw new Error(result?.error || "Okta login is required for OWUI");
    }
    session = await setupAuth.getAuthorizedSession();
  }
  // PORTICO-414: OWUI seeding requires an email; try the silent userinfo backfill
  // before letting buildHumanSessionPayload fail the view load. Proceed
  // either way — the payload builder still fails closed if unrepaired.
  if (!session?.user?.email) {
    const repair = await setupAuth.repairSessionIdentity().catch(() => null);
    if (repair?.repaired === true) {
      session = await setupAuth.getAuthorizedSession();
    }
  }
  return session;
}

function hasFreshSeed(owuiSession, session) {
  const seed = owuiSession.__porticoOwuiAuthSeed;
  if (!seed) {
    return false;
  }
  if (seed.pending) {
    return false;
  }
  if (seed.userId !== session?.user?.id) {
    return false;
  }
  if (Date.now() - Number(seed.seededAt || 0) > OWUI_AUTH_SEED_TTL_MS) {
    return false;
  }
  return true;
}

function handoffCompleteUrl(payload) {
  const rawCompleteUrl = String(payload?.complete_url || "").trim();
  if (!rawCompleteUrl) {
    throw new Error("OWUI human auth bridge returned no handoff URL");
  }
  const completeUrl = new URL(rawCompleteUrl, OPEN_WEBUI_HOME_URL);
  if (completeUrl.origin !== OPEN_WEBUI_HOME_URL) {
    throw new Error("OWUI human auth bridge returned an unsafe handoff URL");
  }
  return completeUrl.toString();
}

async function ensureOwuiHumanSessionForUrl({ owuiSession, targetUrl }) {
  if (!isOwuiUiUrl(targetUrl)) {
    return targetUrl;
  }

  const session = await ensureSetupSession();
  if (!hasFreshSeed(owuiSession, session)) {
    await waitForOwuiReady();
    const payload = await postHumanSession(session, {
      handoff: true,
      redirect: safeRedirectPath(targetUrl),
    });
    owuiSession.__porticoOwuiAuthSeed = {
      userId: session?.user?.id || null,
      seededAt: 0,
      pending: true,
      targetUrl,
      createdAt: Date.now(),
    };
    return handoffCompleteUrl(payload);
  }

  return targetUrl;
}

function markOwuiHumanSessionSeedVerified({ owuiSession, targetUrl }) {
  const seed = owuiSession?.__porticoOwuiAuthSeed;
  if (!seed) {
    return;
  }
  owuiSession.__porticoOwuiAuthSeed = {
    ...seed,
    pending: false,
    targetUrl: targetUrl || seed.targetUrl || null,
    seededAt: Date.now(),
  };
}

function clearOwuiHumanSessionSeed(owuiSession) {
  if (owuiSession) {
    delete owuiSession.__porticoOwuiAuthSeed;
  }
}

module.exports = {
  clearOwuiHumanSessionSeed,
  ensureOwuiHumanSessionForUrl,
  markOwuiHumanSessionSeedVerified,
  isOwuiUiUrl,
};
