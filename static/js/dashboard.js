"use strict";

const canvas = document.getElementById("targetCanvas");
const ctx = canvas.getContext("2d");
const eventStatus = document.getElementById("eventStatus");
const countMetric = document.getElementById("countMetric");
const totalMetric = document.getElementById("totalMetric");
const averageMetric = document.getElementById("averageMetric");
const groupMetric = document.getElementById("groupMetric");
const shotRows = document.getElementById("shotRows");
const deleteLastBtn = document.getElementById("deleteLastBtn");
const resetBtn = document.getElementById("resetBtn");

let socket = null;
let currentState = { shots: [], stats: { count: 0, total: 0, average: 0, group_mm: 0 } };

function wsUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

function connect() {
  socket = new WebSocket(wsUrl());

  socket.addEventListener("open", () => {
    eventStatus.className = "status ok";
    eventStatus.textContent = "Sunucuya bağlandı. Telefon sensörü bekleniyor.";
    socket.send(JSON.stringify({ type: "request_state" }));
  });

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "state") {
      const oldCount = currentState.shots.length;
      currentState = data;
      render();
      if (data.shots.length > oldCount) {
        const last = data.shots[data.shots.length - 1];
        eventStatus.className = last.status === "confirmed" ? "status ok" : "status warn";
        eventStatus.textContent =
          last.status === "confirmed"
            ? `Yeni atış: ${last.number}. atış, ${last.score} puan`
            : `Şüpheli atış: ${last.number}. atış, önerilen konum kaydedildi`;
      }
    }

    if (data.type === "sensor_event") {
      eventStatus.className = `status ${data.level === "warn" ? "warn" : "ok"}`;
      eventStatus.textContent = data.message;
    }
  });

  socket.addEventListener("close", () => {
    eventStatus.className = "status danger";
    eventStatus.textContent = "Bağlantı koptu, yeniden bağlanılıyor...";
    setTimeout(connect, 1500);
  });
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function drawTarget() {
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const scale = w / 170;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#e9e3d8";
  ctx.fillRect(0, 0, w, h);

  for (let score = 1; score <= 10; score++) {
    const radiusMm = (11 - score) * 8 - 2.25;
    const radius = Math.max(2, radiusMm * scale);

    const darkRing = score >= 7;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = darkRing ? "#111" : "#eee8dc";
    ctx.fill();
    ctx.lineWidth = Math.max(1, scale * 0.12);
    ctx.strokeStyle = darkRing ? "#ddd" : "#222";
    ctx.stroke();
  }

  ctx.fillStyle = "#111";
  ctx.font = "bold 15px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let score = 1; score <= 6; score++) {
    const radiusMm = (11 - score) * 8 - 2.25;
    ctx.fillText(String(score), cx, cy - radiusMm * scale + 13);
  }
}

function drawShots() {
  const w = canvas.width;
  for (const shot of currentState.shots) {
    const x = shot.x * w;
    const y = shot.y * w;
    const radius = 10;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = shot.status === "confirmed" ? "#43e17d" : "#ffd15c";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#08110c";
    ctx.stroke();

    ctx.fillStyle = "#07110b";
    ctx.font = "bold 12px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(shot.number), x, y + 0.5);
    ctx.restore();
  }
}

function renderTable() {
  shotRows.innerHTML = "";
  [...currentState.shots].reverse().forEach((shot) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${shot.number}</td>
      <td><strong>${shot.score}</strong></td>
      <td>
        <span class="badge ${shot.status === "confirmed" ? "ok" : "warn"}">
          ${shot.status === "confirmed" ? "Kesin" : "Şüpheli"}
        </span>
      </td>
      <td>${Math.round(shot.confidence * 100)}%</td>
    `;
    shotRows.appendChild(tr);
  });
}

function render() {
  drawTarget();
  drawShots();
  renderTable();

  const stats = currentState.stats;
  countMetric.textContent = stats.count;
  totalMetric.textContent = stats.total;
  averageMetric.textContent = Number(stats.average).toFixed(2);
  groupMetric.textContent = `${Number(stats.group_mm).toFixed(1)} mm`;
}

deleteLastBtn.addEventListener("click", () => send({ type: "delete_last" }));
resetBtn.addEventListener("click", () => {
  if (confirm("Tüm seri sıfırlansın mı?")) send({ type: "reset" });
});

drawTarget();
connect();
