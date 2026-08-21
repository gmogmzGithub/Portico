const SINGLE_SERVER_COMPOSE_PROJECT = "portico-single";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function parseContainerNames(stdout) {
  return [
    ...new Set(
      String(stdout || "")
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function inferSingleServerId(containerNames, fallbackServerId) {
  for (const containerName of containerNames) {
    const match = /^mcpo-single-(?!nginx$)([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(
      containerName,
    );
    if (match) {
      return match[1];
    }
  }
  return String(fallbackServerId || "unknown");
}

async function listAppOwnedSingleServerContainers(options) {
  const { exec, projectRoot, env, timeoutMs = 10_000 } = options;
  const command =
    `(docker ps -a --filter "label=com.docker.compose.project=${SINGLE_SERVER_COMPOSE_PROJECT}" --format '{{.Names}}'; ` +
    `docker ps -a --filter "name=mcpo-single-" --format '{{.Names}}') | sort -u`;
  const result = await exec(command, {
    cwd: projectRoot,
    env,
    timeout: timeoutMs,
  });
  return parseContainerNames(result?.stdout);
}

/**
 * Reclaim a single-server stack left behind by a prior renderer/app lifetime.
 *
 * The fixed OAuth callback port is intentionally not reclaimed generically.
 * Cleanup is allowed only when Docker proves that an Portico-owned
 * single-server container still exists. An unrelated process on the port is
 * left untouched and the normal callback-port policy fails closed later.
 */
async function cleanupOrphanedSingleServerStack(options) {
  const {
    exec,
    projectRoot,
    scriptPath,
    requestedServerId,
    env,
    listContainers = listAppOwnedSingleServerContainers,
  } = options;

  let containerNames;
  try {
    containerNames = await listContainers({ exec, projectRoot, env });
  } catch (error) {
    return {
      cleaned: false,
      inspectionError: error.message,
    };
  }

  if (containerNames.length === 0) {
    return { cleaned: false, containerNames: [] };
  }

  const orphanedServerId = inferSingleServerId(
    containerNames,
    requestedServerId,
  );
  await exec(
    `bash ${shellQuote(scriptPath)} ${shellQuote(orphanedServerId)} --stop`,
    {
      cwd: projectRoot,
      env,
      timeout: 60_000,
    },
  );

  const remainingContainerNames = await listContainers({
    exec,
    projectRoot,
    env,
  });
  if (remainingContainerNames.length > 0) {
    throw new Error(
      `Unable to remove the abandoned Portico single-server stack (${remainingContainerNames.join(
        ", ",
      )})`,
    );
  }

  return {
    cleaned: true,
    orphanedServerId,
    containerNames,
  };
}

module.exports = {
  SINGLE_SERVER_COMPOSE_PROJECT,
  cleanupOrphanedSingleServerStack,
  inferSingleServerId,
  listAppOwnedSingleServerContainers,
  parseContainerNames,
};
