function buildAutoHealRestartGroups(candidates = []) {
  const hostCandidates = [];
  const groups = [];

  for (const candidate of candidates) {
    if (!candidate || !candidate.serverId) {
      continue;
    }

    const deployment = String(candidate.serverInfo?.deployment || "").toLowerCase();
    if (deployment === "host") {
      hostCandidates.push(candidate);
      continue;
    }

    groups.push({
      kind: "server",
      candidates: [candidate],
      serverIds: [candidate.serverId],
    });
  }

  if (hostCandidates.length > 0) {
    groups.unshift({
      kind: "host",
      candidates: hostCandidates,
      serverIds: hostCandidates.map((candidate) => candidate.serverId),
    });
  }

  return groups;
}

module.exports = {
  buildAutoHealRestartGroups,
};
