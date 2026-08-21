// PORTICO PATCH (Round 4 / Issue 4): pure clustering helper for the
// pending-tool-confirmation chip stack.
//
// The chip stack groups pending chips by ``(tool_name, mcp)`` so a
// "delete 100 tasks" scenario (one chip per task) renders as ONE
// collapsible cluster with bulk Approve / Cancel buttons rather than
// 100 individually-clickable chips.
//
// This module is plain JavaScript (no TypeScript) so the Node-based
// frontend tests can dynamic-``import()`` it without a Svelte / TS
// toolchain. The Svelte component (``ChipClusterGroup.svelte``)
// imports the named exports directly.
//
// Module shape: native ESM. Upstream OWUI's frontend package.json
// declares ``"type": "module"`` so Vite/Rollup parses ``.js`` files
// as ESM during ``npm run build`` (verified by the round-4 install
// failure that surfaced when this file was previously CommonJS).
// The Node tests load it via ``await import(...)`` inside a
// ``before`` hook to bridge the CJS/ESM gap.
//
// Cross-references:
// - tests/test_tool_confirmation_chip.node.test.js (Round 4 cluster tests)
// - docs/architecture/chip-system.md "Stacked / clustered chips"
// - threat-model item N-012 (no security changes — this only changes
//   how chips are PRESENTED; per-chip approval still flows through
//   ``POST /api/v1/utils/chip/resolve`` exactly as before).

export const CHIP_CLUSTER_COLLAPSE_THRESHOLD_DEFAULT = 6;

/**
 * Group pending chips by (tool_name, mcp). Returns an array of
 * cluster descriptors in stable insertion order. Each cluster carries
 * an ``is_collapsible`` flag indicating whether the renderer should
 * collapse it behind a header.
 *
 * @param {Array<{hash:string, tool_name?:string, mcp?:string, state?:string}>} chips
 * @param {number} [threshold]
 * @returns {Array<{cluster_key:string, tool_name:string, mcp:string, chips:Array<object>, is_collapsible:boolean}>}
 */
export function clusterPendingChips(chips, threshold) {
  if (!Array.isArray(chips)) {
    return [];
  }
  const limit =
    typeof threshold === "number" && threshold > 0
      ? threshold
      : CHIP_CLUSTER_COLLAPSE_THRESHOLD_DEFAULT;

  const buckets = new Map();
  const order = [];
  for (const chip of chips) {
    if (!chip || typeof chip !== "object") {
      continue;
    }
    const tool = String(chip.tool_name || "").trim();
    const mcp = String(chip.mcp || "").trim();
    // The cluster key includes both fields; chips with NEITHER (e.g.
    // a generic clarification chip) get clustered under a single
    // "(unknown)|(unknown)" bucket so the user still gets the
    // grouping benefit.
    const key = `${tool}|${mcp}`;
    if (!buckets.has(key)) {
      buckets.set(key, { tool_name: tool, mcp, chips: [] });
      order.push(key);
    }
    buckets.get(key).chips.push(chip);
  }

  return order.map((key) => {
    const bucket = buckets.get(key);
    return {
      cluster_key: key,
      tool_name: bucket.tool_name,
      mcp: bucket.mcp,
      chips: bucket.chips,
      is_collapsible: bucket.chips.length >= limit,
    };
  });
}

/**
 * Return only the chips inside a cluster that are still resolvable
 * (``state`` is ``pending`` or unset). Bulk-approve / bulk-cancel must
 * skip already-resolved chips so a click doesn't clobber prior user
 * decisions.
 *
 * @param {{chips: Array<{state?:string}>}} cluster
 * @returns {Array<object>}
 */
export function pendingChipsInCluster(cluster) {
  if (!cluster || !Array.isArray(cluster.chips)) {
    return [];
  }
  return cluster.chips.filter((chip) => {
    const state = String(chip.state || "pending");
    return state === "pending";
  });
}
