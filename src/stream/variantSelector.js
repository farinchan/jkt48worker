/**
 * Variant Selector
 * Selects the highest resolution variant according to the specification.
 * Primary criterion: Resolution (height descending, then width descending).
 * Secondary criterion: Effective bandwidth descending.
 * Tertiary criterion: Frame rate descending.
 * Explicit resolution is prioritized over missing resolution.
 */

function selectHighestVariant(variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return null;
  }

  const sorted = [...variants].sort((a, b) => {
    const hasResA = a.height != null && a.width != null;
    const hasResB = b.height != null && b.width != null;

    // Prefer variants with explicit resolution
    if (hasResA && !hasResB) return -1;
    if (!hasResA && hasResB) return 1;

    // Compare height
    const heightA = a.height ?? 0;
    const heightB = b.height ?? 0;
    if (heightB !== heightA) {
      return heightB - heightA;
    }

    // Compare width
    const widthA = a.width ?? 0;
    const widthB = b.width ?? 0;
    if (widthB !== widthA) {
      return widthB - widthA;
    }

    // Compare effective bandwidth (averageBandwidth ?? bandwidth ?? 0)
    const bwA = a.averageBandwidth ?? a.bandwidth ?? 0;
    const bwB = b.averageBandwidth ?? b.bandwidth ?? 0;
    if (bwB !== bwA) {
      return bwB - bwA;
    }

    // Compare frame rate
    const fpsA = a.frameRate ?? 0;
    const fpsB = b.frameRate ?? 0;
    return fpsB - fpsA;
  });

  return sorted[0];
}

module.exports = {
  selectHighestVariant
};
