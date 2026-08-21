const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

function ensureShellMethod(shellLike, methodName) {
  if (!shellLike || typeof shellLike[methodName] !== "function") {
    throw new TypeError(`shell.${methodName} is required`);
  }
}

function normalizeHttpExternalUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new TypeError("URL must be a non-empty string");
  }

  const parsed = new URL(rawUrl.trim());
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Protocol not allowed: ${parsed.protocol}`);
  }

  return parsed.toString();
}

function openHttpExternalUrl(shellLike, rawUrl) {
  ensureShellMethod(shellLike, "openExternal");
  return shellLike.openExternal(normalizeHttpExternalUrl(rawUrl));
}

function normalizeLocalPath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new TypeError("Path must be a non-empty string");
  }

  const resolved = path.resolve(rawPath.trim());
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }

  return resolved;
}

async function openLocalPath(shellLike, rawPath) {
  ensureShellMethod(shellLike, "openPath");
  const resolvedPath = normalizeLocalPath(rawPath);
  const result = await shellLike.openPath(resolvedPath);
  if (typeof result === "string" && result.length > 0) {
    throw new Error(result);
  }
  return resolvedPath;
}

function isPrivateIpv4Address(hostname) {
  const octets = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [first, second] = octets;
  if (first === 10 || first === 127) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 0) {
    return true;
  }

  return false;
}

function isPrivateIpv6Address(hostname) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

function validateProbeUrl(rawUrl) {
  const normalizedUrl = normalizeHttpExternalUrl(rawUrl);
  const parsed = new URL(normalizedUrl);
  const hostname = parsed.hostname.toLowerCase();

  if (hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error("Local addresses are not allowed");
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4 && isPrivateIpv4Address(hostname)) {
    throw new Error("Private IPv4 addresses are not allowed");
  }
  if (ipVersion === 6 && isPrivateIpv6Address(hostname)) {
    throw new Error("Private IPv6 addresses are not allowed");
  }

  return parsed;
}

module.exports = {
  normalizeHttpExternalUrl,
  normalizeLocalPath,
  openHttpExternalUrl,
  openLocalPath,
  validateProbeUrl,
};
