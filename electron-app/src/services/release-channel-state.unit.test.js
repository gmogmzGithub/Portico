const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  readReleaseChannelInfo,
  seedReleaseChannelFromPackage,
  writeReleaseChannelSelection,
} = require("./release-channel-state");

function makeProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "release-channel-state-"));
}

test("custom selection is written canonically and restored across reads", () => {
  const projectRoot = makeProjectRoot();
  const selected = writeReleaseChannelSelection(projectRoot, "  Team-Alpha  ");

  assert.equal(selected.name, "team-alpha");
  assert.equal(
    fs.readFileSync(path.join(projectRoot, "UPDATE_CHANNEL"), "utf8"),
    "portico_team-alpha\n",
  );
  assert.equal(
    fs.statSync(path.join(projectRoot, "UPDATE_CHANNEL")).mode & 0o777,
    0o600,
  );
  assert.deepEqual(readReleaseChannelInfo(projectRoot), selected);
  assert.deepEqual(
    fs.readdirSync(projectRoot).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("Stable removes persisted selection while malformed content fails safely to Stable", () => {
  const projectRoot = makeProjectRoot();
  const updateChannelPath = path.join(projectRoot, "UPDATE_CHANNEL");
  writeReleaseChannelSelection(projectRoot, "beta");
  writeReleaseChannelSelection(projectRoot, "stable");
  assert.equal(fs.existsSync(updateChannelPath), false);

  fs.writeFileSync(updateChannelPath, "../../unsafe\n", "utf8");
  let invalidValue = null;
  const channelInfo = readReleaseChannelInfo(projectRoot, {
    onInvalid(value) {
      invalidValue = value;
    },
  });
  assert.equal(invalidValue, "../../unsafe");
  assert.equal(channelInfo.kind, "stable");
});

test("safe legacy package values remain custom and new writes use the canonical prefix", () => {
  const projectRoot = makeProjectRoot();
  const updateChannelPath = path.join(projectRoot, "UPDATE_CHANNEL");
  fs.writeFileSync(updateChannelPath, "historicalTeam_7\n", "utf8");

  assert.deepEqual(readReleaseChannelInfo(projectRoot), {
    name: "historicalTeam_7",
    packageName: "historicalTeam_7",
    kind: "custom",
    label: "historicalTeam_7",
    custom: true,
    legacy: true,
  });

  writeReleaseChannelSelection(projectRoot, "historical-team-7");
  assert.equal(
    fs.readFileSync(updateChannelPath, "utf8"),
    "portico_historical-team-7\n",
  );
});

test("packaged custom metadata seeds only an absent UPDATE_CHANNEL file", () => {
  const projectRoot = makeProjectRoot();
  const updateChannelPath = path.join(projectRoot, "UPDATE_CHANNEL");

  assert.equal(
    seedReleaseChannelFromPackage(projectRoot, "portico_team-alpha"),
    true,
  );
  assert.equal(fs.readFileSync(updateChannelPath, "utf8"), "portico_team-alpha\n");
  assert.equal(seedReleaseChannelFromPackage(projectRoot, "portico_beta"), false);
  assert.equal(fs.readFileSync(updateChannelPath, "utf8"), "portico_team-alpha\n");
});
