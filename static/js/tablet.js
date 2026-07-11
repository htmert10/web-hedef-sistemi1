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
const ring9Btn = document.getElementById("ring9Btn");
const ring8Btn = document.getElementById("ring8Btn");
const ring7Btn = document.getElementById("ring7Btn");
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
const ring9Value = document.getElementById("ring9Value");
const ring8Value = document.getElementById("ring8Value");
const ring7Value = document.getElementById("ring7Value");
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
let ringSelectionMode = null;
let ringReferences = { 9: null, 8: null, 7: null };
let calibrationScale = 1;
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

function setRingButtonsEnabled(enabled) {
  const buttons = [ring9Btn, ring8Btn, ring7Btn];

  for (const button of buttons) {
    if (!button) continue;

    button.disabled = !enabled;

    if (enabled) {
      button.removeAttribute("disabled");
      button.setAttribute("aria-disabled", "false");
    } else {
      button.setAttribute("disabled", "");
      button.setAttribute("aria-disabled", "true");
    }
  }
}

function resetRingCalibration() {
  ringSelectionMode = null;
  ringReferences = { 9: null, 8: null, 7: null };
  calibrationScale = 1;
  calibrationReady = false;

  ring9Btn.textContent = "5. 9 halkasını seç";
  ring8Btn.textContent = "6. 8 halkasını seç";
  ring7Btn.textContent = "7. 7 halkasını seç";

  ring9Value.textContent = "Seçilmedi";
  ring8Value.textContent = "Seçilmedi";
  ring7Value.textContent = "Seçilmedi";
  calibrationQuality.textContent = "Halka ölçeği henüz hazır değil.";
}

function updateRingValue(score, point) {
  const element = score === 9 ? ring9Value : score === 8 ? ring8Value : ring7Value;
  if (!point) {
    element.textContent = "Seçilmedi";
    return;
  }
  element.textContent = `${Math.round(point.radius * CANONICAL_SIZE)} px`;
}

function calculateRingCalibration() {
  const scores = [9, 8, 7];
  const entries = scores
    .map((score) => ({ score, point: ringReferences[score] }))
    .filter((entry) => entry.point);

  if (entries.length < 3) {
    calibrationReady = false;
    armBtn.disabled = true;
    calibrationQuality.textContent =
      `${entries.length}/3 halka seçildi. 9, 8 ve 7 halkalarının üçü de gerekli.`;
    return false;
  }

  const r9 = ringReferences[9].radius;
  const r8 = ringReferences[8].radius;
  const r7 = ringReferences[7].radius;

  if (!(r9 < r8 && r8 < r7)) {
    calibrationReady = false;
    armBtn.disabled = true;
    calibrationQuality.textContent =
      "Halka sırası hatalı görünüyor. Merkezden uzaklık 9 < 8 < 7 olmalı.";
    return false;
  }

  let numerator = 0;
  let denominator = 0;

  for (const { score, point } of entries) {
    const expected = expectedRingRadiusNormalized(score);
    numerator += point.radius * expected;
    denominator += point.radius * point.radius;
  }

  if (denominator <= 1e-9) {
    calibrationReady = false;
    armBtn.disabled = true;
    calibrationQuality.textContent = "Halka ölçeği hesaplanamadı.";
    return false;
  }

  calibrationScale = numerator / denominator;

  const residualsMm = entries.map(({ score, point }) => {
    const expected = expectedRingRadiusNormalized(score);
    const predicted = point.radius * calibrationScale;
    return Math.abs(predicted - expected) * 170;
  });

  const maxErrorMm = Math.max(...residualsMm);
  const averageErrorMm =
    residualsMm.reduce((total, value) => total + value, 0) / residualsMm.length;

  calibrationReady = true;
  armBtn.disabled = false;

  let quality = "İyi";
  if (maxErrorMm > 2.5) quality = "Zayıf";
  else if (maxErrorMm > 1.2) quality = "Orta";

  calibrationQuality.textContent =
    `Kalibrasyon hazır · kalite: ${quality} · ortalama hata: ${averageErrorMm.toFixed(1)} mm`;

  return true;
}

function toTargetCoordinates(paperX, paperY) {
  const center = targetCenter || { x: 0.5, y: 0.5 };
  const scale = calibrationReady ? calibrationScale : 1;

  return {
    x: clamp01(0.5 + (paperX - center.x) * scale),
    y: clamp01(0.5 + (paperY - center.y) * scale)
  };
}

function toPaperCoordinates(targetX, targetY) {
  const center = targetCenter || { x: 0.5, y: 0.5 };
  const scale = calibrationReady && calibrationScale > 1e-9
    ? calibrationScale
    : 1;

  return {
    x: clamp01(center.x + (targetX - 0.5) / scale),
    y: clamp01(center.y + (targetY - 0.5) / scale)
  };
}

function drawCalibrationOverlay() {
  if (!targetCenter) return;

  const centerX = targetCenter.x * warpedPreview.width;
  const centerY = targetCenter.y * warpedPreview.height;

  warpedCtx.save();

  if (calibrationReady && calibrationScale > 1e-9) {
    warpedCtx.setLineDash([7, 6]);
    warpedCtx.lineWidth = 1.5;
    warpedCtx.strokeStyle = "rgba(77, 163, 255, .72)";

    for (let score = 10; score >= 1; score--) {
      const normalizedRadius =
        expectedRingRadiusNormalized(score) / calibrationScale;
      const radiusPx = normalizedRadius * warpedPreview.width;

      warpedCtx.beginPath();
      warpedCtx.arc(centerX, centerY, radiusPx, 0, Math.PI * 2);
      warpedCtx.stroke();
    }

    warpedCtx.setLineDash([]);
  }

  const selectedStyles = {
    9: "#4ade80",
    8: "#fbbf24",
    7: "#fb7185"
  };

  for (const score of [9, 8, 7]) {
    const point = ringReferences[score];
    if (!point) continue;

    const pointX = point.x * warpedPreview.width;
    const pointY = point.y * warpedPreview.height;

    warpedCtx.strokeStyle = selectedStyles[score];
    warpedCtx.fillStyle = selectedStyles[score];
    warpedCtx.lineWidth = 3;

    warpedCtx.beginPath();
    warpedCtx.arc(
      centerX,
      centerY,
      point.radius * warpedPreview.width,
      0,
      Math.PI * 2
    );
    warpedCtx.stroke();

    warpedCtx.beginPath();
    warpedCtx.arc(pointX, pointY, 7, 0, Math.PI * 2);
    warpedCtx.fill();

    warpedCtx.font = "bold 16px system-ui";
    warpedCtx.fillText(String(score), pointX + 10, pointY - 10);
  }

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

function beginRingSelection(score) {
  if (!referenceFrame || !targetCenter) {
    setStatus("Önce temiz hedefi kaydet ve hedef merkezini seç.", "warn");
    return;
  }

  detectorArmed = false;
  armBtn.textContent = "9. Sistemi hazırla";
  armBtn.className = "";
  ringSelectionMode = score;

  setStatus(
    `Düzeltilmiş hedefte ${score} halka çizgisinin herhangi bir noktasına dokun.`,
    "warn"
  );
}

function saveRingReference(score, x, y) {
  if (!targetCenter) return;

  const dx = x - targetCenter.x;
  const dy = y - targetCenter.y;
  const radius = Math.hypot(dx, dy);

  if (radius < 0.015) {
    setStatus("Seçilen nokta merkeze fazla yakın. Halka çizgisinin üstüne dokun.", "warn");
    return;
  }

  ringReferences[score] = { x, y, radius };
  ringSelectionMode = null;

  updateRingValue(score, ringReferences[score]);

  if (score === 9) ring9Btn.textContent = "5. 9 halkasını yeniden seç";
  if (score === 8) ring8Btn.textContent = "6. 8 halkasını yeniden seç";
  if (score === 7) ring7Btn.textContent = "7. 7 halkasını yeniden seç";

  if (referenceFrame) {
    warpedCtx.putImageData(referenceFrame, 0, 0);
    drawCalibrationOverlay();
  }

  const ready = calculateRingCalibration();

  if (ready) {
    setStatus(
      "9, 8 ve 7 halkaları kaydedildi. Diğer halkalar otomatik hesaplandı.",
      "ok"
    );
    send({
      type: "sensor_event",
      message: "Halka ölçeği kalibre edildi. Puanlama yeni ölçeğe göre hazır.",
      level: "info"
    });
  } else {
    const nextMissing = [9, 8, 7].find((value) => !ringReferences[value]);
    if (nextMissing) {
      setStatus(
        `${score} halkası kaydedildi. Şimdi ${nextMissing} halka çizgisini seç.`,
        "ok"
      );
    }
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
  setRingButtonsEnabled(false);
  resetRingCalibration();
  armBtn.textContent = "9. Sistemi hazırla";
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
  resetRingCalibration();
  setRingButtonsEnabled(false);
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
      "Önce köşeleri, temiz hedefi, merkezi ve 9-8-7 halka referanslarını tamamla.",
      "warn"
    );
    return;
  }

  detectorArmed = !detectorArmed;
  armBtn.textContent = detectorArmed ? "Sistemi durdur" : "9. Sistemi hazırla";
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

  send({
    type: "sensor_event",
    message: "Tanımlı ses algılandı. Görüntüler karşılaştırılıyor...",
    level: "info"
  });
  setStatus("Atış olayı algılandı. Önceki ve sonraki görüntü karşılaştırılıyor.", "warn");

  const beforeRaw =
    lastRawFrames[Math.max(0, lastRawFrames.length - 3)] ||
    captureRawFrame();

  await new Promise((resolve) => setTimeout(resolve, 650));

  const afterRaw = captureRawFrame();
  const beforeWarped = warpFrame(beforeRaw);
  const afterWarped = warpFrame(afterRaw);
  warpedCtx.putImageData(afterWarped, 0, 0);
  drawCalibrationOverlay();

  const candidate = findNewHole(beforeWarped, afterWarped);

  if (candidate) {
    const targetPoint = toTargetCoordinates(candidate.x, candidate.y);
    send({
      type: "shot",
      x: targetPoint.x,
      y: targetPoint.y,
      confidence: candidate.confidence,
      status: "confirmed",
      source: "camera"
    });

    referenceFrame = afterWarped;
    setStatus(
      `Yeni delik bulundu. Güven: %${Math.round(candidate.confidence * 100)}.`,
      "ok"
    );
  } else {
    candidateSuggestion =
      findOverlapSuggestion(beforeWarped, afterWarped) ||
      { x: 0.5, y: 0.5, confidence: 0.18 };

    manualPanel.classList.remove("hidden");
    send({
      type: "sensor_event",
      message: "Atış algılandı; yeni delik kesin bulunamadı. Muhtemel üst üste atış.",
      level: "warn"
    });
    setStatus(
      "Yeni delik kesin bulunamadı. Hedefe dokunarak konum seç veya öneriyi kaydet.",
      "warn"
    );
  }

  setTimeout(() => {
    triggerLocked = false;
  }, 1000);
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
    resetRingCalibration();
    setRingButtonsEnabled(true);

    // Mobil tarayıcı önbelleği / DOM senkronizasyonuna karşı ikinci güvence.
    requestAnimationFrame(() => setRingButtonsEnabled(true));
    setTimeout(() => setRingButtonsEnabled(true), 100);

    armBtn.disabled = true;

    if (referenceFrame) {
      warpedCtx.putImageData(referenceFrame, 0, 0);
      drawCalibrationOverlay();
    }

    setStatus(
      "Hedef merkezi kaydedildi. 9, 8 ve 7 halka butonları etkinleştirildi. [FIX-2]",
      "ok"
    );
    return;
  }

  if (ringSelectionMode !== null) {
    saveRingReference(ringSelectionMode, x, y);
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
  ringSelectionMode = null;
  detectorArmed = false;
  resetRingCalibration();
  setRingButtonsEnabled(false);
  armBtn.textContent = "9. Sistemi hazırla";
  armBtn.disabled = true;

  setStatus(
    "Düzeltilmiş hedefte 10 halkasının tam merkezine bir kez dokun.",
    "warn"
  );
});

ring9Btn.addEventListener("click", () => beginRingSelection(9));
ring8Btn.addEventListener("click", () => beginRingSelection(8));
ring7Btn.addEventListener("click", () => beginRingSelection(7));

zoomRange.addEventListener("input", () => {
  softwareZoom = Number(zoomRange.value);
  zoomText.textContent = softwareZoom.toFixed(1);
  drawCameraPreview();

  if (corners.length > 0 || referenceFrame) {
    corners = [];
    referenceFrame = null;
    targetCenter = null;
    centerSelectionMode = false;
    ringSelectionMode = null;
    detectorArmed = false;
    centerBtn.disabled = true;
    centerBtn.textContent = "4. Hedef merkezini seç";
    setRingButtonsEnabled(false);
    resetRingCalibration();
    armBtn.textContent = "9. Sistemi hazırla";
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
