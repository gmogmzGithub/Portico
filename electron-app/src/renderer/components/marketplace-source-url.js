(function (root, factory) {
  const exported = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = exported;
  }

  if (root) {
    root.marketplaceSourceUrl = exported;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function trimTrailingSlash(value) {
    return String(value || "").trim().replace(/\/+$/g, "");
  }

  function trimTrailingGitSuffix(value) {
    return trimTrailingSlash(value).replace(/\.git$/i, "");
  }

  function deriveGitHubMarketplaceUrl(source) {
    const repoUrl =
      trimTrailingSlash(source?.repoUrl) ||
      (typeof source?.repo === "string" && source.repo.trim()
        ? `https://github.com/${source.repo.trim().replace(/^\/+|\/+$/g, "")}`
        : "");
    if (!repoUrl) {
      return null;
    }

    return repoUrl;
  }

  function deriveGitLabMarketplaceUrl(source) {
    const repoUrl =
      trimTrailingGitSuffix(source?.repoUrl) ||
      (typeof source?.host === "string" &&
      typeof source?.projectPath === "string" &&
      source.host.trim() &&
      source.projectPath.trim()
        ? `https://${source.host.trim()}/${source.projectPath
            .trim()
            .replace(/^\/+|\/+$/g, "")}`
        : "");
    if (!repoUrl) {
      return null;
    }

    return `${repoUrl}/`;
  }

  function deriveCanonicalMarketplaceUrl(source) {
    if (!source || typeof source !== "object") {
      return null;
    }

    switch (source.type) {
      case "url": {
        const url = String(source.url || "").trim();
        return url || null;
      }
      case "github":
        return deriveGitHubMarketplaceUrl(source);
      case "gitlab":
        return deriveGitLabMarketplaceUrl(source);
      default:
        return null;
    }
  }

  return {
    deriveCanonicalMarketplaceUrl,
  };
});
