const DETACHED_WINDOW_RETURN_MIN_DRAG_DISTANCE_PX = 80;
const DETACHED_WINDOW_RETURN_DWELL_MS = 450;
const DETACHED_WINDOW_RETURN_ARM_DELAY_MS = 900;
const DETACHED_WINDOW_RETURN_MIN_OVERLAP_WIDTH_PX = 180;
const DETACHED_WINDOW_RETURN_MIN_OVERLAP_HEIGHT_PX = 28;
const DETACHED_WINDOW_RETURN_MIN_OVERLAP_WIDTH_RATIO = 0.35;
const DETACHED_WINDOW_RETURN_MIN_OVERLAP_HEIGHT_RATIO = 0.6;

function normalizeRect(rect) {
  if (!rect) {
    return null;
  }
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { x, y, width, height };
}

function overlapRect(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return { x: left, y: top, width, height };
}

function detachedWindowDragDistance(initialBounds, currentBounds) {
  const initial = normalizeRect(initialBounds);
  const current = normalizeRect(currentBounds);
  if (!initial || !current) {
    return 0;
  }

  return Math.hypot(current.x - initial.x, current.y - initial.y);
}

function hasStrongDockOverlap(hotzoneBounds, dropTargetBounds) {
  const hotzone = normalizeRect(hotzoneBounds);
  const target = normalizeRect(dropTargetBounds);
  if (!hotzone || !target) {
    return false;
  }

  const overlap = overlapRect(hotzone, target);
  const requiredWidth = Math.min(
    DETACHED_WINDOW_RETURN_MIN_OVERLAP_WIDTH_PX,
    target.width * DETACHED_WINDOW_RETURN_MIN_OVERLAP_WIDTH_RATIO,
  );
  const requiredHeight = Math.min(
    DETACHED_WINDOW_RETURN_MIN_OVERLAP_HEIGHT_PX,
    target.height * DETACHED_WINDOW_RETURN_MIN_OVERLAP_HEIGHT_RATIO,
  );

  return overlap.width >= requiredWidth && overlap.height >= requiredHeight;
}

function evaluateDetachedConversationDockReturn({
  initialBounds,
  currentBounds,
  hotzoneBounds,
  dropTargetBounds,
  createdAtMs,
  hoverStartedAtMs = null,
  nowMs = Date.now(),
} = {}) {
  const ageMs = Math.max(0, Number(nowMs) - Number(createdAtMs || 0));
  const dragDistance = detachedWindowDragDistance(initialBounds, currentBounds);
  const strongOverlap = hasStrongDockOverlap(hotzoneBounds, dropTargetBounds);
  const distanceArmed = dragDistance >= DETACHED_WINDOW_RETURN_MIN_DRAG_DISTANCE_PX;
  const ageArmed = ageMs >= DETACHED_WINDOW_RETURN_ARM_DELAY_MS;
  const eligible = ageArmed && distanceArmed && strongOverlap;
  const nextHoverStartedAtMs = eligible
    ? Number.isFinite(Number(hoverStartedAtMs))
      ? Number(hoverStartedAtMs)
      : Number(nowMs)
    : null;
  const dwellMs =
    eligible && nextHoverStartedAtMs !== null
      ? Math.max(0, Number(nowMs) - nextHoverStartedAtMs)
      : 0;
  const canAttach = eligible && dwellMs >= DETACHED_WINDOW_RETURN_DWELL_MS;

  return {
    canAttach,
    ageArmed,
    distanceArmed,
    dragDistance,
    dwellMs,
    eligible,
    hoverStartedAtMs: nextHoverStartedAtMs,
    remainingArmDelayMs: ageArmed
      ? 0
      : DETACHED_WINDOW_RETURN_ARM_DELAY_MS - ageMs,
    remainingDwellMs: eligible
      ? Math.max(0, DETACHED_WINDOW_RETURN_DWELL_MS - dwellMs)
      : DETACHED_WINDOW_RETURN_DWELL_MS,
    strongOverlap,
  };
}

module.exports = {
  DETACHED_WINDOW_RETURN_ARM_DELAY_MS,
  DETACHED_WINDOW_RETURN_DWELL_MS,
  DETACHED_WINDOW_RETURN_MIN_DRAG_DISTANCE_PX,
  detachedWindowDragDistance,
  evaluateDetachedConversationDockReturn,
  hasStrongDockOverlap,
};
