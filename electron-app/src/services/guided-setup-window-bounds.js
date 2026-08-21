function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function normalizeDimension(value, fallback = 0) {
  const normalized = Math.round(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return Math.max(1, Math.round(Number(fallback)) || 1);
  }
  return normalized;
}

function normalizeCoordinate(value, fallback = 0) {
  const normalized = Math.round(Number(value));
  if (!Number.isFinite(normalized)) {
    return Math.round(Number(fallback)) || 0;
  }
  return normalized;
}

function boundsIntersectWorkArea(bounds = {}, workArea = {}) {
  const boundsRight = Number(bounds.x) + Number(bounds.width);
  const boundsBottom = Number(bounds.y) + Number(bounds.height);
  const workAreaRight = Number(workArea.x) + Number(workArea.width);
  const workAreaBottom = Number(workArea.y) + Number(workArea.height);

  if (
    !isFiniteNumber(bounds.x) ||
    !isFiniteNumber(bounds.y) ||
    !isFiniteNumber(bounds.width) ||
    !isFiniteNumber(bounds.height) ||
    !isFiniteNumber(workArea.x) ||
    !isFiniteNumber(workArea.y) ||
    !isFiniteNumber(workArea.width) ||
    !isFiniteNumber(workArea.height)
  ) {
    return false;
  }

  return (
    Number(bounds.x) < workAreaRight &&
    boundsRight > Number(workArea.x) &&
    Number(bounds.y) < workAreaBottom &&
    boundsBottom > Number(workArea.y)
  );
}

function getCenteredBounds(targetSize = {}, workArea = {}) {
  const workAreaX = normalizeCoordinate(workArea.x, 0);
  const workAreaY = normalizeCoordinate(workArea.y, 0);
  const workAreaWidth = normalizeDimension(workArea.width, targetSize.width || 1);
  const workAreaHeight = normalizeDimension(workArea.height, targetSize.height || 1);
  const width = Math.min(normalizeDimension(targetSize.width, 1), workAreaWidth);
  const height = Math.min(normalizeDimension(targetSize.height, 1), workAreaHeight);

  return {
    x: workAreaX + Math.round((workAreaWidth - width) / 2),
    y: workAreaY + Math.round((workAreaHeight - height) / 2),
    width,
    height,
  };
}

function clampBoundsToWorkArea(bounds = {}, workArea = {}) {
  const workAreaX = normalizeCoordinate(workArea.x, 0);
  const workAreaY = normalizeCoordinate(workArea.y, 0);
  const workAreaWidth = normalizeDimension(workArea.width, bounds.width || 1);
  const workAreaHeight = normalizeDimension(workArea.height, bounds.height || 1);
  const width = Math.min(normalizeDimension(bounds.width, 1), workAreaWidth);
  const height = Math.min(normalizeDimension(bounds.height, 1), workAreaHeight);

  const minX = workAreaX;
  const maxX = workAreaX + workAreaWidth - width;
  const minY = workAreaY;
  const maxY = workAreaY + workAreaHeight - height;

  const requestedX = Math.round(Number(bounds.x));
  const requestedY = Math.round(Number(bounds.y));

  return {
    x: Math.min(Math.max(Number.isFinite(requestedX) ? requestedX : minX, minX), maxX),
    y: Math.min(Math.max(Number.isFinite(requestedY) ? requestedY : minY, minY), maxY),
    width,
    height,
  };
}

function computeGuidedSetupResizeBounds(currentBounds = {}, targetSize = {}, workArea = {}) {
  const centeredBounds = getCenteredBounds(targetSize, workArea);
  if (!boundsIntersectWorkArea(currentBounds, workArea)) {
    return centeredBounds;
  }

  const currentCenterX = Number(currentBounds.x) + Number(currentBounds.width) / 2;
  const currentCenterY = Number(currentBounds.y) + Number(currentBounds.height) / 2;
  if (!Number.isFinite(currentCenterX) || !Number.isFinite(currentCenterY)) {
    return centeredBounds;
  }

  return clampBoundsToWorkArea(
    {
      x: Math.round(currentCenterX - centeredBounds.width / 2),
      y: Math.round(currentCenterY - centeredBounds.height / 2),
      width: centeredBounds.width,
      height: centeredBounds.height,
    },
    workArea,
  );
}

module.exports = {
  boundsIntersectWorkArea,
  clampBoundsToWorkArea,
  computeGuidedSetupResizeBounds,
  getCenteredBounds,
};
