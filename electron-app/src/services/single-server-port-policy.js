const CANONICAL_MAIN_STACK_CALLBACK_PORT = 3834;
const CANONICAL_SINGLE_STACK_CALLBACK_PORT = 3836;
const SUPPORTED_OAUTH_CALLBACK_PORTS = new Set([
  CANONICAL_MAIN_STACK_CALLBACK_PORT,
  CANONICAL_SINGLE_STACK_CALLBACK_PORT,
]);

function isSupportedOAuthCallbackPort(port) {
  return SUPPORTED_OAUTH_CALLBACK_PORTS.has(Number(port));
}

function normalizeSingleServerCallbackPort(
  port,
  fallback = CANONICAL_SINGLE_STACK_CALLBACK_PORT,
) {
  const numeric = Number(port);
  if (Number.isInteger(numeric) && isSupportedOAuthCallbackPort(numeric)) {
    return numeric;
  }
  return fallback;
}

function preferredSingleServerCallbackPorts() {
  return [CANONICAL_SINGLE_STACK_CALLBACK_PORT];
}

function applyMainStackOAuthCallbackPortEnv(env = {}) {
  return {
    ...env,
    MCPO_OAUTH_CALLBACK_PORT: String(CANONICAL_MAIN_STACK_CALLBACK_PORT),
    OAUTH_CALLBACK_PORT: String(CANONICAL_MAIN_STACK_CALLBACK_PORT),
  };
}

async function selectSingleServerCallbackPort(isPortAvailable) {
  for (const port of preferredSingleServerCallbackPorts()) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(
    `OAuth callback port ${CANONICAL_SINGLE_STACK_CALLBACK_PORT} is required for single-server setup and is already in use`,
  );
}

module.exports = {
  CANONICAL_MAIN_STACK_CALLBACK_PORT,
  CANONICAL_SINGLE_STACK_CALLBACK_PORT,
  isSupportedOAuthCallbackPort,
  normalizeSingleServerCallbackPort,
  preferredSingleServerCallbackPorts,
  applyMainStackOAuthCallbackPortEnv,
  selectSingleServerCallbackPort,
};
