// Client-side materialization of git-referenced AI Marketplace bundles.
//
// Some listings are published by reference to a git repository: the solution
// envelope carries bundle_source_git_url / bundle_source_ref /
// bundle_source_subpath and no inline bundle, and the backend's /bundle route
// materializes them on demand — which currently fails (HTTP 500 "Failed to
// get bundle") for such listings. The app already fetches skill directories
// from the allowlisted marketplace repositories with the user's auth, so when
// the backend cannot serve a bundle we synthesize the exact {type, payload}
// shape hosted-content bundles use and let the normal install pipeline
// continue unchanged (provenance, links, and records are untouched).

const fsPromises = require("fs").promises;
const os = require("os");
const path = require("path");

const marketplaceService = require("./marketplace-service");
const { isAllowedMarketplaceSource } = require("./marketplace-allowlist");
const { parseSkillMarkdownFrontmatter } = require("./skill-frontmatter");

// Bundles are held in memory as base64 (mirrors collectDirAsBase64's cap in
// ai-marketplace-install.js) — a media-heavy directory must fail loudly.
const MAX_BUNDLE_FILE_BYTES = 1024 * 1024;

function gitBundleError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

// The availability gate stays first (PORTICO-272): envelope 404s (solution
// missing or inactive) never reach the fallback. Everything else — the
// backend's 500 on git-referenced bundles, or a listing whose /bundle route
// 404s with no inline bundle — qualifies.
function shouldAttemptGitBundleFallback(error) {
  if (!error) return false;
  if (error.code === "no_bundle") return true;
  return Number(error.status) !== 404;
}

function extractBundleGitSource(envelope) {
  const gitUrl =
    typeof envelope?.bundle_source_git_url === "string"
      ? envelope.bundle_source_git_url.trim()
      : "";
  if (!gitUrl) return null;
  const ref =
    typeof envelope?.bundle_source_ref === "string" &&
    envelope.bundle_source_ref.trim()
      ? envelope.bundle_source_ref.trim()
      : null;
  const subpath =
    typeof envelope?.bundle_source_subpath === "string"
      ? envelope.bundle_source_subpath.trim().replace(/^\/+|\/+$/g, "")
      : "";
  return { gitUrl, ref, subpath };
}

async function collectPayloadFiles(rootDir) {
  const files = [];
  async function walk(dir, prefix) {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      // SKILL.md travels as payload.skill_md, not as a file entry.
      if (rel === "SKILL.md") continue;
      const stat = await fsPromises.stat(abs);
      if (stat.size > MAX_BUNDLE_FILE_BYTES) {
        throw gitBundleError(
          `Bundle file "${rel}" exceeds the ${Math.round(MAX_BUNDLE_FILE_BYTES / 1024)} KB per-file limit for git-sourced bundles.`,
          "git_bundle_file_too_large",
        );
      }
      const content = await fsPromises.readFile(abs);
      files.push({ path: rel, content_b64: content.toString("base64") });
    }
  }
  await walk(rootDir, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function payloadNameFromSkillMd(skillMd, subpath, envelope) {
  try {
    const frontmatter = parseSkillMarkdownFrontmatter(skillMd);
    if (typeof frontmatter?.name === "string" && frontmatter.name.trim()) {
      return frontmatter.name.trim();
    }
  } catch {
    // Frontmatter is best-effort; fall through to path/envelope names.
  }
  const base = path.posix.basename(subpath || "");
  if (base) return base;
  return typeof envelope?.name === "string" ? envelope.name : "";
}

async function materializeSkillBundleFromGitSource(
  envelope,
  { interactiveAuth = false, deps = {} } = {},
) {
  const gitSource = extractBundleGitSource(envelope);
  if (!gitSource) {
    throw gitBundleError(
      "Solution envelope carries no git bundle source.",
      "git_bundle_source_missing",
    );
  }

  const normalizeSource =
    deps.normalizeMarketplaceSourceInput ||
    marketplaceService.normalizeMarketplaceSourceInput;
  const download =
    deps.downloadSkillDirectory || marketplaceService.downloadSkillDirectory;
  const allowSource = deps.isAllowedMarketplaceSource || isAllowedMarketplaceSource;

  let source;
  try {
    source = normalizeSource(gitSource.gitUrl, { allowDirectUrlSource: false });
  } catch (error) {
    throw gitBundleError(
      `The listing's bundle repository URL is not a supported git source: ${error.message}`,
      "bundle_source_not_allowed",
      { cause: error },
    );
  }
  if (gitSource.ref) {
    source = { ...source, ref: gitSource.ref };
  }
  // normalizeMarketplaceSourceInput does not consult the GitHub repository
  // allowlist, so the policy predicate must run explicitly — fail closed for
  // repositories outside the approved marketplace sources.
  if (!allowSource(source)) {
    throw gitBundleError(
      `The listing's bundle repository (${gitSource.gitUrl}) is outside the approved marketplace sources.`,
      "bundle_source_not_allowed",
    );
  }

  const stagingDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "ai-marketplace-git-bundle-"),
  );
  try {
    await download(source, gitSource.subpath || "./", stagingDir, {
      interactiveAuth,
    });
    let skillMd;
    try {
      skillMd = await fsPromises.readFile(
        path.join(stagingDir, "SKILL.md"),
        "utf8",
      );
    } catch {
      throw gitBundleError(
        `The bundle source has no SKILL.md at "${gitSource.subpath || "./"}" in ${gitSource.gitUrl}.`,
        "git_bundle_missing_skill_md",
      );
    }
    const references = await collectPayloadFiles(stagingDir);
    return {
      type: "skills",
      id: envelope?.id,
      payload: {
        name: payloadNameFromSkillMd(skillMd, gitSource.subpath, envelope),
        skill_md: skillMd,
        references,
        scripts: [],
        required_mcp_servers: [],
      },
    };
  } finally {
    await fsPromises
      .rm(stagingDir, { recursive: true, force: true })
      .catch(() => {});
  }
}

// Read-only bundle for a GIT-marketplace skill (the details drill-in page):
// installed copies read straight from disk (no network); uninstalled ones
// download from the marketplace's allowlisted repository into throwaway
// staging. Returns { bundle, installed } — bundle is byte-compatible with the
// hosted-content shape the Discover read-only page already renders. Lives
// here (not marketplace-service) so it can reuse collectPayloadFiles without
// a require cycle: this module already imports marketplace-service.
async function materializeGitMarketplaceSkillBundle({
  projectRoot,
  marketplaceId,
  skillId,
  pluginName = null,
  interactiveAuth = false,
  logger = console,
  deps = {},
} = {}) {
  const getCatalog =
    deps.getMarketplaceSkillsCached ||
    marketplaceService.getMarketplaceSkillsCached;
  const resolveSource =
    deps.resolveRemoteSkillSource || marketplaceService.resolveRemoteSkillSource;
  const sameRepo =
    deps.isSameRepositorySource || marketplaceService.isSameRepositorySource;
  const download =
    deps.downloadSkillDirectory || marketplaceService.downloadSkillDirectory;
  const allowSource =
    deps.isAllowedMarketplaceSource || isAllowedMarketplaceSource;

  // Cached-manifest read only — the details page cannot exist without one,
  // and a preview must never trigger reconcile/network catalog work.
  const { marketplace, skills } = await getCatalog({
    projectRoot,
    marketplaceId,
    logger,
  });
  const record = (Array.isArray(skills) ? skills : []).find(
    (skill) =>
      skill?.id === skillId &&
      (skill?.pluginName || null) === (pluginName || null),
  );
  if (!record) {
    throw gitBundleError(
      `Skill "${skillId}" was not found in marketplace "${marketplaceId}".`,
      "skill_not_found",
    );
  }
  if (record.available === false) {
    throw gitBundleError(
      `Skill "${skillId}" comes from a repository outside the approved marketplace sources.`,
      "marketplace_source_not_allowed",
    );
  }

  const buildFromDir = async (dir, sourceLabel) => {
    let skillMd;
    try {
      skillMd = await fsPromises.readFile(path.join(dir, "SKILL.md"), "utf8");
    } catch {
      throw gitBundleError(
        `No SKILL.md found for "${skillId}" (${sourceLabel}).`,
        "git_bundle_missing_skill_md",
      );
    }
    const references = await collectPayloadFiles(dir);
    return {
      type: "skills",
      id: skillId,
      payload: {
        name: payloadNameFromSkillMd(skillMd, record.skillPath, {
          name: record.displayName || skillId,
        }),
        skill_md: skillMd,
        references,
        scripts: [],
        required_mcp_servers: [],
      },
    };
  };

  // Installed copy: the local directory IS the content — zero network.
  if (
    record.installed &&
    typeof record.localPath === "string" &&
    record.localPath
  ) {
    const dir = path.join(projectRoot, record.localPath);
    return { bundle: await buildFromDir(dir, record.localPath), installed: true };
  }

  const remoteSource = resolveSource(record.skillSource, marketplace.source);
  // Same policy backstop as installMarketplaceSkill: an explicit object
  // skillSource pointing at a DIFFERENT repository than the marketplace's
  // own must independently pass the allowlist — previews and installs share
  // one policy.
  if (
    record.skillSource &&
    typeof record.skillSource === "object" &&
    !sameRepo(remoteSource, marketplace.source) &&
    !allowSource(remoteSource)
  ) {
    throw gitBundleError(
      `Skill "${skillId}" comes from a repository outside the approved marketplace sources.`,
      "marketplace_source_not_allowed",
    );
  }

  const stagingDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "git-marketplace-skill-preview-"),
  );
  try {
    await download(remoteSource, record.skillPath || "./", stagingDir, {
      interactiveAuth,
    });
    return {
      bundle: await buildFromDir(stagingDir, `${marketplaceId} repository`),
      installed: false,
    };
  } finally {
    await fsPromises
      .rm(stagingDir, { recursive: true, force: true })
      .catch(() => {});
  }
}

module.exports = {
  extractBundleGitSource,
  materializeGitMarketplaceSkillBundle,
  materializeSkillBundleFromGitSource,
  shouldAttemptGitBundleFallback,
};
