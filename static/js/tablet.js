"use strict";

const CANONICAL_SIZE = 360;
const CAPTURE_MAX_WIDTH = 720;

const video = document.getElementById("video");
const cameraPreview = document.getElementById("cameraPreview");
const cameraPreviewCtx = cameraPreview.getContext("2d");
const overlay = document.getElementById("overlay");
const overlayCtx = overlay.getContext("2d");
const warpedPreview = document.getElementById("warpedPreview");
const warpedCtx = warpedPreview.getContext("2d");

warpedPreview.width = CANONICAL_SIZE;
warpedPreview.height = CANONICAL_SIZE;

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

// Güvenli kalem noktası / etiket değişikliği algılama durumu.
const MEDIAN_FRAME_COUNT = 3;
const FRAME_INTERVAL_MS = 85;
const MAX_ALIGNMENT_SHIFT = 4;
const MIN_CONFIDENCE_TO_SEND = 0.58;
const TRIGGER_COOLDOWN_MS = 1800;

// Güvenli işaret algılama V2:
// koyu/açık bölgeye göre dinamik duyarlılık ve hedef-içi ROI.
const DARK_REFERENCE_CUTOFF = 118;
const BLACK_TO_OUTER_ROI_RATIO = 2.62;
const ROI_EDGE_PADDING_PX = 8;
const LOCAL_MEAN_BLOCK_SIZE = 21;
const DARK_LOCAL_OFFSET = 2;
const LIGHT_LOCAL_OFFSET = 5;
const MERGED_AREA_THRESHOLD = 360;
const MAX_COMPONENT_AREA = 5200;

let referenceMedianGray = null;
let pendingMedianGray = null;
let pendingPreviewFrame = null;
let lastTriggerAt = 0;

function setStatus(text, level = "") {
  statusBox.className = `status ${level}`.trim();
  statusBox.textContent = text;
}

window.addEventListener("error", (event) => {
  const message = event?.error?.message || event.message || "Bilinmeyen JavaScript hatası";
  console.error("Global error:", event.error || event);
  setStatus(`Kod hatası: ${message}`, "danger");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const message = reason?.message || String(reason || "Bilinmeyen Promise hatası");
  console.error("Unhandled rejection:", reason);
  setStatus(`İşlem hatası: ${message}`, "danger");
});

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function ensureOpenCvReady(timeoutMs = 20000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    let candidate = window.cv;

    if (candidate instanceof Promise) {
      try {
        candidate = await candidate;
        window.cv = candidate;
      } catch (error) {
        throw new Error(`OpenCV yüklenemedi: ${error.message || error}`);
      }
    }

    if (candidate && typeof candidate.Mat === "function") {
      return candidate;
    }

    await delay(100);
  }

  throw new Error(
    "OpenCV.js yüklenemedi. İnternet bağlantısını kontrol edip sayfayı yenile."
  );
}

function deleteMat(mat) {
  if (mat && typeof mat.delete === "function") {
    mat.delete();
  }
}

function replaceReferenceMedian(nextMat) {
  deleteMat(referenceMedianGray);
  referenceMedianGray = nextMat;
}

function clearPendingDetection() {
  deleteMat(pendingMedianGray);
  pendingMedianGray = null;
  pendingPreviewFrame = null;
  candidateSuggestion = null;
  confirmSuggestedBtn.disabled = true;
}

function commitPendingReference() {
  if (pendingMedianGray) {
    replaceReferenceMedian(pendingMedianGray.clone());
  }

  if (pendingPreviewFrame) {
    referenceFrame = pendingPreviewFrame;
  }

  clearPendingDetection();
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

    if (
      detectorArmed &&
      !triggerLocked &&
      rms >= learnedThreshold &&
      time - lastTriggerAt >= TRIGGER_COOLDOWN_MS
    ) {
      lastTriggerAt = time;
      triggerProcessPipeline();
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
  if (lastRawFrames.length > 4) lastRawFrames.shift();
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
  replaceReferenceMedian(null);
  clearPendingDetection();
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

async function collectRawFrames(
  count = MEDIAN_FRAME_COUNT,
  intervalMs = FRAME_INTERVAL_MS
) {
  const frames = [];

  for (let index = 0; index < count; index++) {
    frames.push(captureRawFrame());
    if (index < count - 1) await delay(intervalMs);
  }

  return frames;
}

function imageDataToGrayBuffer(imageData) {
  const pixelCount = imageData.width * imageData.height;
  const gray = new Uint8Array(pixelCount);
  const source = imageData.data;

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    gray[pixel] = Math.round(
      source[offset] * 0.299 +
      source[offset + 1] * 0.587 +
      source[offset + 2] * 0.114
    );
  }

  return gray;
}

function grayMatFromWarpedImageData(imageData) {
  const grayBuffer = imageDataToGrayBuffer(imageData);
  const mat = new cv.Mat(
    imageData.height,
    imageData.width,
    cv.CV_8UC1
  );
  mat.data.set(grayBuffer);
  return mat;
}

function median3(a, b, c) {
  if (a > b) [a, b] = [b, a];
  if (b > c) [b, c] = [c, b];
  if (a > b) [a, b] = [b, a];
  return b;
}

function median5(a, b, c, d, e) {
  // Sabit boyutlu karşılaştırma ağı: Array.sort kullanmaz ve çok daha az yük üretir.
  if (a > b) [a, b] = [b, a];
  if (d > e) [d, e] = [e, d];
  if (a > c) [a, c] = [c, a];
  if (b > c) [b, c] = [c, b];
  if (a > d) [a, d] = [d, a];
  if (c > d) [c, d] = [d, c];
  if (b > e) [b, e] = [e, b];
  if (b > c) [b, c] = [c, b];
  if (d > e) [d, e] = [e, d];
  if (c > d) [c, d] = [d, c];
  return c;
}

function medianAt(buffers, index) {
  const count = buffers.length;

  if (count >= 5) {
    return median5(
      buffers[0][index],
      buffers[1][index],
      buffers[2][index],
      buffers[3][index],
      buffers[4][index]
    );
  }

  if (count === 4) {
    const values = [
      buffers[0][index],
      buffers[1][index],
      buffers[2][index],
      buffers[3][index]
    ];
    values.sort((a, b) => a - b);
    return Math.round((values[1] + values[2]) / 2);
  }

  return median3(
    buffers[0][index],
    buffers[1][index],
    buffers[2][index]
  );
}

async function buildMedianWarpedGray(rawFrames) {
  if (!rawFrames || rawFrames.length < 3) {
    throw new Error("Medyan görüntü için en az 3 kare gerekli.");
  }

  // En fazla 5 kare kullan. Eski kare dizilerinin gereksiz bellek tüketmesini önler.
  const selectedFrames = rawFrames.slice(-MEDIAN_FRAME_COUNT);
  const grayBuffers = [];
  let preview = null;

  // Kareleri tek tek dönüştür ve her kareden sonra tarayıcıya nefes ver.
  for (let frameIndex = 0; frameIndex < selectedFrames.length; frameIndex++) {
    const warped = warpFrame(selectedFrames[frameIndex]);
    grayBuffers.push(imageDataToGrayBuffer(warped));

    if (frameIndex === selectedFrames.length - 1) {
      preview = warped;
    }

    await yieldToBrowser();
  }

  const pixelCount = CANONICAL_SIZE * CANONICAL_SIZE;
  const output = new cv.Mat(
    CANONICAL_SIZE,
    CANONICAL_SIZE,
    cv.CV_8UC1
  );

  // 250.000 pikseli tek blokta işlemek yerine parçalara böl.
  const chunkSize = 6000;

  for (let start = 0; start < pixelCount; start += chunkSize) {
    const end = Math.min(pixelCount, start + chunkSize);

    for (let pixel = start; pixel < end; pixel++) {
      output.data[pixel] = medianAt(grayBuffers, pixel);
    }

    await yieldToBrowser();
  }

  return {
    gray: output,
    preview
  };
}

async function saveReference() {
  if (referenceBtn.dataset.busy === "1") return;

  if (corners.length !== 4) {
    setStatus("Önce hedefin dört köşesini seç.", "warn");
    return;
  }

  referenceBtn.dataset.busy = "1";
  referenceBtn.disabled = true;

  try {
    await ensureOpenCvReady();

    setStatus(
      "Tek sabit kareden referans hazırlanıyor...",
      "warn"
    );

    // Önce tarayıcıya durum mesajını çizme fırsatı ver.
    await yieldToBrowser();

    const rawFrame = captureRawFrame();

    // En ağır bölüm yalnızca bir kez çalışır.
    const warped = warpFrame(rawFrame);

    await yieldToBrowser();

    const gray = grayMatFromWarpedImageData(warped);
    replaceReferenceMedian(gray);
    clearPendingDetection();

    referenceFrame = warped;
    warpedCtx.putImageData(referenceFrame, 0, 0);
    drawCalibrationOverlay();

    // Eski yüksek çözünürlüklü kare geçmişini temizle.
    lastRawFrames = [rawFrame];

    targetCenter = null;
    centerSelectionMode = false;
    resetAffineCalibration();
    setRingCalibrationEnabled(false);
    centerBtn.disabled = false;
    armBtn.disabled = true;

    setStatus(
      `Referans kaydedildi (${CANONICAL_SIZE}×${CANONICAL_SIZE}). Şimdi hedef merkezini seç.`,
      "ok"
    );
  } catch (error) {
    console.error("saveReference failed:", error);
    setStatus(
      `Referans kaydedilemedi: ${error.message || error}`,
      "danger"
    );
  } finally {
    referenceBtn.dataset.busy = "0";
    referenceBtn.disabled = corners.length !== 4;
  }
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

function sampledShiftError(
  referenceGray,
  currentGray,
  dx,
  dy,
  step = 4
) {
  const width = referenceGray.cols;
  const height = referenceGray.rows;
  const referenceData = referenceGray.data;
  const currentData = currentGray.data;

  const margin = MAX_ALIGNMENT_SHIFT + 4;
  let total = 0;
  let count = 0;

  for (let y = margin; y < height - margin; y += step) {
    const sourceY = y - dy;
    if (sourceY < 0 || sourceY >= height) continue;

    for (let x = margin; x < width - margin; x += step) {
      const sourceX = x - dx;
      if (sourceX < 0 || sourceX >= width) continue;

      const referenceIndex = y * width + x;
      const currentIndex = sourceY * width + sourceX;

      total += Math.abs(
        referenceData[referenceIndex] - currentData[currentIndex]
      );
      count++;
    }
  }

  return count ? total / count : Number.POSITIVE_INFINITY;
}

function shiftGrayMat(source, dx, dy) {
  const result = new cv.Mat();
  const transform = cv.matFromArray(2, 3, cv.CV_64F, [
    1, 0, dx,
    0, 1, dy
  ]);

  cv.warpAffine(
    source,
    result,
    transform,
    new cv.Size(source.cols, source.rows),
    cv.INTER_LINEAR,
    cv.BORDER_REPLICATE,
    new cv.Scalar()
  );

  transform.delete();
  return result;
}

function alignGrayMats(
  referenceGray,
  currentGray,
  maxShift = MAX_ALIGNMENT_SHIFT
) {
  let bestDx = 0;
  let bestDy = 0;
  let bestError = Number.POSITIVE_INFINITY;

  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      const error = sampledShiftError(
        referenceGray,
        currentGray,
        dx,
        dy
      );

      if (error < bestError) {
        bestError = error;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  return {
    aligned: shiftGrayMat(currentGray, bestDx, bestDy),
    dx: bestDx,
    dy: bestDy,
    error: bestError
  };
}

function contourCircularity(contour) {
  const area = cv.contourArea(contour, false);
  const perimeter = cv.arcLength(contour, true);

  if (perimeter <= 0) return 0;
  return (4 * Math.PI * area) / (perimeter * perimeter);
}

function createContourMask(rows, cols, contour) {
  const mask = cv.Mat.zeros(rows, cols, cv.CV_8UC1);
  const contours = new cv.MatVector();

  contours.push_back(contour);
  cv.drawContours(
    mask,
    contours,
    0,
    new cv.Scalar(255),
    cv.FILLED
  );

  contours.delete();
  return mask;
}

function observedBlackRadiusPixels() {
  if (!targetCenter) return null;

  const distances = RING_DIRECTIONS
    .map((direction) => ringCalibrationPoints[direction])
    .filter(Boolean)
    .map((point) => {
      const dx = (point.x - targetCenter.x) * CANONICAL_SIZE;
      const dy = (point.y - targetCenter.y) * CANONICAL_SIZE;
      return Math.hypot(dx, dy);
    })
    .filter((distance) => Number.isFinite(distance) && distance > 5);

  if (!distances.length) return null;

  return (
    distances.reduce((total, distance) => total + distance, 0) /
    distances.length
  );
}

function createTargetRoiMask(rows, cols) {
  const mask = cv.Mat.zeros(rows, cols, cv.CV_8UC1);

  const centerX = targetCenter
    ? Math.round(targetCenter.x * (cols - 1))
    : Math.round(cols / 2);

  const centerY = targetCenter
    ? Math.round(targetCenter.y * (rows - 1))
    : Math.round(rows / 2);

  const blackRadius = observedBlackRadiusPixels();

  // Kalibrasyon varsa iç daire ölçeğinden dış arama alanını çıkar.
  // Kalibrasyon yoksa kâğıt kenarlarını dışarıda bırakacak güvenli bir daire kullan.
  const estimatedRadius = blackRadius
    ? blackRadius * BLACK_TO_OUTER_ROI_RATIO
    : Math.min(rows, cols) * 0.455;

  const radius = Math.round(
    Math.max(
      40,
      Math.min(
        estimatedRadius,
        Math.min(rows, cols) * 0.49 - ROI_EDGE_PADDING_PX
      )
    )
  );

  cv.circle(
    mask,
    new cv.Point(centerX, centerY),
    radius,
    new cv.Scalar(255),
    cv.FILLED
  );

  return {
    mask,
    centerX,
    centerY,
    radius
  };
}

function buildAdaptiveDifferenceMask(referenceGray, diff, roiMask) {
  const localMean = new cv.Mat();
  const otsuPreview = new cv.Mat();
  const adaptive = cv.Mat.zeros(diff.rows, diff.cols, cv.CV_8UC1);

  cv.blur(
    diff,
    localMean,
    new cv.Size(LOCAL_MEAN_BLOCK_SIZE, LOCAL_MEAN_BLOCK_SIZE)
  );

  const otsuThreshold = cv.threshold(
    diff,
    otsuPreview,
    0,
    255,
    cv.THRESH_BINARY + cv.THRESH_OTSU
  );

  const referenceData = referenceGray.data;
  const diffData = diff.data;
  const meanData = localMean.data;
  const roiData = roiMask.data;
  const outputData = adaptive.data;

  for (let index = 0; index < diffData.length; index++) {
    if (!roiData[index]) {
      outputData[index] = 0;
      continue;
    }

    const darkRegion = referenceData[index] < DARK_REFERENCE_CUTOFF;

    // Koyu bölgede düşük kontrastlı güvenli işaret değişimini kaybetmemek için
    // taban eşiği düşürülür. Açık bölgede gölge/parazit için daha sert eşik uygulanır.
    const globalFloor = darkRegion
      ? Math.max(4, otsuThreshold * 0.46)
      : Math.max(9, otsuThreshold * 0.88);

    const localFloor =
      meanData[index] +
      (darkRegion ? DARK_LOCAL_OFFSET : LIGHT_LOCAL_OFFSET);

    const threshold = Math.max(globalFloor, localFloor);
    outputData[index] = diffData[index] >= threshold ? 255 : 0;
  }

  localMean.delete();
  otsuPreview.delete();

  return {
    mask: adaptive,
    otsuThreshold
  };
}

function extractMergedPeaks(componentMask, rect, maxPeaks = 3) {
  const roi = componentMask.roi(rect);
  const distance = new cv.Mat();
  const peakMask = new cv.Mat();
  const peakContours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.distanceTransform(roi, distance, cv.DIST_L2, 3);

    const extrema = cv.minMaxLoc(distance);
    if (!extrema || extrema.maxVal < 1.5) return [];

    cv.threshold(
      distance,
      peakMask,
      extrema.maxVal * 0.42,
      255,
      cv.THRESH_BINARY
    );

    peakMask.convertTo(peakMask, cv.CV_8UC1);

    cv.findContours(
      peakMask,
      peakContours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE
    );

    const peaks = [];

    for (let index = 0; index < peakContours.size(); index++) {
      const contour = peakContours.get(index);

      try {
        const area = cv.contourArea(contour, false);
        if (area < 2) continue;

        const moments = cv.moments(contour, false);
        if (!moments.m00) continue;

        peaks.push({
          x: rect.x + moments.m10 / moments.m00,
          y: rect.y + moments.m01 / moments.m00,
          strength: area
        });
      } finally {
        contour.delete();
      }
    }

    peaks.sort((first, second) => second.strength - first.strength);
    return peaks.slice(0, maxPeaks);
  } finally {
    roi.delete();
    distance.delete();
    peakMask.delete();
    peakContours.delete();
    hierarchy.delete();
  }
}

function findNewMarker(referenceGray, currentGray) {
  const alignment = alignGrayMats(referenceGray, currentGray);
  const aligned = alignment.aligned;

  const diff = new cv.Mat();
  const blurred = new cv.Mat();
  const opened = new cv.Mat();
  const cleaned = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  const openKernel = cv.getStructuringElement(
    cv.MORPH_ELLIPSE,
    new cv.Size(3, 3)
  );

  const closeKernel = cv.getStructuringElement(
    cv.MORPH_ELLIPSE,
    new cv.Size(5, 5)
  );

  const roiInfo = createTargetRoiMask(
    referenceGray.rows,
    referenceGray.cols
  );

  const candidates = [];
  let adaptiveResult = null;

  try {
    // Çift yönlü değişim: hem açılmayı hem koyulaşmayı yakalar.
    cv.absdiff(referenceGray, aligned, diff);

    cv.GaussianBlur(
      diff,
      blurred,
      new cv.Size(3, 3),
      0,
      0,
      cv.BORDER_DEFAULT
    );

    adaptiveResult = buildAdaptiveDifferenceMask(
      referenceGray,
      blurred,
      roiInfo.mask
    );

    cv.morphologyEx(
      adaptiveResult.mask,
      opened,
      cv.MORPH_OPEN,
      openKernel
    );

    // Yakın/bitişik güvenli işaret parçalarını tekrar birleştir.
    cv.morphologyEx(
      opened,
      cleaned,
      cv.MORPH_CLOSE,
      closeKernel
    );

    cv.bitwise_and(
      cleaned,
      roiInfo.mask,
      cleaned
    );

    cv.findContours(
      cleaned,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE
    );

    const minArea = 9;
    const borderMargin = 5;

    for (let index = 0; index < contours.size(); index++) {
      const contour = contours.get(index);

      try {
        const area = cv.contourArea(contour, false);
        if (area < minArea || area > MAX_COMPONENT_AREA) continue;

        const rect = cv.boundingRect(contour);

        if (
          rect.x <= borderMargin ||
          rect.y <= borderMargin ||
          rect.x + rect.width >= CANONICAL_SIZE - borderMargin ||
          rect.y + rect.height >= CANONICAL_SIZE - borderMargin
        ) {
          continue;
        }

        const rawAspect = rect.width / Math.max(1, rect.height);
        const aspectCloseness =
          Math.min(rawAspect, 1 / Math.max(rawAspect, 0.0001));

        const circularity = contourCircularity(contour);
        const fillRatio =
          area / Math.max(1, rect.width * rect.height);

        const merged =
          area >= MERGED_AREA_THRESHOLD ||
          rect.width >= 27 ||
          rect.height >= 27;

        // Normal küçük işaretlerde çizgi/parazit filtresi sıkıdır.
        // Büyük/bitişik bileşenlerde filtre gevşetilir, fakat otomatik gönderim yapılmaz.
        const minAspect = merged ? 0.20 : 0.36;
        const maxAspect = merged ? 5.00 : 2.80;
        const minCircularity = merged ? 0.025 : 0.11;
        const minFill = merged ? 0.055 : 0.11;

        if (rawAspect < minAspect || rawAspect > maxAspect) continue;
        if (circularity < minCircularity) continue;
        if (fillRatio < minFill) continue;

        const moments = cv.moments(contour, false);
        if (!moments.m00) continue;

        const centerX = moments.m10 / moments.m00;
        const centerY = moments.m01 / moments.m00;

        const componentMask = createContourMask(
          cleaned.rows,
          cleaned.cols,
          contour
        );

        const meanDifference = cv.mean(diff, componentMask)[0];
        const meanReference = cv.mean(referenceGray, componentMask)[0];
        const darkRegion = meanReference < DARK_REFERENCE_CUTOFF;

        const areaScore = clamp01((area - minArea) / 230);
        const expectedFloor = darkRegion
          ? Math.max(4, adaptiveResult.otsuThreshold * 0.30)
          : Math.max(8, adaptiveResult.otsuThreshold * 0.55);

        const intensityScore = clamp01(
          (meanDifference - expectedFloor) / (darkRegion ? 34 : 48)
        );

        const circularityScore = clamp01(
          (circularity - minCircularity) /
          Math.max(0.15, 0.70 - minCircularity)
        );

        const aspectScore = clamp01(
          (aspectCloseness - minAspect) /
          Math.max(0.10, 1 - minAspect)
        );

        const fillScore = clamp01(
          (fillRatio - minFill) /
          Math.max(0.10, 0.62 - minFill)
        );

        const regionSensitivityBonus = darkRegion ? 0.06 : 0;
        const mergedPenalty = merged ? 0.12 : 0;

        const baseConfidence = clamp01(
          areaScore * 0.15 +
          intensityScore * 0.34 +
          circularityScore * 0.19 +
          aspectScore * 0.16 +
          fillScore * 0.16 +
          regionSensitivityBonus -
          mergedPenalty
        );

        const baseCandidate = {
          x: centerX / (CANONICAL_SIZE - 1),
          y: centerY / (CANONICAL_SIZE - 1),
          pixelX: centerX,
          pixelY: centerY,
          area,
          meanDifference,
          meanReference,
          darkRegion,
          circularity,
          aspectRatio: rawAspect,
          fillRatio,
          merged,
          confidence: baseConfidence
        };

        if (merged) {
          const peaks = extractMergedPeaks(componentMask, rect);

          if (peaks.length >= 2) {
            for (const peak of peaks) {
              candidates.push({
                ...baseCandidate,
                x: peak.x / (CANONICAL_SIZE - 1),
                y: peak.y / (CANONICAL_SIZE - 1),
                pixelX: peak.x,
                pixelY: peak.y,
                splitFromMerged: true,
                confidence: clamp01(baseConfidence * 0.88)
              });
            }
          } else {
            candidates.push(baseCandidate);
          }
        } else {
          candidates.push(baseCandidate);
        }

        componentMask.delete();
      } finally {
        contour.delete();
      }
    }

    candidates.sort(
      (first, second) => second.confidence - first.confidence
    );

    if (!candidates.length) {
      return {
        detected: false,
        confidence: 0,
        candidates: [],
        alignment,
        roi: {
          centerX: roiInfo.centerX,
          centerY: roiInfo.centerY,
          radius: roiInfo.radius
        }
      };
    }

    const best = candidates[0];
    const second = candidates[1];

    const uniqueness = second
      ? clamp01((best.confidence - second.confidence) / 0.24)
      : 1;

    const alignmentQuality = clamp01(1 - alignment.error / 22);

    best.confidence = clamp01(
      best.confidence * 0.76 +
      uniqueness * 0.14 +
      alignmentQuality * 0.10
    );

    // Bitişik/bölünmüş adaylar kullanıcı kontrolü olmadan gönderilmez.
    const requiresManualReview =
      Boolean(best.merged) ||
      Boolean(best.splitFromMerged) ||
      best.confidence < MIN_CONFIDENCE_TO_SEND;

    return {
      detected: !requiresManualReview,
      confidence: best.confidence,
      best,
      candidates: candidates.slice(0, 5),
      alignment,
      requiresManualReview,
      roi: {
        centerX: roiInfo.centerX,
        centerY: roiInfo.centerY,
        radius: roiInfo.radius
      }
    };
  } finally {
    aligned.delete();
    diff.delete();
    blurred.delete();
    opened.delete();
    cleaned.delete();
    contours.delete();
    hierarchy.delete();
    openKernel.delete();
    closeKernel.delete();
    roiInfo.mask.delete();

    if (adaptiveResult) {
      adaptiveResult.mask.delete();
    }
  }
}

function drawMarkerCandidates(detection) {
  if (!detection || !detection.candidates) return;

  warpedCtx.save();
  warpedCtx.font = "bold 13px system-ui";
  warpedCtx.textAlign = "left";
  warpedCtx.textBaseline = "middle";

  detection.candidates.forEach((candidate, index) => {
    const x = candidate.x * warpedPreview.width;
    const y = candidate.y * warpedPreview.height;
    const isBest = index === 0;

    warpedCtx.strokeStyle = isBest ? "#fbbf24" : "#60a5fa";
    warpedCtx.fillStyle = isBest ? "#fbbf24" : "#60a5fa";
    warpedCtx.lineWidth = isBest ? 3 : 2;

    warpedCtx.beginPath();
    warpedCtx.arc(x, y, isBest ? 12 : 9, 0, Math.PI * 2);
    warpedCtx.stroke();

    const regionTag = candidate.darkRegion ? "K" : "A";
    const mergedTag =
      candidate.splitFromMerged ? "·Bölünmüş" :
      candidate.merged ? "·Bitişik" :
      "";

    warpedCtx.fillText(
      `${index + 1}: %${Math.round(candidate.confidence * 100)} · ${regionTag}${mergedTag}`,
      x + 15,
      y
    );
  });

  warpedCtx.restore();
}

async function triggerProcessPipeline() {
  if (
    triggerLocked ||
    !referenceMedianGray ||
    corners.length !== 4
  ) {
    return;
  }

  triggerLocked = true;
  clearPendingDetection();

  try {
    await ensureOpenCvReady();

    send({
      type: "sensor_event",
      message: "Tanımlı ses algılandı. Güvenli işaret değişikliği aranıyor...",
      level: "info"
    });

    setStatus(
      `${MEDIAN_FRAME_COUNT} yeni kare toplanıyor ve hizalanıyor...`,
      "warn"
    );

    // Görüntünün oturması için kısa bekleme.
    await delay(260);

    const rawFrames = await collectRawFrames();
    const currentMedian = await buildMedianWarpedGray(rawFrames);
    const detection = findNewMarker(
      referenceMedianGray,
      currentMedian.gray
    );

    warpedCtx.putImageData(currentMedian.preview, 0, 0);
    drawCalibrationOverlay();
    drawMarkerCandidates(detection);

    if (detection.detected && detection.best) {
      const targetPoint = toTargetCoordinates(
        detection.best.x,
        detection.best.y
      );

      send({
        type: "shot",
        x: targetPoint.x,
        y: targetPoint.y,
        confidence: detection.best.confidence,
        status: "confirmed",
        source: "marker"
      });

      // Başarılı işaret yeni referansın parçası olur.
      replaceReferenceMedian(currentMedian.gray.clone());
      referenceFrame = currentMedian.preview;
      currentMedian.gray.delete();

      setStatus(
        `Yeni işaret otomatik bulundu. Güven: %${Math.round(
          detection.best.confidence * 100
        )} · hizalama: ${detection.alignment.dx},${detection.alignment.dy}px`,
        "ok"
      );
    } else {
      pendingMedianGray = currentMedian.gray;
      pendingPreviewFrame = currentMedian.preview;

      candidateSuggestion = detection.best
        ? {
            x: detection.best.x,
            y: detection.best.y,
            confidence: detection.best.confidence
          }
        : null;

      confirmSuggestedBtn.disabled = !candidateSuggestion;
      manualPanel.classList.remove("hidden");

      const confidenceText = detection.best
        ? `%${Math.round(detection.best.confidence * 100)}`
        : "aday yok";

      const reviewReason = detection.best?.merged || detection.best?.splitFromMerged
        ? "Bitişik/büyük değişiklik bulundu; manuel kontrol gerekli."
        : `Otomatik güven yetersiz (${confidenceText}).`;

      setStatus(
        `${reviewReason} En iyi adayı kontrol et veya görüntüye dokun.`,
        "warn"
      );

      send({
        type: "sensor_event",
        message: "İşaret değişikliği için manuel onay gerekli.",
        level: "warn"
      });
    }
  } catch (error) {
    console.error(error);
    setStatus(
      `Algılama hatası: ${error.message || error}`,
      "danger"
    );
  } finally {
    triggerLocked = false;
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
  commitPendingReference();
  manualPanel.classList.add("hidden");
  setStatus("Elle onaylanan işaret kaydedildi.", "ok");
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
  clearPendingDetection();
  setStatus("Düşük güvenli algılama iptal edildi.", "");
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
    replaceReferenceMedian(null);
    clearPendingDetection();
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
testBtn.addEventListener("click", triggerProcessPipeline);

connectSocket();
