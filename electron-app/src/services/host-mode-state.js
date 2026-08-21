const fs = require("fs");

function parseHostModeValue(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function readHostModeFileSync(hostModePath, fsImpl = fs) {
  try {
    return parseHostModeValue(fsImpl.readFileSync(hostModePath, "utf8"));
  } catch (_error) {
    return false;
  }
}

async function readHostModeFile(hostModePath, fsPromisesImpl = fs.promises) {
  try {
    return parseHostModeValue(await fsPromisesImpl.readFile(hostModePath, "utf8"));
  } catch (_error) {
    return false;
  }
}

module.exports = {
  parseHostModeValue,
  readHostModeFile,
  readHostModeFileSync,
};
