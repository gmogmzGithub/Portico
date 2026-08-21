const fsPromises = require("node:fs/promises");
const path = require("node:path");

function extractSkillFrontmatter(markdown) {
  if (typeof markdown !== "string") {
    return null;
  }

  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  return frontmatterMatch ? frontmatterMatch[1] : null;
}

function parseSkillFrontmatter(frontmatter) {
  if (typeof frontmatter !== "string" || frontmatter.trim() === "") {
    return null;
  }

  const yaml = require("js-yaml");
  // Malformed user-authored YAML degrades to "no frontmatter" — one broken
  // skill must never depend on every caller wrapping this in try/catch.
  let parsed;
  try {
    parsed = yaml.load(frontmatter, { json: true });
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  return parsed;
}

function parseSkillMarkdownFrontmatter(markdown) {
  const frontmatter = extractSkillFrontmatter(markdown);
  if (!frontmatter) {
    return null;
  }

  return parseSkillFrontmatter(frontmatter);
}

function buildSiblingYamlTriggers(metadata) {
  const triggers = [];
  for (const key of ["topic", "domain"]) {
    const value = metadata?.[key];
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (!normalized || triggers.includes(normalized)) {
      continue;
    }
    triggers.push(normalized);
  }
  return triggers;
}

function applySkillDisplayAcronyms(displayName) {
  // Lockstep with skill-card-renderer.js applySkillCardAcronyms and rust
  // skills_catalog.rs format_skill_display_name.
  return String(displayName || "").replace(
    /\b(Lm|Mcp|Api|Url|Ui|Ai|Id|Gtm|Qa|Icp)\b/g,
    (match) => match.toUpperCase(),
  );
}

function formatSkillDisplayName(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const formatted = raw
    .replace(/[-_/]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");

  return applySkillDisplayAcronyms(formatted);
}

function synthesizePlainMarkdownMetadata(skillDirPath, content) {
  const skillName = path.basename(String(skillDirPath || "").trim());
  if (!skillName) {
    return null;
  }

  const lines = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const heading = lines.find((line) => /^#\s+/.test(line));
  const displayName = heading ? heading.replace(/^#\s+/, "").trim() : "";
  const descriptionLine = lines.find(
    (line) => !/^#\s+/.test(line) && !/^---$/.test(line),
  );

  return {
    name: skillName,
    ...(displayName ? { display_name: displayName } : {}),
    description: descriptionLine || "Imported marketplace skill",
    priority: "medium",
    triggers: [],
  };
}

async function parseSkillDirectoryMetadata(skillDirPath) {
  if (typeof skillDirPath !== "string" || skillDirPath.trim() === "") {
    return null;
  }

  const skillMdPath = path.join(skillDirPath, "SKILL.md");
  const content = await fsPromises.readFile(skillMdPath, "utf8");
  const inlineFrontmatter = parseSkillMarkdownFrontmatter(content);
  const siblingYamlPath = path.join(
    skillDirPath,
    `${path.basename(skillDirPath)}.yaml`,
  );

  let siblingYaml;
  try {
    siblingYaml = await fsPromises.readFile(siblingYamlPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (inlineFrontmatter) {
        return inlineFrontmatter;
      }
      return synthesizePlainMarkdownMetadata(skillDirPath, content);
    }
    throw error;
  }

  const parsedSiblingYaml = parseSkillFrontmatter(siblingYaml);
  if (!parsedSiblingYaml) {
    return inlineFrontmatter || null;
  }

  if (inlineFrontmatter) {
    const merged = { ...inlineFrontmatter };
    if (
      typeof parsedSiblingYaml.display_name === "string" &&
      parsedSiblingYaml.display_name.trim() &&
      !merged.display_name
    ) {
      merged.display_name = parsedSiblingYaml.display_name.trim();
    }
    if (
      typeof parsedSiblingYaml.description === "string" &&
      parsedSiblingYaml.description.trim() &&
      !merged.description
    ) {
      merged.description = parsedSiblingYaml.description.trim();
    }
    if (
      typeof parsedSiblingYaml.owner === "string" &&
      parsedSiblingYaml.owner.trim() &&
      !merged.author
    ) {
      merged.author = parsedSiblingYaml.owner.trim();
    }
    return merged;
  }

  const skillName =
    typeof parsedSiblingYaml.skill_name === "string"
      ? parsedSiblingYaml.skill_name.trim()
      : "";
  const description =
    typeof parsedSiblingYaml.description === "string"
      ? parsedSiblingYaml.description.trim()
      : "";
  if (!skillName || !description) {
    return null;
  }

  const author =
    typeof parsedSiblingYaml.owner === "string"
      ? parsedSiblingYaml.owner.trim()
      : "";
  const displayName =
    typeof parsedSiblingYaml.display_name === "string"
      ? parsedSiblingYaml.display_name.trim()
      : "";

  const metadata = {
    name: skillName,
    description,
    priority: "medium",
    triggers: buildSiblingYamlTriggers(parsedSiblingYaml),
  };

  if (author) {
    metadata.author = author;
  }
  if (displayName) {
    metadata.display_name = displayName;
  }

  return metadata;
}

function getSkillVersionFromFrontmatter(frontmatter, fallbackVersion = "1.0") {
  return (
    frontmatter?.metadata?.version ||
    frontmatter?.version ||
    fallbackVersion
  );
}

module.exports = {
  buildSiblingYamlTriggers,
  extractSkillFrontmatter,
  formatSkillDisplayName,
  parseSkillFrontmatter,
  parseSkillDirectoryMetadata,
  parseSkillMarkdownFrontmatter,
  getSkillVersionFromFrontmatter,
};
