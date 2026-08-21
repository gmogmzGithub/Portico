(function attachMcpServerRequirements(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (globalScope && typeof globalScope === "object") {
    globalScope.McpServerRequirements = api;
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function createMcpServerRequirements() {
    function getRequiredEnvVars(server = {}) {
      const requiredEnvVars = server.required_env_vars ?? server.requiredVars;
      return Array.isArray(requiredEnvVars)
        ? requiredEnvVars.filter(Boolean)
        : [];
    }

    // Guided setup only queues servers that explicitly require user authorization.
    function serverRequiresOAuth(server = {}) {
      return server.oauth?.requires_user_authorization === true;
    }

    // Control Plane historically treats an OAuth type as OAuth-capable even when
    // requires_user_authorization is omitted.
    function serverSupportsOAuth(server = {}) {
      return Boolean(
        server.oauth &&
          (server.oauth.requires_user_authorization === true ||
            server.oauth.type),
      );
    }

    function serverRequiresConfig(server = {}) {
      return getRequiredEnvVars(server).length > 0;
    }

    function serverRequiresConfigurationBeforeOAuth(server = {}) {
      return serverRequiresOAuth(server) && serverRequiresConfig(server);
    }

    function getGuidedSetupRequirements(server = {}) {
      return {
        requiresOAuth: serverRequiresOAuth(server),
        requiresConfig: serverRequiresConfig(server),
      };
    }

    function getControlPlaneRequirements(server = {}) {
      return {
        requiresOAuth: serverSupportsOAuth(server),
        requiresConfig: serverRequiresConfig(server),
      };
    }

    function resolveControlPlaneSetupAction(server = {}, options = {}) {
      const { requiresOAuth, requiresConfig } =
        getControlPlaneRequirements(server);
      const hasOAuthTokens =
        typeof options.hasOAuthTokens === "boolean"
          ? options.hasOAuthTokens
          : server.hasOAuthTokens === true;
      const isConfigured =
        typeof options.isConfigured === "boolean"
          ? options.isConfigured
          : server.isConfigured === true;

      if (requiresOAuth && !hasOAuthTokens) {
        return "authenticate";
      }
      if (requiresConfig && !isConfigured) {
        return "configure";
      }
      return null;
    }

    function getGuidedSetupDescription(server = {}) {
      const candidates = [
        server.guidedSetupDescription,
        server.guided_setup_description,
        server.description,
      ];

      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
          return candidate.trim();
        }
      }

      return "";
    }

    return {
      getRequiredEnvVars,
      serverRequiresOAuth,
      serverSupportsOAuth,
      serverRequiresConfig,
      serverRequiresConfigurationBeforeOAuth,
      getGuidedSetupRequirements,
      getControlPlaneRequirements,
      resolveControlPlaneSetupAction,
      getGuidedSetupDescription,
    };
  },
);
