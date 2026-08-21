// model-logo-badge.js — renders the animated model logo used by native Electron
// input modals so they match the inline chat logo (ResponseMessage.svelte).
//
// The inline logo lives in the OWUI webview (a separate document) and cannot be
// imported here, so the motion math (modelLogoMotion.ts) and the animated Claude
// / Terra marks (AnimatedClaudeLogo.svelte / AnimatedTerraLogo.svelte) are ported
// to vanilla JS below, and the keyframes are duplicated in model-logo-badge.css.
// Keep in sync with those sources.
//
// Global API:
//   renderModelLogoBadge(badgeEl, identity, { seed })
//   ModelLogoBadge.{ resolveMotionKind, getMotionStyle, getClaudeTier,
//                    buildClaudeMark, buildTerraMark }
// `identity` fields (all optional): brandFamily ('claude'|'openai'|'google'|
//   'other'), celestialIdentity ('sol'|'terra'|'luna'|null), isLocal, logoName,
//   logoModelId, logoDataUrl, needsDarkBadge, fallbackText.
(function () {
  "use strict";

  // ---- motion math (ported from modelLogoMotion.ts) ----------------------

  const stableHash = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  };
  const sampleUnit = (seed, salt) => stableHash(`${salt}:${seed}`) / 0xffffffff;
  const sampleRange = (seed, salt, minimum, maximum) =>
    minimum + sampleUnit(seed, salt) * (maximum - minimum);
  const seconds = (value) => `${value.toFixed(2)}s`;

  const getClaudeTier = (name) => {
    const haystack = `${name || ""}`.toLowerCase();
    if (haystack.includes("opus")) return "opus";
    if (haystack.includes("haiku")) return "haiku";
    return "sonnet";
  };

  // Resolve the motion "kind" from already-resolved branding fields. Mirrors
  // getStreamingModelLogoMotionKind (celestial → family), sans the model catalog.
  const resolveMotionKind = (identity) => {
    if (!identity || typeof identity !== "object") return "other";
    if (identity.isLocal) return "local";
    const celestial = identity.celestialIdentity;
    if (celestial === "sol" || celestial === "terra" || celestial === "luna") {
      return celestial;
    }
    switch (identity.brandFamily) {
      case "claude":
        return "claude";
      case "google":
        return "gemini";
      case "openai":
        return "gpt";
      default:
        return "other";
    }
  };

  const getMotionVariables = (seedValue, kind, claudeTier) => {
    const seed = `${seedValue == null ? "" : seedValue}:${kind}`;
    const strength = claudeTier || "sonnet";
    const breatheDuration = sampleRange(
      seed,
      "breathe-duration",
      kind === "sol" ? 6.5 : kind === "claude" ? 14 : 3.35,
      kind === "sol" ? 9.25 : kind === "claude" ? 20 : 5.2,
    );
    const spinDuration = sampleRange(
      seed,
      "spin-duration",
      kind === "sol" ? 22 : kind === "terra" ? 16 : kind === "claude" ? 44 : 11.8,
      kind === "sol" ? 31 : kind === "terra" ? 22 : kind === "claude" ? 62 : 18.4,
    );
    const glowDuration = sampleRange(
      seed,
      "glow-duration",
      kind === "sol" ? 7.5 : kind === "claude" ? 12 : kind === "terra" ? 7 : 2.7,
      kind === "sol" ? 10.5 : kind === "claude" ? 18 : kind === "terra" ? 10 : 4.7,
    );
    const terraFlourishDuration = spinDuration / 0.41;
    return {
      "--model-logo-breathe-duration": seconds(breatheDuration),
      "--model-logo-spin-duration": seconds(spinDuration),
      "--model-logo-glow-duration": seconds(glowDuration),
      "--model-logo-breathe-delay": seconds(-sampleRange(seed, "breathe-delay", 0, breatheDuration)),
      "--model-logo-spin-delay": seconds(-sampleRange(seed, "spin-delay", 0, spinDuration)),
      "--model-logo-glow-delay": seconds(-sampleRange(seed, "glow-delay", 0, glowDuration)),
      "--model-logo-terra-flourish-duration": seconds(terraFlourishDuration),
      "--model-logo-terra-flourish-delay": seconds(
        -sampleRange(seed, "terra-flourish-delay", 0, terraFlourishDuration),
      ),
      "--model-logo-travel": `${sampleRange(seed, "travel", 1.2, 2.4).toFixed(2)}px`,
      "--model-logo-sweep-direction": sampleUnit(seed, "sweep-direction") >= 0.5 ? "normal" : "reverse",
      "--model-logo-claude-ray-peak": strength === "opus" ? "1.28" : strength === "haiku" ? "1.07" : "1.16",
      "--model-logo-claude-breathe-peak": strength === "opus" ? "1.085" : strength === "haiku" ? "1.025" : "1.055",
      "--model-logo-claude-cycle-delay": seconds(-sampleRange(seed, "claude-cycle-delay", 0, 12)),
      "--model-logo-halo-peak": strength === "opus" ? "0.82" : strength === "haiku" ? "0.34" : "0.58",
      "--model-logo-halo-scale": strength === "opus" ? "1.28" : strength === "haiku" ? "1.08" : "1.16",
    };
  };

  const getMotionStyle = (seedValue, kind, claudeTier) =>
    Object.entries(getMotionVariables(seedValue, kind, claudeTier))
      .map(([property, value]) => `${property}: ${value}`)
      .join("; ");

  // ---- animated marks (ported from AnimatedClaudeLogo/AnimatedTerraLogo) ---

  const escapeAttr = (value) =>
    `${value == null ? "" : value}`.replace(/[^a-zA-Z0-9_-]/g, "-");

  const CLAUDE_SYMBOL_PATH =
    "m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z";
  const CLAUDE_RAY_ANGLES = [-179, -146, -124, -87, -55, -24, 11, 39, 77, 101, 126, 148];
  const CLAUDE_HAIKU_GROUPS = [4, 1, 9, 6, 12, 3, 8, 11, 2, 7, 10, 5];
  const CLAUDE_SONNET_GROUPS = [3, 1, 5, 2, 4, 1, 3, 5, 2, 4, 3, 5];
  const CLAUDE_RAY_DIRECTIONS = ["out", "in", "out", "out", "in", "out", "in", "out", "out", "in", "out", "out"];
  const CLAUDE_OPUS_GROUPS = [[2], [1], [3], [2], [1, 4], [3], [4], [1], [3], [2], [4], [1]];

  const claudePolarPoint = (angle, radius = 90) => {
    const radians = (angle * Math.PI) / 180;
    return `${50 + Math.sin(radians) * radius} ${50 - Math.cos(radians) * radius}`;
  };

  const buildClaudeMark = (tier, uid) => {
    const marker = escapeAttr(uid || "modal");
    const rays = CLAUDE_RAY_ANGLES.map((angle, index) => {
      const previous = index === 0 ? CLAUDE_RAY_ANGLES[CLAUDE_RAY_ANGLES.length - 1] - 360 : CLAUDE_RAY_ANGLES[index - 1];
      const next = index === CLAUDE_RAY_ANGLES.length - 1 ? CLAUDE_RAY_ANGLES[0] + 360 : CLAUDE_RAY_ANGLES[index + 1];
      const start = (previous + angle) / 2;
      const end = (angle + next) / 2;
      return {
        angle,
        haikuGroup: CLAUDE_HAIKU_GROUPS[index],
        sonnetGroup: CLAUDE_SONNET_GROUPS[index],
        opusGroups: CLAUDE_OPUS_GROUPS[index],
        direction: CLAUDE_RAY_DIRECTIONS[index],
        clipPath: `M 50 50 L ${claudePolarPoint(start)} L ${claudePolarPoint(end)} Z`,
      };
    });
    const clipId = (index) => `claude-ray-clip-${marker}-${index}`;
    const defs = rays
      .map((ray, index) => `<clipPath id="${clipId(index)}" clipPathUnits="userSpaceOnUse"><path d="${ray.clipPath}" /></clipPath>`)
      .join("");
    const groups = rays
      .map((ray, index) => {
        const rayClasses = [
          "claude-ray",
          `claude-ray--${index + 1}`,
          `claude-ray-direction--${ray.direction}`,
          `claude-haiku-group--${ray.haikuGroup}`,
          `claude-sonnet-group--${ray.sonnetGroup}`,
          ...ray.opusGroups.map((group) => `claude-opus-group--${group}`),
        ].join(" ");
        return `<g transform="rotate(${ray.angle} 50 50)"><g class="${rayClasses}"><g transform="rotate(${-ray.angle} 50 50)" clip-path="url(#${clipId(index)})"><path d="${CLAUDE_SYMBOL_PATH}" fill="currentColor" /></g></g></g>`;
      })
      .join("");
    return `<svg viewBox="0 0 100 100" class="animated-claude-mark animated-claude-mark--${tier} model-logo-badge-mark" fill="none" aria-hidden="true" focusable="false"><defs>${defs}</defs>${groups}<circle cx="50" cy="50" r="9.5" fill="currentColor" class="claude-core" /></svg>`;
  };

  const TERRA_SPARKLES = [
    [18, 29, 1.2, "a", 2.3, -0.6], [31, 19, 0.9, "b", 3.1, -2.4], [45, 27, 1.1, "c", 4.7, -1.3],
    [62, 18, 0.8, "d", 5.7, -4.8], [78, 29, 1, "a", 3.8, -2.1], [88, 44, 1.2, "b", 5.2, -3.7],
    [75, 58, 0.9, "c", 2.8, -1.9], [63, 73, 1.1, "d", 4.3, -0.8], [46, 82, 0.8, "a", 5.5, -4.2],
    [29, 72, 1.2, "b", 3.4, -2.8], [15, 56, 0.9, "c", 4.9, -3.1], [45, 51, 1, "d", 2.6, -0.9],
  ];
  const TERRA_LANDS = [
    ["animated-terra-region--north-america", "M3 30 L8 24 L14 20 L20 21 L24 19 L29 23 L31 27 L27 30 L29 34 L24 38 L19 37 L16 41 L14 47 L10 46 L8 41 L3 39 L1 34 Z"],
    ["animated-terra-region--central-america", "M14 42 L19 43 L23 47 L22 51 L18 49 L15 46 Z"],
    ["animated-terra-land--warm animated-terra-region--south-america", "M22 48 L28 45 L35 48 L39 54 L37 60 L35 66 L33 73 L29 81 L26 86 L23 82 L24 74 L21 68 L19 60 L20 53 Z"],
    ["animated-terra-land--ice animated-terra-region--greenland", "M30 12 L36 10 L41 14 L40 19 L36 24 L31 22 L28 18 Z"],
    ["animated-terra-region--eurasia", "M43 30 L47 26 L53 26 L57 22 L63 22 L67 19 L73 22 L79 20 L84 23 L89 24 L93 28 L98 29 L99 34 L94 37 L90 36 L86 40 L82 39 L78 44 L73 43 L69 39 L64 41 L60 38 L56 41 L51 38 L47 37 Z"],
    ["animated-terra-land--warm animated-terra-region--africa", "M50 40 L58 38 L65 41 L69 46 L67 53 L64 58 L63 65 L59 73 L55 70 L52 64 L50 58 L47 52 L48 45 Z"],
    ["animated-terra-region--arabia", "M66 44 L73 45 L77 50 L74 55 L69 53 L66 49 Z"],
    ["animated-terra-region--india", "M77 42 L83 46 L82 53 L79 60 L76 54 L74 48 Z"],
    ["animated-terra-land--warm animated-terra-region--australia", "M83 65 L88 62 L94 63 L99 67 L98 72 L94 76 L88 78 L83 75 L81 70 Z"],
  ];
  const TERRA_ISLANDS = "M87 45 L89 43 L90 46 L88 49 Z M74 58 L77 57 L79 59 L76 61 Z M80 61 L82 59 L84 61 L81 63 Z M96 53 L98 51 L99 54 L97 56 Z";

  const buildTerraMark = (uid) => {
    const clipId = `animated-terra-sphere-clip-${escapeAttr(uid || "modal")}`;
    const sparkles = TERRA_SPARKLES.map(
      ([cx, cy, r, variant, duration, delay]) =>
        `<circle class="animated-terra-sparkle animated-terra-sparkle--${variant}" cx="${cx}" cy="${cy}" r="${r}" style="--terra-sparkle-duration: ${duration}s; --terra-sparkle-delay: ${delay}s;" />`,
    ).join("");
    const lands = TERRA_LANDS.map(
      ([cls, d]) => `<path class="animated-terra-land ${cls}" d="${d}" />`,
    ).join("");
    const continent = `<g class="animated-terra-continent-copy" transform="translate(OFFSET 0)">${lands}<path class="animated-terra-island" d="${TERRA_ISLANDS}" /></g>`;
    const strip = [0, 100].map((offset) => continent.replace("OFFSET", String(offset))).join("");
    return `<svg viewBox="0 0 100 100" class="animated-terra-mark model-logo-badge-mark" fill="none" aria-hidden="true" focusable="false"><defs><clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><circle cx="50" cy="50" r="44" /></clipPath></defs><g class="animated-terra-surface-clip" clip-path="url(#${clipId})"><circle class="animated-terra-ocean" cx="50" cy="50" r="44" /><ellipse class="animated-terra-ocean-depth" cx="52" cy="62" rx="39" ry="27" /><g class="animated-terra-water-glints">${sparkles}</g><g class="animated-terra-surface-strip">${strip}</g><ellipse class="animated-terra-daylight" cx="32" cy="31" rx="20" ry="28" transform="rotate(-28 32 31)" /><path class="animated-terra-night-shade" d="M54 6 A44 44 0 0 1 54 94 C76 87 91 70 94 51 C92 29 77 13 54 6 Z" /><path class="animated-terra-limb-shadow" d="M79 16 A44 44 0 0 1 79 84 C89 76 95 64 95 50 C95 36 89 24 79 16 Z" /></g><circle class="animated-terra-atmosphere" cx="50" cy="50" r="44" /><path class="animated-terra-atmosphere-shine" d="M18 77 A42 42 0 0 1 20 21" /></svg>`;
  };

  // ---- render -------------------------------------------------------------

  const escapeHtml = (value) =>
    `${value == null ? "" : value}`
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // Replace `badgeEl`'s contents with the animated logo for `identity`. The
  // wrapper always carries `is-streaming` so the modal (a one-shot prompt with
  // no live stream) animates continuously, matching the greeting hero.
  const renderModelLogoBadge = (badgeEl, identity, options = {}) => {
    if (!badgeEl) return;
    const id = identity && typeof identity === "object" ? identity : {};
    const kind = resolveMotionKind(id);
    const tier = getClaudeTier(`${id.logoModelId || ""} ${id.logoName || ""}`);
    const seed = options.seed != null ? options.seed : id.logoModelId || id.modelId || "modal";
    const style = getMotionStyle(seed, kind, tier);
    const uid = escapeAttr(options.uid || id.logoModelId || id.modelId || seed);

    const needsDark = kind === "gpt" && Boolean(id.needsDarkBadge) && !id.celestialIdentity;
    const badgeClass = `assistant-model-logo-badge model-logo-badge${needsDark ? " model-logo-badge--dark" : ""}`;

    let mark;
    if (kind === "claude") {
      mark = buildClaudeMark(tier, uid);
    } else if (kind === "terra") {
      mark = buildTerraMark(uid);
    } else if (id.logoDataUrl) {
      const celestialClass = id.celestialIdentity ? " celestial-model-logo" : "";
      mark = `<img src="${escapeHtml(id.logoDataUrl)}" alt="" class="model-logo-badge-mark${celestialClass}" />`;
    } else {
      mark = `<span class="model-logo-badge-fallback">${escapeHtml(id.fallbackText || "AI")}</span>`;
    }

    badgeEl.innerHTML =
      `<div class="assistant-model-logo-motion assistant-model-logo-motion--${kind} is-streaming"` +
      ` style="${escapeHtml(style)}" data-model-logo-motion="${kind}" data-claude-motion-tier="${tier}"` +
      ` data-model-logo-streaming="true" aria-hidden="true">` +
      `<div class="assistant-model-logo-rotor">` +
      `<div class="${badgeClass}">${mark}</div>` +
      `</div></div>`;
  };

  const api = {
    render: renderModelLogoBadge,
    resolveMotionKind,
    getMotionStyle,
    getMotionVariables,
    getClaudeTier,
    buildClaudeMark,
    buildTerraMark,
  };

  if (typeof window !== "undefined") {
    window.ModelLogoBadge = api;
    window.renderModelLogoBadge = renderModelLogoBadge;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
