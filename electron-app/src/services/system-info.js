const os = require("os");
const { execFileSync } = require("child_process");

function safeExec(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: options.timeout || 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (_) {
    return "";
  }
}

function physicalCpuCores(platform = process.platform) {
  if (platform === "darwin") {
    const value = Number.parseInt(safeExec("sysctl", ["-n", "hw.physicalcpu"]), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
}

function macCpuFamily(arch = process.arch, platform = process.platform) {
  if (platform !== "darwin") {
    return null;
  }
  if (arch === "arm64") {
    return "apple_silicon";
  }
  const arm64Capable = safeExec("sysctl", ["-n", "hw.optional.arm64"]) === "1";
  return arm64Capable ? "apple_silicon_rosetta" : "intel";
}

function parseDarwinGpuSummary(raw) {
  if (!raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    const displays = Array.isArray(parsed.SPDisplaysDataType)
      ? parsed.SPDisplaysDataType
      : [];
    return displays.map((entry) => ({
      name: entry.sppci_model || entry._name || null,
      cores: entry.sppci_cores || null,
      vram: entry.spdisplays_vram || entry.spdisplays_vram_shared || null,
      metal: entry.spdisplays_metal || null,
    }));
  } catch (_) {
    return [];
  }
}

function gpuSummary(platform = process.platform) {
  if (platform !== "darwin") {
    return [];
  }
  return parseDarwinGpuSummary(
    safeExec("system_profiler", ["SPDisplaysDataType", "-json"], { timeout: 3000 }),
  );
}

function collectSystemInformation() {
  const cpus = os.cpus() || [];
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  const platform = process.platform;
  const arch = process.arch;
  return {
    os: {
      platform,
      release: os.release(),
      type: os.type(),
    },
    cpu: {
      architecture: arch,
      family: macCpuFamily(arch, platform),
      model: cpus[0]?.model || null,
      logical_cores: cpus.length,
      physical_cores: physicalCpuCores(platform),
    },
    memory: {
      total_bytes: totalMemoryBytes,
      free_bytes: freeMemoryBytes,
      total_gb: Math.round((totalMemoryBytes / 1024 ** 3) * 10) / 10,
      free_gb: Math.round((freeMemoryBytes / 1024 ** 3) * 10) / 10,
    },
    gpu: gpuSummary(platform),
  };
}

module.exports = {
  collectSystemInformation,
  macCpuFamily,
  parseDarwinGpuSummary,
};
