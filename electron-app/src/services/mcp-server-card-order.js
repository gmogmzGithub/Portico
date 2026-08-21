(function (root, factory) {
  const exported = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = exported;
  }

  if (root) {
    root.mcpServerCardOrder = exported;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const ENABLED_STATUS_PRIORITY = Object.freeze({
    starting: 0,
    checking: 1,
    failed: 2,
    timeout: 3,
    not_running: 4,
    needs_oauth: 5,
    healthy: 6,
    disabled: 7,
    unknown: 8,
  });

  function getServerDisplayName(entry) {
    const server = entry?.server || entry || {};
    return (
      server.display_name ||
      server.displayName ||
      server.name ||
      entry?.name ||
      ""
    );
  }

  function compareServerNames(a, b) {
    return getServerDisplayName(a).localeCompare(getServerDisplayName(b));
  }

  function getEnabledStatusPriority(status) {
    return ENABLED_STATUS_PRIORITY[status] ?? ENABLED_STATUS_PRIORITY.unknown;
  }

  function compareEnabledEntries(a, b) {
    const priorityA = getEnabledStatusPriority(a?.healthStatus);
    const priorityB = getEnabledStatusPriority(b?.healthStatus);

    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }

    const isCoreA = Boolean(a?.isCore ?? a?.server?.isCore);
    const isCoreB = Boolean(b?.isCore ?? b?.server?.isCore);
    if (isCoreA !== isCoreB) {
      return isCoreA ? -1 : 1;
    }

    return compareServerNames(a, b);
  }

  function getGridEntryPriority(entry) {
    if (entry?.missingSetup) {
      return 4;
    }
    if (entry?.setupAction === "authenticate") {
      return 0;
    }
    if (entry?.setupAction === "configure") {
      return 1;
    }
    if (entry?.enabled) {
      return 2;
    }
    return 3;
  }

  function compareGridEntries(a, b) {
    const priorityA = getGridEntryPriority(a);
    const priorityB = getGridEntryPriority(b);
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }

    if (priorityA === 2) {
      return compareEnabledEntries(a, b);
    }

    return compareServerNames(a, b);
  }

  function partitionMcpServerGridEntries(entries) {
    const configuredEnabled = [];
    const configuredDisabled = [];
    const configuredMissingSetup = [];
    const unconfigured = [];
    const normalizedEntries = Array.isArray(entries) ? entries : [];

    for (const entry of normalizedEntries) {
      if (!entry?.configured) {
        unconfigured.push(entry);
        continue;
      }

      if (entry.missingSetup) {
        configuredMissingSetup.push(entry);
        continue;
      }

      if (entry.enabled) {
        configuredEnabled.push(entry);
        continue;
      }

      configuredDisabled.push(entry);
    }

    configuredEnabled.sort(compareEnabledEntries);
    configuredDisabled.sort(compareServerNames);
    configuredMissingSetup.sort(compareServerNames);
    unconfigured.sort(compareServerNames);

    return {
      configuredEnabled,
      unconfigured,
      configuredDisabled,
      configuredMissingSetup,
      ordered: [...normalizedEntries].sort(compareGridEntries),
    };
  }

  return {
    ENABLED_STATUS_PRIORITY,
    getServerDisplayName,
    getEnabledStatusPriority,
    compareEnabledEntries,
    getGridEntryPriority,
    compareGridEntries,
    compareServerNames,
    partitionMcpServerGridEntries,
  };
});
