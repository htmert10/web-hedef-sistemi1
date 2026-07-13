"use strict";

const $ = id => document.getElementById(id);
const canvas = $("target");
const ctx = canvas.getContext("2d");
let state = {shots: [], stats: {count: 0, total: 0, average: 0, group_mm: 0, series: []}, match: {}};
let socket;
let clockTimer;

function connect() {
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket.onmessage = event => { state = JSON.parse(event.data); render(); };
  socket.onclose = () => setTimeout(connect, 1500);
}

function send(data) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}

function ringRadius(score, scale) {
  return (5.75 + (10 - score) * 8) * scale;
}

function drawTarget() {
  const size = canvas.width;
  const center = size / 2;
  const scale = size / 170;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#ece7dc";
  ctx.fillRect(0, 0, size, size);

  for (let score = 1; score <= 10; score++) {
    const radius = ringRadius(score, scale);
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.fillStyle = score >= 7 ? "#151515" : "#ece7dc";
    ctx.fill();
    ctx.strokeStyle = score >= 7 ? "#c7c7c7" : "#343434";
    ctx.lineWidth = score === 1 ? 2 : 1.25;
    ctx.stroke();
  }

  ctx.font = `700 ${Math.max(11, Math.round(size / 62))}px system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let score = 1; score <= 9; score++) {
    const middleRadius = ringRadius(score, scale) - 4 * scale;
    ctx.fillStyle = score >= 7 ? "#e7e7e7" : "#282828";
    ctx.fillText(String(score), center, center - middleRadius);
    ctx.fillText(String(score), center + middleRadius, center);
  }

  ctx.strokeStyle = "#8a8a8a";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(center - 9, center); ctx.lineTo(center + 9, center);
  ctx.moveTo(center, center - 9); ctx.lineTo(center, center + 9);
  ctx.stroke();

  const pelletRadius = 2.25 * scale;
  const lastNumber = state.shots.at(-1)?.number;
  for (const shot of state.shots) {
    const x = shot.x * size;
    const y = shot.y * size;
    const isLast = shot.number === lastNumber;
    if (isLast) {
      ctx.beginPath();
      ctx.arc(x, y, pelletRadius + 5, 0, Math.PI * 2);
      ctx.strokeStyle = "#d6ff38";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, pelletRadius, 0, Math.PI * 2);
    ctx.fillStyle = isLast ? "#d6ff38" : "#ff665f";
    ctx.fill();
    ctx.strokeStyle = "#080b0d";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = "#080b0d";
    ctx.font = `900 ${Math.max(10, Math.round(pelletRadius * 1.15))}px system-ui`;
    ctx.fillText(String(shot.number), x, y + 0.5);
  }
}

function render() {
  drawTarget();
  const stats = state.stats;
  $("matchName").textContent = state.match.name || "Serbest antrenman";
  $("count").textContent = `${stats.count}${state.match.shot_limit ? " / " + state.match.shot_limit : ""}`;
  $("total").textContent = stats.total;
  $("average").textContent = Number(stats.average).toFixed(2);
  $("group").textContent = `${stats.group_mm} mm`;
  const last = state.shots.at(-1);
  $("lastScore").textContent = last?.score ?? "—";
  $("lastMeta").textContent = last ? `Ondalık ${last.decimal} · güven %${Math.round(last.confidence * 100)}` : "Atış bekleniyor";
  $("series").innerHTML = stats.series.length ? stats.series.map((value, index) => `<span>S${index + 1} · <b>${value}</b></span>`).join("") : "<span>Henüz seri yok</span>";
  $("shotList").innerHTML = state.shots.length ? [...state.shots].reverse().map(shot => `<div class="shot-row"><b>${shot.number}</b><span>${shot.source === "camera" ? "Kamera" : shot.source}</span><b>${shot.score}</b></div>`).join("") : '<div class="empty-row">Atışlar otomatik olarak burada görünecek.</div>';
  startClock();
}

function startClock() {
  clearInterval(clockTimer);
  const update = () => {
    if (!state.match.running || !state.match.duration_seconds) {
      $("clock").textContent = state.match.duration_seconds ? formatTime(state.match.duration_seconds) : "--:--";
      return;
    }
    const elapsed = (Date.now() - Number(state.match.started_at)) / 1000;
    $("clock").textContent = formatTime(Math.max(0, state.match.duration_seconds - elapsed));
  };
  update();
  clockTimer = setInterval(update, 500);
}

function formatTime(seconds) {
  seconds = Math.ceil(seconds);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

const presets = {
  free: ["Serbest antrenman", 0, 0],
  "40-50": ["40 atış · 50 dakika", 40, 3000],
  "50-50": ["50 atış · 50 dakika", 50, 3000],
  "60-75": ["60 atış · 1 saat 15 dakika", 60, 4500]
};

$("configure").onclick = () => {
  const [name, shot_limit, duration_seconds] = presets[$("preset").value];
  send({type: "configure_match", name, shot_limit, duration_seconds});
};
$("startMatch").onclick = () => send({type: "start_match", started_at: Date.now()});
$("stopMatch").onclick = () => send({type: "stop_match"});
$("deleteLast").onclick = () => send({type: "delete_last"});
$("reset").onclick = () => confirm("Tüm atışlar silinsin mi?") && send({type: "reset"});

connect();
drawTarget();
