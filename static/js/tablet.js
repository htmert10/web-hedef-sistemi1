"use strict";

const CANONICAL_SIZE = 500;
const CAPTURE_MAX_WIDTH = 960;

const video = document.getElementById("video");
const cameraPreview = document.getElementById("cameraPreview");
const cameraPreviewCtx = cameraPreview.getContext("2d");
const overlay = document.getElementById("overlay");
const overlayCtx = overlay.getContext("2d");
const warpedPreview = document.getElementById("warpedPreview");
const warpedCtx = warpedPreview.getContext("2d");

const startBtn = document.getElementById("startBtn");
const resetCornersBtn = document.getElementById("resetCornersBtn");
const referenceBtn = document.getElementById("referenceBtn");
const centerBtn = document.getElementById("centerBtn");
const ringCalBtn = document.getElementById("ringCalBtn");
const learnSoundBtn = document.getElementById("learnSoundBtn");
const armBtn = document.getElementById("armBtn");
const testBtn = document.getElementById("testBtn");
const statusBox = document.getElementById("status");
const audioMeter = document.getElementById("audioMeter");
const zoomRange = document.getElementById("zoomRange");
const zoomText = document.getElementById("zoomText");
const thresholdRange = document.getElementById("thresholdRange");
const thresholdText = document.getElementById("thresholdText");
const cornerCount = document.getElementById("cornerCount");
const connectionState = document.getElementById("connectionState");
const manualPanel = document.getElementById("manualPanel");
const confirmSuggestedBtn = document.getElementById("confirmSuggestedBtn");
const cancelManualBtn = document.getElementById("cancelManualBtn");
const centerValue = document.getElementById("centerValue");
const topValue = document.getElementById("topValue");
const rightValue = document.getElementById("rightValue");
const bottomValue = document.getElementById("bottomValue");
const leftValue = document.getElementById("leftValue");
const calibrationQuality = document.getElementById("calibrationQuality");

const captureCanvas = document.createElement("canvas");
const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true });

let stream = null;
let socket = null;
let corners = [];
let referenceFrame = null;
let lastRawFrames = [];
let audioContext = null;
let analyser = null;
let audioData = null;
let learnedThreshold = Number(thresholdRange.value) / 100;
let detectorArmed = false;
let triggerLocked = false;
let learningSound = false;
let learnedPeak = 0;
let candidateSuggestion = null;
let localShots = [];
let animationFrameId = null;
let lastRawCaptureAt = 0;
let softwareZoom = 1;
let targetCenter = null;
let centerSelectionMode = false;
let ringCalibrationMode = false;
let ringCalibrationIndex = 0;
let ringCalibrationPoints = { top: null, right: null, bottom: null, left: null };
let affineTransform = null;
let calibrationReady = false;

function setStatus(text, level = "") {
  statusBox.className = `status ${level}`.trim();
  statusBox.textContent = text;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function visibleRingRadiusMm(score) {
  return (11 - score) * 8 - 2.25;
}

function expectedRingRadiusNormalized(score) {
  return visibleRingRadiusMm(score) / 170;
}

const RING_DIRECTIONS = ["top", "right", "bottom", "left"];
const RING_DIRECTION_LABELS = {
  top: "Üst",
  right: "Sağ",
  bottom: "Alt",
  left: "Sol"
};

function setRingCalibrationEnabled(enabled) {
  ringCalBtn.disabled = !enabled;
  if (enabled) {
    ringCalBtn.removeAttribute("disabled");
    ringCalBtn.setAttribute("aria-disabled", "false");
  } else {
    ringCalBtn.setAttribute("disabled", "");
    ringCalBtn.setAttribute("aria-disabled", "true");
  }
}

function resetAffineCalibration() {
  ringCalibrationMode = false;
  ringCalibrationIndex = 0;
  ringCalibrationPoints = { top: null, right: null, bottom: null, left: null };
  affineTransform = null;
  calibrationReady = false;

  ringCalBtn.textContent = "5. Siyah daireyi 4 yönden seç";
  centerValue.textContent = targetCenter ? "Hazır" : "Seçilmedi";
  topValue.textContent = "Seçilmedi";
  rightValue.textContent = "Seçilmedi";
  bottomValue.textContent = "Seçilmedi";
  leftValue.textContent = "Seçilmedi";
  calibrationQuality.textContent = "Beş noktalı kalibrasyon henüz hazır değil.";
}

function fitAffineTransform(observedPoints, targetPoints) {
  const normal = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  const bx = [0, 0, 0];
  const by = [0, 0, 0];

  for (let i = 0; i < observedPoints.length; i++) {
    const row = [observedPoints[i].x, observedPoints[i].y, 1];
    for (let r = 0; r < 3; r++) {
      bx[r] += row[r] * targetPoints[i].x;
      by[r] += row[r] * targetPoints[i].y;
      for (let c = 0; c < 3; c++) {
        normal[r][c] += row[r] * row[c];
      }
    }
  }

  const xCoefficients = solveLinearSystem(
    normal.map((row) => [...row]),
    [...bx]
  );
  const yCoefficients = solveLinearSystem(
    normal.map((row) => [...row]),
    [...by]
  );

  return {
    a: xCoefficients[0],
    b: xCoefficients[1],
    c: xCoefficients[2],
    d: yCoefficients[0],
    e: yCoefficients[1],
    f: yCoefficients[2]
  };
}

function applyAffine(point) {
  if (!affineTransform) return { ...point };
  const t = affineTransform;
  return {
    x: t.a * point.x + t.b * point.y + t.c,
    y: t.d * point.x + t.e * point.y + t.f
  };
}

function invertAffine(point) {
  if (!affineTransform) return { ...point };
  const t = affineTransform;
  const determinant = t.a * t.e - t.b * t.d;
  if (Math.abs(determinant) < 1e-10) return { ...point };

  const shiftedX = point.x - t.c;
  const shiftedY = point.y - t.f;

  return {
    x: (t.e * shiftedX - t.b * shiftedY) / determinant,
    y: (-t.d * shiftedX + t.a * shiftedY) / determinant
  };
}

function calculateAffineCalibration() {
  if (!targetCenter || RING_DIRECTIONS.some((direction) => !ringCalibrationPoints[direction])) {
    calibrationReady = false;
    armBtn.disabled = true;
    return false;
  }

  // Dış siyah dairenin kenarı 7 halka çizgisidir.
  const radius = expectedRingRadiusNormalized(7);
  const observed = [
    targetCenter,
    ringCalibrationPoints.top,
    ringCalibrationPoints.right,
    ringCalibrationPoints.bottom,
    ringCalibrationPoints.left
  ];
  const ideal = [
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 0.5 - radius },
    { x: 0.5 + radius, y: 0.5 },
    { x: 0.5, y: 0.5 + radius },
    { x: 0.5 - radius, y: 0.5 }
  ];

  try {
    affineTransform = fitAffineTransform(observed, ideal);
  } catch (error) {
    affineTransform = null;
    calibrationReady = false;
    armBtn.disabled = true;
    calibrationQuality.textContent = "Kalibrasyon hesaplanamadı. Noktaları yeniden seç.";
    return false;
  }

  const errorsMm = observed.map((point, index) => {
    const mapped = applyAffine(point);
    return Math.hypot(mapped.x - ideal[index].x, mapped.y - ideal[index].y) * 170;
  });

  const averageError = errorsMm.reduce((sum, value) => sum + value, 0) / errorsMm.length;
  const maximumError = Math.max(...errorsMm);
  const determinant = affineTransform.a * affineTransform.e - affineTransform.b * affineTransform.d;

  if (!Number.isFinite(averageError) || Math.abs(determinant) < 1e-6) {
    affineTransform = null;
    calibrationReady = false;
    armBtn.disabled = true;
    calibrationQuality.textContent = "Kalibrasyon geçersiz. Noktaları yeniden seç.";
    return false;
  }

  calibrationReady = true;
  armBtn.disabled = false;

  let quality = "İyi";
  if (maximumError > 2.0) quality = "Zayıf";
  else if (maximumError > 1.0) quality = "Orta";

  calibrationQuality.textContent =
    `Kalibrasyon hazır · kalite: ${quality} · ortalama hata: ${averageError.toFixed(1)} mm`;

  return true;
}

function toTargetCoordinates(paperX, paperY) {
  if (calibrationReady && affineTransform) {
    const mapped = applyAffine({ x: paperX, y: paperY });
    return { x: clamp01(mapped.x), y: clamp01(mapped.y) };
  }

  const center = targetCenter || { x: 0.5, y: 0.5 };
  return {
    x: clamp01(0.5 + (paperX - center.x)),
    y: clamp01(0.5 + (paperY - center.y))
  };
}

function toPaperCoordinates(targetX, targetY) {
  if (calibrationReady && affineTransform) {
    const mapped = invertAffine({ x: targetX, y: targetY });
    return { x: clamp01(mapped.x), y: clamp01(mapped.y) };
  }

  const center = targetCenter || { x: 0.5, y: 0.5 };
  return {
    x: clamp01(center.x + (targetX - 0.5)),
    y: clamp01(center.y + (targetY - 0.5))
  };
}

function drawMappedRing(score) {
  if (!calibrationReady || !affineTransform) return;

  const radius = expectedRingRadiusNormalized(score);
  warpedCtx.beginPath();

  for (let step = 0; step <= 96; step++) {
    const angle = (step / 96) * Math.PI * 2;
    const idealPoint = {
      x: 0.5 + Math.cos(angle) * radius,
      y: 0.5 + Math.sin(angle) * radius
    };
    const paperPoint = invertAffine(idealPoint);
    const px = paperPoint.x * warpedPreview.width;
    const py = paperPoint.y * warpedPreview.height;

    if (step === 0) warpedCtx.moveTo(px, py);
    else warpedCtx.lineTo(px, py);
  }

  warpedCtx.stroke();
}

function drawCalibrationOverlay() {
  if (!targetCenter) return;

  warpedCtx.save();

  if (calibrationReady && affineTransform) {
    warpedCtx.setLineDash([7, 6]);
    warpedCtx.lineWidth = 1.5;
    warpedCtx.strokeStyle = "rgba(77, 163, 255, .72)";
    for (let score = 10; score >= 1; score--) drawMappedRing(score);
    warpedCtx.setLineDash([]);
  }

  const pointStyles = {
    top: "#4ade80",
    right: "#fbbf24",
    bottom: "#fb7185",
    left: "#60a5fa"
  };

  for (const direction of RING_DIRECTIONS) {
    const point = ringCalibrationPoints[direction];
    if (!point) continue;

    const px = point.x * warpedPreview.width;
    const py = point.y * warpedPreview.height;
    warpedCtx.fillStyle = pointStyles[direction];
    warpedCtx.beginPath();
    warpedCtx.arc(px, py, 7, 0, Math.PI * 2);
    warpedCtx.fill();
    warpedCtx.font = "bold 14px system-ui";
    warpedCtx.fillText(RING_DIRECTION_LABELS[direction], px + 10, py - 10);
  }

  const centerX = targetCenter.x * warpedPreview.width;
  const centerY = targetCenter.y * warpedPreview.height;
  warpedCtx.strokeStyle = "#ff3b6b";
  warpedCtx.fillStyle = "rgba(255,59,107,.18)";
  warpedCtx.lineWidth = 3;
  warpedCtx.beginPath();
  warpedCtx.arc(centerX, centerY, 13, 0, Math.PI * 2);
  warpedCtx.fill();
  warpedCtx.stroke();
  warpedCtx.beginPath();
  warpedCtx.moveTo(centerX - 22, centerY);
  warpedCtx.lineTo(centerX + 22, centerY);
  warpedCtx.moveTo(centerX, centerY - 22);
  warpedCtx.lineTo(centerX, centerY + 22);
  warpedCtx.stroke();

  warpedCtx.restore();
}

function beginRingCalibration() {
  if (!referenceFrame || !targetCenter) {
    setStatus("Önce temiz hedefi kaydet ve hedef merkezini seç.", "warn");
    return;
  }

  detectorArmed = false;
  armBtn.textContent = "7. Sistemi hazırla";
  armBtn.className = "";
  armBtn.disabled = true;
  resetAffineCalibration();
  centerValue.textContent = "Hazır";
  ringCalibrationMode = true;
  ringCalibrationIndex = 0;
  ringCalBtn.textContent = "Kalibrasyon: 0/4";

  setStatus(
    "Dış siyah dairenin ÜST kenarına dokun. Sonra sağ, alt ve sol gelecek.",
    "warn"
  );
}

function saveRingCalibrationPoint(x, y) {
  const direction = RING_DIRECTIONS[ringCalibrationIndex];
  ringCalibrationPoints[direction] = { x, y };

  const valueElement = {
    top: topValue,
    right: rightValue,
    bottom: bottomValue,
    left: leftValue
  }[direction];
  valueElement.textContent = "Hazır";

  ringCalibrationIndex += 1;
  ringCalBtn.textContent = `Kalibrasyon: ${ringCalibrationIndex}/4`;

  if (referenceFrame) {
    warpedCtx.putImageData(referenceFrame, 0, 0);
    drawCalibrationOverlay();
  }

  if (ringCalibrationIndex < RING_DIRECTIONS.length) {
    const nextDirection = RING_DIRECTIONS[ringCalibrationIndex];
    setStatus(
      `Şimdi dış siyah dairenin ${RING_DIRECTION_LABELS[nextDirection].toUpperCase()} kenarına dokun.`,
      "warn"
    );
    return;
  }

  ringCalibrationMode = false;
  ringCalBtn.textContent = "5. Kalibrasyonu yeniden yap";

  if (calculateAffineCalibration()) {
    if (referenceFrame) {
      warpedCtx.putImageData(referenceFrame, 0, 0);
      drawCalibrationOverlay();
    }
    setStatus(
      "Beş noktalı kalibrasyon tamamlandı. Mavi halkalar basılı halkalarla çakışmalı.",
      "ok"
    );
    send({
      type: "sensor_event",
      message: "Beş noktalı görüntü kalibrasyonu tamamlandı.",
      level: "info"
    });
  }
}

function wsUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

function connectSocket() {
  socket = new WebSocket(wsUrl());

  socket.addEventListener("open", () => {
    connectionState.textContent = "Bağlı";
    socket.send(JSON.stringify({ type: "request_state" }));
  });

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "state") {
      localShots = data.shots || [];
    }
  });

  socket.addEventListener("close", () => {
    connectionState.textContent = "Koptu";
    setTimeout(connectSocket, 1500);
  });
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function resizeCapture() {
  const ratio = video.videoHeight / video.videoWidth;
  captureCanvas.width = CAPTURE_MAX_WIDTH;
  captureCanvas.height = Math.round(CAPTURE_MAX_WIDTH * ratio);

  cameraPreview.width = captureCanvas.width;
  cameraPreview.height = captureCanvas.height;
  overlay.width = captureCanvas.width;
  overlay.height = captureCanvas.height;

  drawCameraPreview();
  drawOverlay();
}

function zoomCrop() {
  const sourceWidth = video.videoWidth / softwareZoom;
  const sourceHeight = video.videoHeight / softwareZoom;
  return {
    sx: (video.videoWidth - sourceWidth) / 2,
    sy: (video.videoHeight - sourceHeight) / 2,
    sw: sourceWidth,
    sh: sourceHeight
  };
}

function drawZoomedVideoFrame(context, width, height) {
  if (!video.videoWidth || !video.videoHeight) return;
  const crop = zoomCrop();
  context.drawImage(
    video,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    0,
    0,
    width,
    height
  );
}

function drawCameraPreview() {
  if (video.readyState < 2 || !cameraPreview.width) return;
  drawZoomedVideoFrame(
    cameraPreviewCtx,
    cameraPreview.width,
    cameraPreview.height
  );
}

async function startMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Tarayıcı kamera/mikrofon erişimini desteklemiyor veya sayfa HTTPS değil.", "danger");
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    video.srcObject = stream;
    await video.play();

    if (!video.videoWidth) {
      await new Promise((resolve) => {
        video.addEventListener("loadedmetadata", resolve, { once: true });
      });
    }

    resizeCapture();
    setupAudio(stream);
    startLoop();

    startBtn.disabled = true;
    resetCornersBtn.disabled = false;
    learnSoundBtn.disabled = false;
    testBtn.disabled = false;
    zoomRange.disabled = false;

    setStatus("Kamera açık. Hedefin dört köşesini sırayla seç.", "ok");
  } catch (error) {
    setStatus(`Kamera/mikrofon açılamadı: ${error.name || error.message}`, "danger");
  }
}

function setupAudio(mediaStream) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.25;
  audioData = new Uint8Array(analyser.fftSize);
  source.connect(analyser);
}

function currentRms() {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(audioData);
  let sum = 0;
  for (let i = 0; i < audioData.length; i++) {
    const value = (audioData[i] - 128) / 128;
    sum += value * value;
  }
  return Math.sqrt(sum / audioData.length);
}

function startLoop() {
  const loop = (time) => {
    drawCameraPreview();

    const rms = currentRms();
    audioMeter.value = Math.min(100, Math.round(rms * 250));

    if (learningSound) {
      learnedPeak = Math.max(learnedPeak, rms);
    }

    if (detectorArmed && !triggerLocked && rms >= learnedThreshold) {
      triggerShotPipeline();
    }

    if (time - lastRawCaptureAt > 120 && video.readyState >= 2) {
      captureRawFrame();
      lastRawCaptureAt = time;
    }

    animationFrameId = requestAnimationFrame(loop);
  };

  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  animationFrameId = requestAnimationFrame(loop);
}

function captureRawFrame() {
  drawZoomedVideoFrame(
    captureCtx,
    captureCanvas.width,
    captureCanvas.height
  );
  const frame = captureCtx.getImageData(0, 0, captureCanvas.width, captureCanvas.height);
  lastRawFrames.push(frame);
  if (lastRawFrames.length > 10) lastRawFrames.shift();
  return frame;
}

function drawOverlay() {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  if (corners.length > 0) {
    overlayCtx.lineWidth = 4;
    overlayCtx.strokeStyle = "#4da3ff";
    overlayCtx.fillStyle = "#4da3ff";
    overlayCtx.font = "bold 22px system-ui";

    overlayCtx.beginPath();
    overlayCtx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) {
      overlayCtx.lineTo(corners[i].x, corners[i].y);
    }
    if (corners.length === 4) overlayCtx.closePath();
    overlayCtx.stroke();

    corners.forEach((point, index) => {
      overlayCtx.beginPath();
      overlayCtx.arc(point.x, point.y, 10, 0, Math.PI * 2);
      overlayCtx.fill();
      overlayCtx.fillText(String(index + 1), point.x + 14, point.y - 12);
    });
  }

  cornerCount.textContent = `${corners.length}/4`;
  referenceBtn.disabled = corners.length !== 4;
}

overlay.addEventListener("pointerdown", (event) => {
  if (!stream || corners.length >= 4) return;
  const rect = overlay.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (overlay.width / rect.width);
  const y = (event.clientY - rect.top) * (overlay.height / rect.height);
  corners.push({ x, y });
  drawOverlay();

  if (corners.length === 4) {
    setStatus("Köşeler seçildi. Hedef boşken temiz referansı kaydet.", "ok");
    previewWarp(captureRawFrame());
  }
});

function resetCorners() {
  corners = [];
  referenceFrame = null;
  targetCenter = null;
  centerSelectionMode = false;
  detectorArmed = false;
  centerBtn.disabled = true;
  setRingCalibrationEnabled(false);
  resetAffineCalibration();
  armBtn.textContent = "7. Sistemi hazırla";
  armBtn.disabled = true;
  manualPanel.classList.add("hidden");
  drawOverlay();
  warpedCtx.clearRect(0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
  setStatus("Köşeler temizlendi. Dört köşeyi yeniden seç.", "");
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];

    const divisor = a[col][col];
    if (Math.abs(divisor) < 1e-10) throw new Error("Köşe dönüşümü hesaplanamadı.");

    for (let j = col; j <= n; j++) a[col][j] /= divisor;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j++) {
        a[row][j] -= factor * a[col][j];
      }
    }
  }

  return a.map((row) => row[n]);
}

function homographyDestinationToSource(srcPoints) {
  const max = CANONICAL_SIZE - 1;
  const dstPoints = [
    { x: 0, y: 0 },
    { x: max, y: 0 },
    { x: max, y: max },
    { x: 0, y: max }
  ];

  const matrix = [];
  const vector = [];

  for (let i = 0; i < 4; i++) {
    const u = dstPoints[i].x;
    const v = dstPoints[i].y;
    const x = srcPoints[i].x;
    const y = srcPoints[i].y;

    matrix.push([u, v, 1, 0, 0, 0, -x * u, -x * v]);
    vector.push(x);
    matrix.push([0, 0, 0, u, v, 1, -y * u, -y * v]);
    vector.push(y);
  }

  const h = solveLinearSystem(matrix, vector);
  return [
    h[0], h[1], h[2],
    h[3], h[4], h[5],
    h[6], h[7], 1
  ];
}

function bilinearSample(data, width, height, x, y, output, outIndex) {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const dx = x - x0;
  const dy = y - y0;

  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;

  for (let channel = 0; channel < 3; channel++) {
    const top = data[i00 + channel] * (1 - dx) + data[i10 + channel] * dx;
    const bottom = data[i01 + channel] * (1 - dx) + data[i11 + channel] * dx;
    output[outIndex + channel] = top * (1 - dy) + bottom * dy;
  }
  output[outIndex + 3] = 255;
}

function warpFrame(sourceFrame) {
  if (corners.length !== 4) throw new Error("Dört köşe seçilmedi.");

  const h = homographyDestinationToSource(corners);
  const output = new ImageData(CANONICAL_SIZE, CANONICAL_SIZE);
  const out = output.data;
  const src = sourceFrame.data;

  for (let v = 0; v < CANONICAL_SIZE; v++) {
    for (let u = 0; u < CANONICAL_SIZE; u++) {
      const denominator = h[6] * u + h[7] * v + h[8];
      const x = (h[0] * u + h[1] * v + h[2]) / denominator;
      const y = (h[3] * u + h[4] * v + h[5]) / denominator;
      const outIndex = (v * CANONICAL_SIZE + u) * 4;
      bilinearSample(src, sourceFrame.width, sourceFrame.height, x, y, out, outIndex);
    }
  }

  return output;
}

function previewWarp(rawFrame) {
  try {
    const warped = warpFrame(rawFrame);
    warpedCtx.putImageData(warped, 0, 0);
    drawCalibrationOverlay();
    return warped;
  } catch (error) {
    setStatus(error.message, "danger");
    return null;
  }
}

function saveReference() {
  const raw = captureRawFrame();
  referenceFrame = previewWarp(raw);
  if (!referenceFrame) return;

  targetCenter = null;
  centerSelectionMode = false;
  resetAffineCalibration();
  setRingCalibrationEnabled(false);
  centerBtn.disabled = false;
  armBtn.disabled = true;
  setStatus(
    "Temiz hedef kaydedildi. Şimdi hedef merkezini seç ve 10 halkasının tam ortasına dokun.",
    "ok"
  );
}

async function learnSound() {
  if (!analyser) return;
  learningSound = true;
  learnedPeak = 0;
  detectorArmed = false;
  learnSoundBtn.disabled = true;
  setStatus("2 saniye içinde tanımlamak istediğin sesi çıkar.", "warn");

  await new Promise((resolve) => setTimeout(resolve, 2200));

  learningSound = false;
  learnSoundBtn.disabled = false;

  if (learnedPeak < 0.02) {
    setStatus("Ses çok düşük kaldı. Tekrar öğret.", "warn");
    return;
  }

  learnedThreshold = Math.max(0.035, learnedPeak * 0.58);
  thresholdRange.value = Math.min(65, Math.round(learnedThreshold * 100));
  thresholdText.textContent = thresholdRange.value;
  setStatus(`Ses öğrenildi. Eşik yaklaşık %${thresholdRange.value}.`, "ok");
}

function toggleArm() {
  if (!referenceFrame || corners.length !== 4 || !targetCenter || !calibrationReady) {
    setStatus(
      "Önce köşeleri, temiz hedefi, merkezi ve siyah dairenin dört yönünü tamamla.",
      "warn"
    );
    return;
  }

  detectorArmed = !detectorArmed;
  armBtn.textContent = detectorArmed ? "Sistemi durdur" : "7. Sistemi hazırla";
  armBtn.className = detectorArmed ? "danger" : "";
  setStatus(
    detectorArmed
      ? "Sistem hazır. Tanımlı ses bekleniyor."
      : "Algılama durduruldu.",
    detectorArmed ? "ok" : ""
  );
}

function grayAt(data, pixelIndex) {
  const i = pixelIndex * 4;
  return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
}

function findNewHole(before, after) {
  const width = CANONICAL_SIZE;
  const height = CANONICAL_SIZE;
  const count = width * height;
  const deltas = new Float32Array(count);

  let globalDelta = 0;
  for (let p = 0; p < count; p++) {
    const delta = grayAt(before.data, p) - grayAt(after.data, p);
    deltas[p] = delta;
    globalDelta += delta;
  }
  globalDelta /= count;

  const mask = new Uint8Array(count);
  const rawThreshold = 18;

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x;
      const adjusted = deltas[p] - globalDelta;
      const afterGray = grayAt(after.data, p);
      if (adjusted > rawThreshold && afterGray < 185) mask[p] = 1;
    }
  }

  const cleaned = new Uint8Array(count);
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const p = y * width + x;
      if (!mask[p]) continue;
      let neighbors = 0;
      for (let yy = -1; yy <= 1; yy++) {
        for (let xx = -1; xx <= 1; xx++) {
          neighbors += mask[(y + yy) * width + (x + xx)];
        }
      }
      if (neighbors >= 3) cleaned[p] = 1;
    }
  }

  const visited = new Uint8Array(count);
  const queue = new Int32Array(count);
  let best = null;

  for (let start = 0; start < count; start++) {
    if (!cleaned[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let sumWeight = 0;
    let sumDelta = 0;
    let minX = width, minY = height, maxX = 0, maxY = 0;

    while (head < tail) {
      const p = queue[head++];
      const y = Math.floor(p / width);
      const x = p - y * width;
      const weight = Math.max(1, deltas[p] - globalDelta);

      area++;
      sumX += x * weight;
      sumY += y * weight;
      sumWeight += weight;
      sumDelta += weight;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const neighbors = [p - 1, p + 1, p - width, p + width];
      for (const next of neighbors) {
        if (
          next >= 0 &&
          next < count &&
          cleaned[next] &&
          !visited[next]
        ) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }

    if (area < 7 || area > 2600) continue;

    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    const aspect = Math.min(boxW, boxH) / Math.max(boxW, boxH);
    const density = area / (boxW * boxH);
    const averageDelta = sumDelta / area;
    const score = area * averageDelta * (0.5 + aspect) * (0.5 + density);

    const component = {
      x: sumX / sumWeight,
      y: sumY / sumWeight,
      area,
      averageDelta,
      aspect,
      score
    };

    if (!best || component.score > best.score) best = component;
  }

  if (!best) return null;

  const plausibleArea = best.area >= 12 && best.area <= 1200;
  const plausibleContrast = best.averageDelta >= 20;
  const plausibleShape = best.aspect >= 0.28;

  const confidence = Math.max(
    0,
    Math.min(
      1,
      (best.averageDelta - 14) / 45 * 0.5 +
      Math.min(best.area / 220, 1) * 0.3 +
      best.aspect * 0.2
    )
  );

  if (!plausibleArea || !plausibleContrast || !plausibleShape || confidence < 0.42) {
    return null;
  }

  return {
    x: best.x / (CANONICAL_SIZE - 1),
    y: best.y / (CANONICAL_SIZE - 1),
    confidence
  };
}

function findOverlapSuggestion(before, after) {
  if (!localShots.length) return null;

  let best = null;
  for (const shot of localShots) {
    const paperPoint = toPaperCoordinates(shot.x, shot.y);
    const cx = paperPoint.x * (CANONICAL_SIZE - 1);
    const cy = paperPoint.y * (CANONICAL_SIZE - 1);
    let sum = 0;
    let count = 0;

    for (let y = Math.max(0, Math.floor(cy - 22)); y <= Math.min(CANONICAL_SIZE - 1, Math.ceil(cy + 22)); y++) {
      for (let x = Math.max(0, Math.floor(cx - 22)); x <= Math.min(CANONICAL_SIZE - 1, Math.ceil(cx + 22)); x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > 22 * 22) continue;
        const p = y * CANONICAL_SIZE + x;
        sum += Math.abs(grayAt(before.data, p) - grayAt(after.data, p));
        count++;
      }
    }

    const change = count ? sum / count : 0;
    if (!best || change > best.change) {
      best = { x: paperPoint.x, y: paperPoint.y, change };
    }
  }

  return best && best.change > 3.2
    ? { ...best, confidence: Math.min(0.45, best.change / 18) }
    : null;
}

async function triggerShotPipeline() {
  if (triggerLocked || !referenceFrame || corners.length !== 4) return;
  
  triggerLocked = true;
  console.log("🔫 Trigger başladı");

  send({
    type: "sensor_event",
    message: "Tanımlı ses algılandı. Görüntüler karşılaştırılıyor...",
    level: "info"
  });
  
  setStatus("Atış olayı algılandı. İşleniyor...", "warn");

  try {
    const beforeRaw = lastRawFrames[Math.max(0, lastRawFrames.length - 3)] || captureRawFrame();

    await new Promise((resolve) => setTimeout(resolve, 600));

    const afterRaw = captureRawFrame();
    const beforeWarped = warpFrame(beforeRaw);
    const afterWarped = warpFrame(afterRaw);

    warpedCtx.putImageData(afterWarped, 0, 0);
    drawCalibrationOverlay();

    const candidate = findNewHole(beforeWarped, afterWarped);

    if (candidate) {
      const targetPoint = toTargetCoordinates(candidate.x, candidate.y);
      
      console.log(`✅ Delik bulundu → (${targetPoint.x.toFixed(3)}, ${targetPoint.y.toFixed(3)})`);

      send({
        type: "shot",
        x: targetPoint.x,
        y: targetPoint.y,
        confidence: candidate.confidence,
        status: "confirmed",
        source: "camera"
      });

      referenceFrame = afterWarped;
      setStatus(`Yeni delik bulundu. Güven: %${Math.round(candidate.confidence * 100)}`, "ok");
    } else {
      console.log("❌ Delik bulunamadı, manuel moda");
      candidateSuggestion = { x: 0.5, y: 0.5, confidence: 0.35 };
      manualPanel.classList.remove("hidden");
      setStatus("Yeni delik bulunamadı. Hedefe dokunarak konum seç.", "warn");
    }
  } catch (error) {
    console.error("Trigger Hatası:", error.message || error);
    setStatus("İşlem sırasında hata oluştu. Tekrar dene veya manuel seç.", "danger");
  } finally {
    setTimeout(() => { triggerLocked = false; }, 1400);
  }
}

function sendManualShot(x, y, confidence = 0.35) {
  const targetPoint = toTargetCoordinates(x, y);
  send({
    type: "shot",
    x: targetPoint.x,
    y: targetPoint.y,
    confidence,
    status: "suspect",
    source: "manual"
  });
  manualPanel.classList.add("hidden");
  candidateSuggestion = null;
  setStatus("Şüpheli atış kaydedildi.", "warn");
}

warpedPreview.addEventListener("pointerdown", (event) => {
  const rect = warpedPreview.getBoundingClientRect();
  const x = clamp01((event.clientX - rect.left) / rect.width);
  const y = clamp01((event.clientY - rect.top) / rect.height);

  if (centerSelectionMode) {
    targetCenter = { x, y };
    centerSelectionMode = false;
    centerBtn.textContent = "4. Merkezi yeniden seç";
    resetAffineCalibration();
    centerValue.textContent = "Hazır";
    setRingCalibrationEnabled(true);
    requestAnimationFrame(() => setRingCalibrationEnabled(true));
    armBtn.disabled = true;

    if (referenceFrame) {
      warpedCtx.putImageData(referenceFrame, 0, 0);
      drawCalibrationOverlay();
    }

    setStatus(
      "Merkez kaydedildi. Şimdi siyah daireyi üst, sağ, alt ve sol yönlerden kalibre et.",
      "ok"
    );
    return;
  }

  if (ringCalibrationMode) {
    saveRingCalibrationPoint(x, y);
    return;
  }

  if (manualPanel.classList.contains("hidden")) return;
  sendManualShot(x, y, 0.5);
});

confirmSuggestedBtn.addEventListener("click", () => {
  if (candidateSuggestion) {
    sendManualShot(
      candidateSuggestion.x,
      candidateSuggestion.y,
      candidateSuggestion.confidence
    );
  }
});

cancelManualBtn.addEventListener("click", () => {
  manualPanel.classList.add("hidden");
  candidateSuggestion = null;
  setStatus("Şüpheli algılama iptal edildi.", "");
});

centerBtn.addEventListener("click", () => {
  if (!referenceFrame) {
    setStatus("Önce temiz hedefi kaydet.", "warn");
    return;
  }

  centerSelectionMode = true;
  ringCalibrationMode = false;
  detectorArmed = false;
  resetAffineCalibration();
  setRingCalibrationEnabled(false);
  armBtn.textContent = "7. Sistemi hazırla";
  armBtn.disabled = true;

  setStatus(
    "Düzeltilmiş hedefte 10 halkasının tam merkezine bir kez dokun.",
    "warn"
  );
});

ringCalBtn.addEventListener("click", beginRingCalibration);

zoomRange.addEventListener("input", () => {
  softwareZoom = Number(zoomRange.value);
  zoomText.textContent = softwareZoom.toFixed(1);
  drawCameraPreview();

  if (corners.length > 0 || referenceFrame) {
    corners = [];
    referenceFrame = null;
    targetCenter = null;
    centerSelectionMode = false;
    ringCalibrationMode = false;
    detectorArmed = false;
    centerBtn.disabled = true;
    centerBtn.textContent = "4. Hedef merkezini seç";
    setRingCalibrationEnabled(false);
    resetAffineCalibration();
    armBtn.textContent = "7. Sistemi hazırla";
    armBtn.className = "";
    armBtn.disabled = true;
    manualPanel.classList.add("hidden");
    warpedCtx.clearRect(0, 0, CANONICAL_SIZE, CANONICAL_SIZE);
    drawOverlay();
    setStatus(
      "Zoom değişti. Hedefin dört köşesini yeniden seç.",
      "warn"
    );
  }
});

thresholdRange.addEventListener("input", () => {
  learnedThreshold = Number(thresholdRange.value) / 100;
  thresholdText.textContent = thresholdRange.value;
});

startBtn.addEventListener("click", startMedia);
resetCornersBtn.addEventListener("click", resetCorners);
referenceBtn.addEventListener("click", saveReference);
learnSoundBtn.addEventListener("click", learnSound);
armBtn.addEventListener("click", toggleArm);
testBtn.addEventListener("click", triggerShotPipeline);

connectSocket();
