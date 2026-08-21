// AI Marketplace visibility (allowed_emails) policy.
// Agent Skills layer: the single home of the dependent-skill audience policy.
// Pure and dependency-free by design — required from main-process operations
// and from node:test without Electron; the renderer never computes ACLs.
//
// Policy (widening-only): a dependent skill listing's allowed_emails is the
// UNION of the listing's current marketplace ACL and the audience of the agent
// being (re)published, with PUBLIC absorbing — the backend treats an empty
// list as "everyone at Portico", so if either side is already public the union
// is public. The current marketplace ACL (fetched owner-scoped at write time,
// never the local link registry) is the accumulator that makes the union hold
// across multiple publishing agents over time. Narrowing an audience is
// deliberately out of scope: it cannot be expressed here and requires
// unpublishing the listing.

function normalizeAllowedEmailList(value) {
  const seen = new Set();
  const emails = [];
  for (const raw of Array.isArray(value) ? value : []) {
    if (typeof raw !== "string") continue;
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  emails.sort();
  return emails;
}

// currentAllowedEmails: null/undefined = no existing listing (a create);
// [] = an existing listing that is public. audiences entries are audience
// contributions to union in; a null entry contributes nothing (an
// ACL-agnostic caller, e.g. a standalone chat republish preserving the
// accumulated audience). `changed` compares against the normalized current
// list and is always false for creates — there is nothing to drift from.
function computeEffectiveAllowedEmails({
  currentAllowedEmails = null,
  audiences = [],
} = {}) {
  const hasCurrent = Array.isArray(currentAllowedEmails);
  const current = normalizeAllowedEmailList(currentAllowedEmails);
  const contributions = (Array.isArray(audiences) ? audiences : [])
    .filter((entry) => Array.isArray(entry))
    .map(normalizeAllowedEmailList);

  const isPublic =
    (hasCurrent && current.length === 0) ||
    contributions.some((entry) => entry.length === 0);

  const allowedEmails = isPublic
    ? []
    : normalizeAllowedEmailList([
        ...current,
        ...contributions.flat(),
      ]);
  const changed =
    hasCurrent &&
    (allowedEmails.length !== current.length ||
      allowedEmails.some((email, index) => email !== current[index]));
  return { allowedEmails, changed };
}

module.exports = {
  computeEffectiveAllowedEmails,
  normalizeAllowedEmailList,
};
