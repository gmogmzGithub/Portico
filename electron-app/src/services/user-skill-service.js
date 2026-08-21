// Authoritative filesystem service for locally owned Agent Skills.
//
// All paths that materialize or replace a skills-user/<id>/SKILL.md go through
// this module so creator attribution never depends on an LLM argument, the
// renderer, or the operating-system account.

const crypto = require("node:crypto");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const yaml = require("js-yaml");

const { formatSkillDisplayName } = require("./skill-frontmatter");

const DEFAULT_DESCRIPTION = "User-created agent skill.";
const MAX_SKILL_CONTENT_CHARS = 2_000_000;

class UserSkillError extends Error {
  constructor(message, code, cause = undefined) {
    super(message);
    this.name = "UserSkillError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function nonblankString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeSkillName(value) {
  const skillName = nonblankString(value);
  if (
    !skillName ||
    skillName === "." ||
    skillName === ".." ||
    skillName.startsWith(".") ||
    skillName.startsWith("_") ||
    skillName.includes("/") ||
    skillName.includes("\\") ||
    skillName.includes("\0") ||
    Buffer.byteLength(skillName, "utf8") > 255
  ) {
    throw new UserSkillError("A valid, nonhidden skill name is required.", "invalid_skill_name");
  }
  return skillName;
}

// Human title for envelopes: an authored display_name wins unless it merely
// restates the kebab id (the guard the Rust catalog also applies — installed
// sidecars carry display_name = the kebab solution name), else derive.
function skillDisplayNameFromMetadata(metadata, canonicalName) {
  const explicit =
    nonblankString(metadata?.display_name) ||
    nonblankString(
      metadata?.metadata && typeof metadata.metadata === "object"
        ? metadata.metadata.display_name
        : "",
    );
  if (explicit && explicit !== canonicalName) return explicit;
  return formatSkillDisplayName(canonicalName);
}

function splitSkillMarkdown(content) {
  if (typeof content !== "string") {
    throw new UserSkillError("Skill content must be a string.", "invalid_skill_content");
  }
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    throw new UserSkillError("Skill content is too large.", "skill_content_too_large");
  }

  const firstLineEnd = content.indexOf("\n");
  const firstLine = (firstLineEnd === -1 ? content : content.slice(0, firstLineEnd))
    .replace(/\r$/, "")
    .trim();
  if (firstLine !== "---") {
    return { metadata: {}, body: content, hadFrontmatter: false };
  }

  if (firstLineEnd === -1) {
    throw new UserSkillError(
      "SKILL.md begins with YAML frontmatter but has no closing delimiter.",
      "malformed_skill_frontmatter",
    );
  }

  let cursor = firstLineEnd + 1;
  let closingStart = -1;
  let bodyStart = -1;
  while (cursor <= content.length) {
    const nextNewline = content.indexOf("\n", cursor);
    const lineEnd = nextNewline === -1 ? content.length : nextNewline;
    const line = content.slice(cursor, lineEnd).replace(/\r$/, "");
    if (line.trim() === "---") {
      closingStart = cursor;
      bodyStart = nextNewline === -1 ? content.length : nextNewline + 1;
      break;
    }
    if (nextNewline === -1) break;
    cursor = nextNewline + 1;
  }

  if (closingStart === -1) {
    throw new UserSkillError(
      "SKILL.md begins with YAML frontmatter but has no closing delimiter.",
      "malformed_skill_frontmatter",
    );
  }

  const rawFrontmatter = content.slice(firstLineEnd + 1, closingStart);
  let metadata;
  try {
    metadata = yaml.load(rawFrontmatter, { json: true });
  } catch (error) {
    throw new UserSkillError(
      "SKILL.md contains malformed YAML frontmatter.",
      "malformed_skill_frontmatter",
      error,
    );
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new UserSkillError(
      "SKILL.md frontmatter must be a YAML mapping.",
      "malformed_skill_frontmatter",
    );
  }
  return {
    metadata,
    body: content.slice(bodyStart),
    hadFrontmatter: true,
  };
}

function deriveDescription(body) {
  const lines = String(body || "").split(/\r?\n/);
  let inFence = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (
      inFence ||
      !line ||
      /^#{1,6}(?:\s|$)/.test(line) ||
      line === "---" ||
      /^<!--/.test(line)
    ) {
      continue;
    }
    return line;
  }
  return DEFAULT_DESCRIPTION;
}

function creatorFromMetadata(metadata) {
  return (
    nonblankString(metadata?.created_by_email) ||
    nonblankString(metadata?.metadata?.created_by_email)
  );
}

function descriptiveAuthorFromMetadata(metadata) {
  return nonblankString(metadata?.author) || nonblankString(metadata?.metadata?.author);
}

function renderSkillMarkdown(metadata, body) {
  const serialized = yaml.dump(metadata, {
    noCompatMode: true,
    noRefs: true,
    lineWidth: -1,
    sortKeys: false,
  }).trimEnd();
  return `---\n${serialized}\n---\n${String(body || "")}`;
}

function canonicalizeSkillMarkdown({
  skillName,
  content,
  creatorEmail,
  existingContent = null,
  resetCreator = false,
}) {
  const canonicalName = normalizeSkillName(skillName);
  const email = nonblankString(creatorEmail);
  if (!email || !email.includes("@")) {
    throw new UserSkillError(
      "Authenticated creator identity is unavailable.",
      "missing_user_identity",
    );
  }

  const incoming = splitSkillMarkdown(content);
  const existing =
    typeof existingContent === "string" ? splitSkillMarkdown(existingContent) : null;
  const existingMetadata = existing?.metadata || {};
  const incomingMetadata = incoming.metadata || {};

  // Merge existing fields first so a plain-Markdown edit cannot accidentally
  // erase descriptive metadata. Explicit incoming frontmatter still wins.
  const merged = {
    ...existingMetadata,
    ...incomingMetadata,
  };
  if (
    existingMetadata.metadata &&
    incomingMetadata.metadata &&
    typeof existingMetadata.metadata === "object" &&
    typeof incomingMetadata.metadata === "object" &&
    !Array.isArray(existingMetadata.metadata) &&
    !Array.isArray(incomingMetadata.metadata)
  ) {
    merged.metadata = {
      ...existingMetadata.metadata,
      ...incomingMetadata.metadata,
    };
  }

  const existingCreator = creatorFromMetadata(existingMetadata);
  const createdByEmail = resetCreator ? email : existingCreator || email;
  const description =
    nonblankString(incomingMetadata.description) ||
    nonblankString(existingMetadata.description) ||
    deriveDescription(incoming.body);
  const incomingAuthor = descriptiveAuthorFromMetadata(incomingMetadata);
  const existingAuthor = descriptiveAuthorFromMetadata(existingMetadata);
  if (!incomingAuthor && existingAuthor && !merged.author && !merged.metadata?.author) {
    merged.author = existingAuthor;
  }

  delete merged.name;
  delete merged.description;
  delete merged.created_by_email;
  if (resetCreator) {
    delete merged.source;
    delete merged.marketplace_relationship;
    delete merged.marketplace_solution_id;
    delete merged.is_read_only;
    if (
      merged.metadata &&
      typeof merged.metadata === "object" &&
      !Array.isArray(merged.metadata)
    ) {
      delete merged.metadata.created_by_email;
      delete merged.metadata.source;
      delete merged.metadata.marketplace_relationship;
      delete merged.metadata.marketplace_solution_id;
      delete merged.metadata.is_read_only;
    }
  }
  const canonicalMetadata = {
    name: canonicalName,
    description,
    created_by_email: createdByEmail,
    ...merged,
  };
  // Mandatory fields remain authoritative even if an unknown object spread
  // above contained similarly named keys through a crafted prototype.
  canonicalMetadata.name = canonicalName;
  canonicalMetadata.description = description;
  canonicalMetadata.created_by_email = createdByEmail;

  return {
    content: renderSkillMarkdown(canonicalMetadata, incoming.body),
    metadata: canonicalMetadata,
    hadFrontmatter: incoming.hadFrontmatter,
    creatorBackfilled: !existingCreator,
  };
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function createUserSkillService(deps = {}) {
  const fs = deps.fsPromises || fsPromises;
  const randomUUID = deps.randomUUID || crypto.randomUUID;
  const defaultProjectRoot = deps.projectRoot || null;
  const resolveIdentity =
    deps.resolveIdentity ||
    (() => require("./creator-identity").resolveAuthenticatedCreatorIdentity());
  const markSkillLinkDirty =
    deps.markSkillLinkDirty ||
    ((skillName) =>
      require("./ai-marketplace-skill-links").markLinkDirty(skillName));
  const getSkillLink =
    deps.getSkillLink ||
    ((skillName) => require("./ai-marketplace-skill-links").getLink(skillName));
  const clearSkillLink =
    deps.clearSkillLink ||
    ((skillName) => require("./ai-marketplace-skill-links").clearLink(skillName));

  function projectRootFor(options = {}) {
    const root = options.projectRoot || defaultProjectRoot;
    if (!root) {
      return require("./bootstrap").PROJECT_ROOT;
    }
    return root;
  }

  async function authenticatedIdentity(options = {}) {
    if (options.identity) return options.identity;
    return await resolveIdentity();
  }

  async function writeTextAtomic(filePath, content) {
    const parent = path.dirname(filePath);
    const tempPath = path.join(
      parent,
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await fs.mkdir(parent, { recursive: true });
    try {
      await fs.writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function ensureSafeUserSkillDirectory(skillDir, userRoot) {
    const [dirStat, realRoot, realDir] = await Promise.all([
      fs.lstat(skillDir),
      fs.realpath(userRoot),
      fs.realpath(skillDir),
    ]);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !isPathInside(realDir, realRoot)) {
      throw new UserSkillError("User skill directory is unsafe.", "unsafe_skill_path");
    }
    const skillFile = path.join(realDir, "SKILL.md");
    const fileStat = await fs.lstat(skillFile);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new UserSkillError("User SKILL.md is unsafe.", "unsafe_skill_path");
    }
    return { realDir, skillFile };
  }

  async function ensureSafeSkillDirectory(skillDir, allowedRoot) {
    const resolvedRoot = path.resolve(allowedRoot);
    const resolvedDir = path.resolve(skillDir);
    if (!isPathInside(resolvedDir, resolvedRoot) || resolvedDir === resolvedRoot) {
      throw new UserSkillError("Source skill directory is unsafe.", "unsafe_skill_path");
    }

    const relativeParts = path.relative(resolvedRoot, resolvedDir).split(path.sep);
    let cursor = resolvedRoot;
    for (const part of ["", ...relativeParts]) {
      if (part) cursor = path.join(cursor, part);
      const stat = await fs.lstat(cursor).catch((error) => {
        throw new UserSkillError("Source skill was not found.", "skill_not_found", error);
      });
      if (stat.isSymbolicLink()) {
        throw new UserSkillError("Source skill directory is unsafe.", "unsafe_skill_path");
      }
      if (!stat.isDirectory()) {
        throw new UserSkillError("Source skill directory is unsafe.", "unsafe_skill_path");
      }
    }

    const [realRoot, realDir] = await Promise.all([
      fs.realpath(resolvedRoot),
      fs.realpath(resolvedDir),
    ]);
    if (!isPathInside(realDir, realRoot) || realDir === realRoot) {
      throw new UserSkillError("Source skill directory is unsafe.", "unsafe_skill_path");
    }

    const skillFile = path.join(realDir, "SKILL.md");
    const skillStat = await fs.lstat(skillFile).catch((error) => {
      throw new UserSkillError("Source SKILL.md was not found.", "skill_not_found", error);
    });
    if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
      throw new UserSkillError("Source SKILL.md is unsafe.", "unsafe_skill_path");
    }
    return { realDir, skillFile };
  }

  async function marketplaceSkillCandidates(root, skillName) {
    const marketplaceRoot = path.join(root, "skills-marketplace");
    let entries;
    try {
      entries = await fs.readdir(marketplaceRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const candidates = [];
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        entry.name.startsWith("_") ||
        (!entry.isDirectory() && !entry.isSymbolicLink())
      ) {
        continue;
      }
      const marketplaceDir = path.join(marketplaceRoot, entry.name);
      const candidate = path.join(marketplaceDir, skillName);
      if (await fs.lstat(candidate).then(() => true).catch(() => false)) {
        candidates.push(candidate);
      }
      // Plugin-grouped layout ({mp}/{plugin}/{skill}): the OOTB marketplaces
      // install this shape, and a bare-leaf name that matches one of those
      // skills is the same display/leaf collision the flat probe guards
      // against. A second-level dir that is itself a skill (has SKILL.md)
      // holds reference material, not skills — same parent-guard as the Rust
      // catalog's derive_skill_name.
      let pluginEntries = [];
      try {
        pluginEntries = await fs.readdir(marketplaceDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const pluginEntry of pluginEntries) {
        if (
          pluginEntry.name.startsWith(".") ||
          pluginEntry.name.startsWith("_") ||
          !pluginEntry.isDirectory()
        ) {
          continue;
        }
        const pluginDir = path.join(marketplaceDir, pluginEntry.name);
        const pluginIsSkill = await fs
          .lstat(path.join(pluginDir, "SKILL.md"))
          .then((stat) => stat.isFile())
          .catch(() => false);
        if (pluginIsSkill) continue;
        const nested = path.join(pluginDir, skillName);
        const nestedIsSkill = await fs
          .lstat(path.join(nested, "SKILL.md"))
          .then((stat) => stat.isFile())
          .catch(() => false);
        if (nestedIsSkill) candidates.push(nested);
      }
    }
    return candidates;
  }

  // excludePath: a copy that is allowed to exist — the detach/reclaim flow
  // copies a marketplace skill to skills-user, and the SOURCE copy itself
  // must not count as a name collision (it is removed right after the copy).
  async function skillNameExistsInAnySource(root, skillName, { excludePath = null } = {}) {
    const excluded = excludePath ? path.resolve(excludePath) : null;
    const directCandidates = [
      path.join(root, "skills-user", skillName),
      path.join(root, "skills", skillName),
    ];
    for (const candidate of directCandidates) {
      if (excluded && path.resolve(candidate) === excluded) continue;
      if (await fs.lstat(candidate).then(() => true).catch(() => false)) {
        return true;
      }
    }
    const marketplaceMatches = await marketplaceSkillCandidates(root, skillName);
    return marketplaceMatches.some(
      (candidate) => !excluded || path.resolve(candidate) !== excluded,
    );
  }

  async function resolveSkillSourceById(root, sourceSkillId) {
    const rawId = nonblankString(sourceSkillId);
    const parts = rawId.split("/");
    if (
      !rawId ||
      rawId.includes("\\") ||
      rawId.includes("\0") ||
      parts.length < 1 ||
      parts.length > 2
    ) {
      throw new UserSkillError(
        "A valid skill id from list_skills is required.",
        "invalid_skill_name",
      );
    }
    const normalizedParts = parts.map(normalizeSkillName);
    const candidates =
      normalizedParts.length === 1
        ? [
            path.join(root, "skills-user", normalizedParts[0]),
            path.join(root, "skills", normalizedParts[0]),
          ]
        : [
            path.join(
              root,
              "skills-marketplace",
              normalizedParts[0],
              normalizedParts[1],
            ),
          ];
    const existing = [];
    for (const candidate of candidates) {
      if (await fs.lstat(candidate).then(() => true).catch(() => false)) {
        existing.push(candidate);
      }
    }
    if (existing.length === 0) {
      throw new UserSkillError(
        `Skill '${rawId}' was not found.`,
        "skill_not_found",
      );
    }
    if (existing.length > 1) {
      throw new UserSkillError(
        `Skill id '${rawId}' resolves to multiple local sources.`,
        "ambiguous_skill_source",
      );
    }
    const allowedRoot =
      normalizedParts.length === 1
        ? path.dirname(existing[0])
        : path.join(root, "skills-marketplace");
    const safe = await ensureSafeSkillDirectory(existing[0], allowedRoot);
    return {
      sourceSkillId: normalizedParts.join("/"),
      sourcePath: safe.realDir,
    };
  }

  async function createSkill({ skillName, skillContent, projectRoot, identity } = {}) {
    const canonicalName = normalizeSkillName(skillName);
    const resolvedIdentity = await authenticatedIdentity({ identity });
    const root = projectRootFor({ projectRoot });
    const userRoot = path.join(root, "skills-user");
    const destination = path.join(userRoot, canonicalName);
    const systemDestination = path.join(root, "skills", canonicalName);

    if (await fs.access(destination).then(() => true).catch(() => false)) {
      throw new UserSkillError(
        `Skill '${canonicalName}' already exists.`,
        "skill_already_exists",
      );
    }
    if (await fs.access(systemDestination).then(() => true).catch(() => false)) {
      throw new UserSkillError(
        `Cannot create user skill '${canonicalName}' because a system skill with that name already exists.`,
        "system_skill_collision",
      );
    }

    const canonical = canonicalizeSkillMarkdown({
      skillName: canonicalName,
      content: skillContent,
      creatorEmail: resolvedIdentity.email,
      resetCreator: true,
    });
    await fs.mkdir(userRoot, { recursive: true });
    const tempDir = path.join(userRoot, `.${canonicalName}.${randomUUID()}.tmp`);
    try {
      await fs.mkdir(path.join(tempDir, "references"), { recursive: true });
      await fs.mkdir(path.join(tempDir, "scripts"), { recursive: true });
      await writeTextAtomic(path.join(tempDir, "SKILL.md"), canonical.content);
      await fs.rename(tempDir, destination);
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    // A brand-new skill was never published: drop any stale marketplace link
    // squatting on this name (left by an out-of-band delete of a previously
    // published skill), or the new skill would inherit that listing's
    // Published badge and republish over it. Best-effort — the creation
    // itself already succeeded.
    try {
      await clearSkillLink(canonicalName);
    } catch (error) {
      console.warn(
        `[UserSkills] could not clear a stale marketplace link for new skill '${canonicalName}':`,
        error?.message || error,
      );
    }

    return {
      success: true,
      skill_name: canonicalName,
      display_name: skillDisplayNameFromMetadata(canonical.metadata, canonicalName),
      path: destination,
      local_path: path.join("skills-user", canonicalName),
      created_by_email: canonical.metadata.created_by_email,
      message: `Skill '${canonicalName}' created successfully`,
    };
  }

  async function updateSkill({ skillName, skillContent, projectRoot, identity } = {}) {
    const canonicalName = normalizeSkillName(skillName);
    const resolvedIdentity = await authenticatedIdentity({ identity });
    const root = projectRootFor({ projectRoot });
    const userRoot = path.join(root, "skills-user");
    const skillDir = path.join(userRoot, canonicalName);
    let safe;
    try {
      safe = await ensureSafeUserSkillDirectory(skillDir, userRoot);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new UserSkillError(
          `Skill '${canonicalName}' was not found in skills-user.`,
          "skill_not_found",
          error,
        );
      }
      throw error;
    }
    const existingContent = await fs.readFile(safe.skillFile, "utf8");
    const incoming = splitSkillMarkdown(skillContent);
    const invalidRequiredFields = ["name", "description"].filter(
      (field) => !nonblankString(incoming.metadata?.[field]),
    );
    if (invalidRequiredFields.length) {
      throw new UserSkillError(
        "SKILL.md updates require YAML frontmatter with nonblank string " +
          "'name' and 'description' fields. Missing or invalid: " +
          `${invalidRequiredFields.join(", ")}. Required fields are not copied from the previous revision.`,
        "malformed_skill_frontmatter",
      );
    }
    const canonical = canonicalizeSkillMarkdown({
      skillName: canonicalName,
      content: skillContent,
      existingContent,
      creatorEmail: resolvedIdentity.email,
      resetCreator: false,
    });
    await writeTextAtomic(safe.skillFile, canonical.content);
    // Published skills track local divergence via the link registry; every
    // content update (control-plane editor or chat-side skills_update_skill)
    // flags it. Best-effort: a marking failure must not fail the save, and
    // markLinkDirty no-ops for unlinked skills.
    try {
      await markSkillLinkDirty(canonicalName);
    } catch (error) {
      console.warn(
        `[UserSkills] could not flag unpublished changes for '${canonicalName}':`,
        error?.message || error,
      );
    }
    return {
      success: true,
      skill_name: canonicalName,
      display_name: skillDisplayNameFromMetadata(canonical.metadata, canonicalName),
      path: safe.skillFile,
      created_by_email: canonical.metadata.created_by_email,
      message: `Skill '${canonicalName}' updated successfully`,
    };
  }

  async function copySkillToUser({
    sourcePath,
    skillName,
    projectRoot,
    identity,
  } = {}) {
    const canonicalName = normalizeSkillName(skillName);
    const resolvedIdentity = await authenticatedIdentity({ identity });
    const root = projectRootFor({ projectRoot });
    const userRoot = path.join(root, "skills-user");
    const source = path.resolve(sourcePath || "");
    const destination = path.join(userRoot, canonicalName);
    if (await skillNameExistsInAnySource(root, canonicalName, { excludePath: source })) {
      throw new UserSkillError(
        `A skill named '${canonicalName}' already exists.`,
        "skill_already_exists",
      );
    }

    const allowedRoots = [
      path.join(root, "skills"),
      path.join(root, "skills-user"),
      path.join(root, "skills-marketplace"),
    ];
    let allowedRoot = allowedRoots.find((candidate) =>
      isPathInside(source, path.resolve(candidate)),
    );
    if (!allowedRoot) {
      for (const candidate of allowedRoots) {
        const realCandidate = await fs.realpath(candidate).catch(() => null);
        if (realCandidate && isPathInside(source, realCandidate)) {
          allowedRoot = realCandidate;
          break;
        }
      }
    }
    if (!allowedRoot) {
      throw new UserSkillError("Source skill directory is unsafe.", "unsafe_skill_path");
    }
    const safeSource = await ensureSafeSkillDirectory(source, allowedRoot);

    await fs.mkdir(userRoot, { recursive: true });
    const tempDir = path.join(userRoot, `.${canonicalName}.${randomUUID()}.tmp`);
    try {
      await fs.cp(safeSource.realDir, tempDir, {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: async (entryPath) => {
          const stat = await fs.lstat(entryPath).catch(() => null);
          return Boolean(stat) && !stat.isSymbolicLink();
        },
      });
      const skillFile = path.join(tempDir, "SKILL.md");
      const original = await fs.readFile(skillFile, "utf8");
      const canonical = canonicalizeSkillMarkdown({
        skillName: canonicalName,
        content: original,
        creatorEmail: resolvedIdentity.email,
        resetCreator: true,
      });
      await writeTextAtomic(skillFile, canonical.content);
      await fs.rename(tempDir, destination);
      return {
        success: true,
        skillName: canonicalName,
        displayName: skillDisplayNameFromMetadata(canonical.metadata, canonicalName),
        localPath: path.join("skills-user", canonicalName),
        destinationPath: destination,
        created_by_email: canonical.metadata.created_by_email,
      };
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async function copySkillById({
    sourceSkillId,
    newSkillName,
    projectRoot,
    identity,
  } = {}) {
    const root = projectRootFor({ projectRoot });
    const source = await resolveSkillSourceById(root, sourceSkillId);
    const copied = await copySkillToUser({
      sourcePath: source.sourcePath,
      skillName: newSkillName,
      projectRoot: root,
      identity,
    });
    return {
      success: true,
      source_skill_id: source.sourceSkillId,
      skill_name: copied.skillName,
      display_name: copied.displayName,
      local_path: copied.localPath,
      path: copied.destinationPath,
      source: "user",
      created_by_email: copied.created_by_email,
      marketplace_relationship: null,
      marketplace_solution_id: null,
      is_read_only: false,
      message: `Created editable user copy '${copied.skillName}' from '${source.sourceSkillId}'.`,
    };
  }

  // Rename an editable, UNPUBLISHED user skill in place: directory move +
  // frontmatter `name:` rewrite. Renaming is deliberately constrained to
  // unpublished skills — a published skill's name is its marketplace listing
  // identity (link registry key, bundle payload name, installer-derived ids),
  // so rename requires unpublishing first. System skills and installed
  // marketplace copies are not renamable either — their names are owned by
  // the app / the install record. `assertRenamable` is the route-injected
  // agent-usage guard (an agent referencing the old name would silently lose
  // the skill), mirroring the delete guard.
  async function renameSkill({
    skillName,
    newSkillName,
    projectRoot,
    identity,
    assertRenamable = null,
  } = {}) {
    const canonicalOld = normalizeSkillName(skillName);
    const canonicalNew = normalizeSkillName(newSkillName);
    if (!canonicalOld || !canonicalNew) {
      throw new UserSkillError(
        "Both skill_name and new_skill_name are required.",
        "invalid_skill_name",
      );
    }
    // Case-insensitive: skill ids are ASCII kebab, and on the default
    // case-insensitive macOS filesystem a case-only rename would collide
    // with its own directory anyway — fail with the honest code instead of
    // a misleading skill_already_exists.
    if (canonicalOld.toLowerCase() === canonicalNew.toLowerCase()) {
      throw new UserSkillError(
        "The new skill name matches the current name.",
        "same_skill_name",
      );
    }
    const resolvedIdentity = await authenticatedIdentity({ identity });
    const root = projectRootFor({ projectRoot });
    const userRoot = path.join(root, "skills-user");
    const sourceDir = path.join(userRoot, canonicalOld);
    let safe;
    try {
      safe = await ensureSafeUserSkillDirectory(sourceDir, userRoot);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new UserSkillError(
          `Skill '${canonicalOld}' was not found in skills-user. Only editable user skills can be renamed.`,
          "skill_not_found",
          error,
        );
      }
      throw error;
    }
    if (await skillNameExistsInAnySource(root, canonicalNew)) {
      throw new UserSkillError(
        `A skill named '${canonicalNew}' already exists.`,
        "skill_already_exists",
      );
    }
    // POLICY: only unpublished skills are renamable. A published skill's
    // name is its listing identity; unpublish first (or keep the name).
    // Registry read failures propagate — a gate that cannot verify
    // "unpublished" must not wave the rename through.
    const publishedLink = await getSkillLink(canonicalOld);
    if (publishedLink) {
      throw new UserSkillError(
        `Skill '${canonicalOld}' is published to the AI Marketplace (solution ${publishedLink.solutionId}) and published skills cannot be renamed. Unpublish it first with unpublish_skill, then rename and republish under the new name — or keep its current name.`,
        "published_skill_rename_blocked",
      );
    }
    // A stale marketplace link squatting on the new name (its skill was
    // removed out-of-band) would otherwise make the renamed skill inherit an
    // unrelated listing's Published state. Fail closed BEFORE any mutation.
    const staleDestinationLink = await getSkillLink(canonicalNew);
    if (staleDestinationLink) {
      throw new UserSkillError(
        `A marketplace link already exists for the name '${canonicalNew}' (solution ${staleDestinationLink.solutionId}) even though no local skill uses it. Clear or republish that listing first.`,
        "skill_link_conflict",
      );
    }
    if (assertRenamable) {
      await assertRenamable(canonicalOld);
    }

    // Rewrite the frontmatter name FIRST (still at the old path — content is
    // restorable), then move the directory. A failed move leaves a valid
    // skill whose declared name is briefly ahead of its directory; the
    // reverse order would risk a moved directory with a stale name.
    const original = await fs.readFile(safe.skillFile, "utf8");
    const canonical = canonicalizeSkillMarkdown({
      skillName: canonicalNew,
      content: original,
      existingContent: original,
      creatorEmail: resolvedIdentity.email,
      resetCreator: false,
    });
    await writeTextAtomic(safe.skillFile, canonical.content);
    const destination = path.join(userRoot, canonicalNew);
    try {
      await fs.rename(safe.realDir, destination);
    } catch (error) {
      // Restore the declared name so the skill stays self-consistent.
      await writeTextAtomic(safe.skillFile, original).catch(() => {});
      throw error;
    }

    return {
      success: true,
      skill_name: canonicalNew,
      previous_skill_name: canonicalOld,
      display_name: skillDisplayNameFromMetadata(canonical.metadata, canonicalNew),
      path: destination,
      local_path: path.join("skills-user", canonicalNew),
      created_by_email: canonical.metadata.created_by_email,
      message: `Skill '${canonicalOld}' renamed to '${canonicalNew}'.`,
    };
  }

  async function reconcileUserSkills({ projectRoot, identity } = {}) {
    const resolvedIdentity = await authenticatedIdentity({ identity });
    const root = projectRootFor({ projectRoot });
    const userRoot = path.join(root, "skills-user");
    let entries;
    try {
      entries = await fs.readdir(userRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          checked: 0,
          repaired_ids: [],
          skipped_ids: [],
          canonicalized_ids: [],
          creator_backfilled_ids: [],
          failures: [],
        };
      }
      throw error;
    }

    const repairedIds = [];
    const skippedIds = [];
    const canonicalizedIds = [];
    const creatorBackfilledIds = [];
    const failures = [];
    const candidates = entries
      .filter(
        (entry) =>
          !entry.name.startsWith(".") &&
          !entry.name.startsWith("_") &&
          (entry.isDirectory() || entry.isSymbolicLink()),
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of candidates) {
      const skillId = entry.name;
      const skillDir = path.join(userRoot, skillId);
      try {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new UserSkillError("User skill entry is unsafe.", "unsafe_skill_path");
        }
        const safe = await ensureSafeUserSkillDirectory(skillDir, userRoot);
        const original = await fs.readFile(safe.skillFile, "utf8");
        const parsedOriginal = splitSkillMarkdown(original);
        const originalCreator = creatorFromMetadata(parsedOriginal.metadata);
        const canonical = canonicalizeSkillMarkdown({
          skillName: skillId,
          content: original,
          existingContent: original,
          creatorEmail: resolvedIdentity.email,
          resetCreator: false,
        });
        if (canonical.content === original) {
          skippedIds.push(skillId);
          continue;
        }
        await writeTextAtomic(safe.skillFile, canonical.content);
        repairedIds.push(skillId);
        if (!parsedOriginal.hadFrontmatter || !nonblankString(parsedOriginal.metadata?.name) || !nonblankString(parsedOriginal.metadata?.description)) {
          canonicalizedIds.push(skillId);
        }
        if (!originalCreator) creatorBackfilledIds.push(skillId);
      } catch (error) {
        failures.push({
          id: skillId,
          code: error?.code || "user_skill_reconciliation_failed",
          error: error?.message || "User skill reconciliation failed.",
        });
      }
    }

    return {
      checked: candidates.length,
      repaired_ids: repairedIds,
      skipped_ids: skippedIds,
      canonicalized_ids: canonicalizedIds,
      creator_backfilled_ids: creatorBackfilledIds,
      failures,
    };
  }

  return {
    copySkillById,
    copySkillToUser,
    createSkill,
    reconcileUserSkills,
    renameSkill,
    updateSkill,
    writeTextAtomic,
  };
}

module.exports = {
  DEFAULT_DESCRIPTION,
  MAX_SKILL_CONTENT_CHARS,
  UserSkillError,
  canonicalizeSkillMarkdown,
  createUserSkillService,
  deriveDescription,
  splitSkillMarkdown,
  ...createUserSkillService(),
};
