"use strict";

const $ = id => document.getElementById(id);
const canvas = $("target");
const ctx = canvas.getContext("2d");
let socket;
let state = {shots: [], fun_match: {active: false, completed: false, players: [], standings: [], ranking: []}};
let draftPlayers = [];

const escapeHtml = value => String(value).replace(/[&<>'"]/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[character]));

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
    ctx.beginPath();
    ctx.arc(center, center, ringRadius(score, scale), 0, Math.PI * 2);
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
    const radius = ringRadius(score, scale) - 4 * scale;
    ctx.fillStyle = score >= 7 ? "#e7e7e7" : "#282828";
    ctx.fillText(String(score), center, center - radius);
    ctx.fillText(String(score), center + radius, center);
  }
  ctx.strokeStyle = "#888";
  ctx.beginPath();
  ctx.moveTo(center - 9, center); ctx.lineTo(center + 9, center);
  ctx.moveTo(center, center - 9); ctx.lineTo(center, center + 9);
  ctx.stroke();

  const pelletRadius = 2.25 * scale;
  const activeIndex = state.fun_match.current_player_index;
  const visibleShots = state.shots.filter(shot => shot.player_index === activeIndex);
  const lastId = visibleShots.at(-1)?.id;
  for (const shot of visibleShots) {
    const x = shot.x * size;
    const y = shot.y * size;
    const isLast = shot.id === lastId;
    if (isLast) {
      ctx.beginPath(); ctx.arc(x, y, pelletRadius + 5, 0, Math.PI * 2);
      ctx.strokeStyle = "#d6ff38"; ctx.lineWidth = 3; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(x, y, pelletRadius, 0, Math.PI * 2);
    ctx.fillStyle = isLast ? "#d6ff38" : "#ff665f"; ctx.fill();
    ctx.strokeStyle = "#080b0d"; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.fillStyle = "#080b0d";
    ctx.font = `900 ${Math.max(10, Math.round(pelletRadius * 1.15))}px system-ui`;
    ctx.fillText(String(visibleShots.indexOf(shot) + 1), x, y + .5);
  }
}

function addPlayer() {
  const input = $("playerName");
  const name = input.value.trim().replace(/\s+/g, " ").slice(0, 30);
  if (!name || draftPlayers.some(player => player.toLocaleLowerCase("tr") === name.toLocaleLowerCase("tr"))) return;
  draftPlayers.push(name);
  input.value = "";
  input.focus();
  renderDraftPlayers();
}

function renderDraftPlayers() {
  $("playerChips").innerHTML = draftPlayers.map((name, index) => `<button class="player-chip" data-remove="${index}"><b>${index + 1}</b>${escapeHtml(name)}<span>×</span></button>`).join("");
  $("launchFun").disabled = draftPlayers.length < 2;
  $("setupHint").textContent = draftPlayers.length < 2 ? "Başlamak için en az 2 oyuncu ekle." : `${draftPlayers.length} oyuncu hazır · sıra eklenme sırasına göre ilerler.`;
}

function render() {
  const fun = state.fun_match;
  $("funSetup").classList.toggle("hidden", fun.active);
  $("funArena").classList.toggle("hidden", !fun.active || fun.completed);
  $("ceremony").classList.toggle("hidden", !fun.completed);
  if (!fun.active) return;
  if (fun.completed) {
    renderCeremony(fun);
    return;
  }

  const current = fun.standings[fun.current_player_index];
  $("currentPlayer").textContent = current?.name || "—";
  $("turnProgress").textContent = `${fun.current_shot} / ${fun.shots_per_player}`;
  $("funStandings").innerHTML = [...fun.standings].sort((a, b) => b.total - a.total || b.decimal_total - a.decimal_total).map((player, rank) => `<div class="standing-row ${player.index === fun.current_player_index ? "active" : ""}"><b>${rank + 1}</b><span>${escapeHtml(player.name)}<small>${player.count}/${fun.shots_per_player} atış</small></span><strong>${player.total}</strong></div>`).join("");
  const playerShots = state.shots.filter(shot => shot.player_index === fun.current_player_index);
  $("playerShots").innerHTML = playerShots.length ? playerShots.map((shot, index) => `<span><b>${index + 1}</b>${shot.score}<small>${shot.decimal}</small></span>`).join("") : "<em>İlk atış bekleniyor…</em>";
  const last = state.shots.at(-1);
  $("funLastScore").textContent = last?.score ?? "—";
  $("funLastMeta").textContent = last ? `${escapeHtml(last.player_name)} · ondalık ${last.decimal}` : "Atış bekleniyor";
  drawTarget();
}

function renderCeremony(fun) {
  const ranking = fun.ranking;
  const podiumOrder = [ranking[1], ranking[0], ranking[2]].filter(Boolean);
  const places = ranking.length > 2 ? [2, 1, 3] : [2, 1];
  $("podium").innerHTML = podiumOrder.map((player, index) => `<div class="podium-place place-${places[index]}"><span>${places[index] === 1 ? "🏆" : places[index] === 2 ? "🥈" : "🥉"}</span><strong>${escapeHtml(player.name)}</strong><b>${player.total} puan</b><small>${player.decimal_total} ondalık</small></div>`).join("");
  $("allResults").innerHTML = ranking.map((player, index) => `<div><b>${index + 1}</b><span>${escapeHtml(player.name)}</span><strong>${player.total}</strong><small>${player.decimal_total}</small></div>`).join("");
}

$("addPlayer").onclick = addPlayer;
$("playerName").onkeydown = event => { if (event.key === "Enter") addPlayer(); };
$("playerChips").onclick = event => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  draftPlayers.splice(Number(button.dataset.remove), 1);
  renderDraftPlayers();
};
$("launchFun").onclick = () => send({type: "configure_fun_match", players: draftPlayers, shots_per_player: Number($("funShotCount").value), started_at: Date.now()});
$("funDeleteLast").onclick = () => send({type: "delete_last"});
$("abandonFun").onclick = () => confirm("Bu maç kapatılıp yeni maç kurulsun mu?") && send({type: "new_fun_match"});
$("newFun").onclick = () => send({type: "new_fun_match"});

renderDraftPlayers();
drawTarget();
connect();
