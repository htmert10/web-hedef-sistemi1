"use strict";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function meanAbsoluteAlignmentError(
  reference,
  current,
  width,
  height,
  dx,
  dy,
  centerX,
  centerY,
  radius
) {
  const radiusSquared = radius * radius;
  let total = 0;
  let count = 0;

  for (let y = 3; y < height - 3; y += 2) {
    const sourceY = y - dy;
    if (sourceY < 0 || sourceY >= height) continue;

    const deltaY = y - centerY;

    for (let x = 3; x < width - 3; x += 2) {
      const deltaX = x - centerX;
      if (deltaX * deltaX + deltaY * deltaY > radiusSquared) continue;

      const sourceX = x - dx;
      if (sourceX < 0 || sourceX >= width) continue;

      total += Math.abs(
        reference[y * width + x] -
        current[sourceY * width + sourceX]
      );

      count++;
    }
  }

  return count ? total / count : Number.POSITIVE_INFINITY;
}

function findBestShift(
  reference,
  current,
  width,
  height,
  maxShift,
  centerX,
  centerY,
  radius
) {
  let best = {
    dx: 0,
    dy: 0,
    error: Number.POSITIVE_INFINITY
  };

  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      const error = meanAbsoluteAlignmentError(
        reference,
        current,
        width,
        height,
        dx,
        dy,
        centerX,
        centerY,
        radius
      );

      if (error < best.error) {
        best = { dx, dy, error };
      }
    }
  }

  return best;
}

function alignedValue(current, width, height, x, y, dx, dy) {
  const sourceX = clamp(x - dx, 0, width - 1);
  const sourceY = clamp(y - dy, 0, height - 1);
  return current[sourceY * width + sourceX];
}

function buildDifferenceMask(
  reference,
  current,
  width,
  height,
  alignment,
  centerX,
  centerY,
  radius
) {
  const pixelCount = width * height;
  const diff = new Uint8Array(pixelCount);
  const mask = new Uint8Array(pixelCount);
  const radiusSquared = radius * radius;

  let brightnessOffsetTotal = 0;
  let brightnessOffsetCount = 0;

  for (let y = 2; y < height - 2; y += 3) {
    const deltaY = y - centerY;

    for (let x = 2; x < width - 2; x += 3) {
      const deltaX = x - centerX;
      if (deltaX * deltaX + deltaY * deltaY > radiusSquared) continue;

      const index = y * width + x;
      const currentValue = alignedValue(
        current,
        width,
        height,
        x,
        y,
        alignment.dx,
        alignment.dy
      );

      brightnessOffsetTotal += reference[index] - currentValue;
      brightnessOffsetCount++;
    }
  }

  const brightnessOffset = brightnessOffsetCount
    ? brightnessOffsetTotal / brightnessOffsetCount
    : 0;

  let mean = 0;
  let meanSquare = 0;
  let statisticsCount = 0;

  for (let y = 1; y < height - 1; y++) {
    const deltaY = y - centerY;

    for (let x = 1; x < width - 1; x++) {
      const deltaX = x - centerX;
      const index = y * width + x;

      if (deltaX * deltaX + deltaY * deltaY > radiusSquared) {
        diff[index] = 0;
        continue;
      }

      const adjustedCurrent = clamp(
        alignedValue(
          current,
          width,
          height,
          x,
          y,
          alignment.dx,
          alignment.dy
        ) + brightnessOffset,
        0,
        255
      );

      const value = Math.abs(reference[index] - adjustedCurrent);
      diff[index] = value;

      mean += value;
      meanSquare += value * value;
      statisticsCount++;
    }
  }

  mean = statisticsCount ? mean / statisticsCount : 0;
  const variance = statisticsCount
    ? Math.max(0, meanSquare / statisticsCount - mean * mean)
    : 0;

  const standardDeviation = Math.sqrt(variance);
  const darkThreshold = Math.max(6, mean + standardDeviation * 1.55);
  const lightThreshold = Math.max(11, mean + standardDeviation * 2.35);

  for (let y = 1; y < height - 1; y++) {
    const deltaY = y - centerY;

    for (let x = 1; x < width - 1; x++) {
      const deltaX = x - centerX;
      const index = y * width + x;

      if (deltaX * deltaX + deltaY * deltaY > radiusSquared) {
        mask[index] = 0;
        continue;
      }

      const threshold = reference[index] < 118
        ? darkThreshold
        : lightThreshold;

      mask[index] = diff[index] >= threshold ? 1 : 0;
    }
  }

  // Hafif morphology opening: yalnız kalan pikselleri temizler.
  const cleaned = new Uint8Array(pixelCount);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      if (!mask[index]) continue;

      let neighbors = 0;

      for (let yy = -1; yy <= 1; yy++) {
        for (let xx = -1; xx <= 1; xx++) {
          neighbors += mask[(y + yy) * width + (x + xx)];
        }
      }

      if (neighbors >= 3) {
        cleaned[index] = 1;
      }
    }
  }

  return {
    diff,
    mask: cleaned,
    mean,
    standardDeviation,
    brightnessOffset
  };
}

function connectedComponents(
  reference,
  diff,
  mask,
  width,
  height
) {
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const candidates = [];

  for (let start = 0; start < pixelCount; start++) {
    if (!mask[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;

    queue[tail++] = start;
    visited[start] = 1;

    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let weightedX = 0;
    let weightedY = 0;
    let totalWeight = 0;
    let totalDifference = 0;
    let totalReference = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let perimeter = 0;

    while (head < tail) {
      const index = queue[head++];
      const y = Math.floor(index / width);
      const x = index - y * width;
      const weight = Math.max(1, diff[index]);

      area++;
      sumX += x;
      sumY += y;
      weightedX += x * weight;
      weightedY += y * weight;
      totalWeight += weight;
      totalDifference += diff[index];
      totalReference += reference[index];

      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      const neighbors = [
        index - 1,
        index + 1,
        index - width,
        index + width
      ];

      for (const next of neighbors) {
        if (
          next < 0 ||
          next >= pixelCount ||
          visited[next] ||
          !mask[next]
        ) {
          continue;
        }

        visited[next] = 1;
        queue[tail++] = next;
      }

      if (
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        !mask[index - 1] ||
        !mask[index + 1] ||
        !mask[index - width] ||
        !mask[index + width]
      ) {
        perimeter++;
      }
    }

    if (area < 3 || area > 520) continue;

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const aspectRatio = boxWidth / Math.max(1, boxHeight);
    const aspectCloseness = Math.min(
      aspectRatio,
      1 / Math.max(0.0001, aspectRatio)
    );

    const fillRatio = area / Math.max(1, boxWidth * boxHeight);
    const circularity = perimeter > 0
      ? 4 * Math.PI * area / (perimeter * perimeter)
      : 0;

    const merged =
      area > 150 ||
      boxWidth > 20 ||
      boxHeight > 20;

    if (!merged) {
      if (aspectRatio < 0.32 || aspectRatio > 3.1) continue;
      if (fillRatio < 0.12) continue;
      if (circularity < 0.08) continue;
    }

    const centerX = totalWeight
      ? weightedX / totalWeight
      : sumX / area;

    const centerY = totalWeight
      ? weightedY / totalWeight
      : sumY / area;

    const meanDifference = totalDifference / area;
    const meanReference = totalReference / area;
    const darkRegion = meanReference < 118;

    const areaScore = clamp((area - 3) / 85, 0, 1);
    const intensityScore = clamp(
      (meanDifference - (darkRegion ? 6 : 10)) /
      (darkRegion ? 30 : 42),
      0,
      1
    );

    const shapeScore = clamp(
      aspectCloseness * 0.55 +
      clamp(fillRatio / 0.55, 0, 1) * 0.25 +
      clamp(circularity / 0.65, 0, 1) * 0.20,
      0,
      1
    );

    let confidence =
      areaScore * 0.24 +
      intensityScore * 0.45 +
      shapeScore * 0.31;

    if (merged) {
      confidence *= 0.72;
    }

    candidates.push({
      x: centerX / (width - 1),
      y: centerY / (height - 1),
      area,
      meanDifference,
      darkRegion,
      aspectRatio,
      fillRatio,
      circularity,
      merged,
      confidence: clamp(confidence, 0, 1)
    });
  }

  candidates.sort(
    (first, second) => second.confidence - first.confidence
  );

  return candidates;
}

self.addEventListener("message", (event) => {
  const payload = event.data || {};
  const id = payload.id;

  try {
    const width = payload.width;
    const height = payload.height;

    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error("Geçersiz Worker görüntü boyutu.");
    }

    const reference = new Uint8Array(payload.reference);
    const current = new Uint8Array(payload.current);

    if (
      reference.length !== width * height ||
      current.length !== width * height
    ) {
      throw new Error("Worker görüntü tamponu boyutu uyuşmuyor.");
    }

    const alignment = findBestShift(
      reference,
      current,
      width,
      height,
      clamp(payload.maxShift ?? 2, 0, 3),
      payload.centerX ?? Math.round(width / 2),
      payload.centerY ?? Math.round(height / 2),
      payload.roiRadius ?? Math.round(width * 0.46)
    );

    const difference = buildDifferenceMask(
      reference,
      current,
      width,
      height,
      alignment,
      payload.centerX ?? Math.round(width / 2),
      payload.centerY ?? Math.round(height / 2),
      payload.roiRadius ?? Math.round(width * 0.46)
    );

    const candidates = connectedComponents(
      reference,
      difference.diff,
      difference.mask,
      width,
      height
    );

    const best = candidates[0] || null;
    const second = candidates[1] || null;

    if (best) {
      const uniqueness = second
        ? clamp((best.confidence - second.confidence) / 0.22, 0, 1)
        : 1;

      const alignmentQuality = clamp(1 - alignment.error / 18, 0, 1);

      best.confidence = clamp(
        best.confidence * 0.80 +
        uniqueness * 0.13 +
        alignmentQuality * 0.07,
        0,
        1
      );
    }

    const minAutoConfidence = payload.minAutoConfidence ?? 0.82;

    const detected = Boolean(
      best &&
      !best.merged &&
      best.confidence >= minAutoConfidence &&
      (!second || best.confidence - second.confidence >= 0.09)
    );

    self.postMessage({
      id,
      ok: true,
      result: {
        detected,
        best,
        candidates: candidates.slice(0, 5),
        confidence: best?.confidence ?? 0,
        alignment,
        diagnostics: {
          meanDifference: difference.mean,
          standardDeviation: difference.standardDeviation,
          brightnessOffset: difference.brightnessOffset
        }
      }
    });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error?.message || String(error)
    });
  }
});
