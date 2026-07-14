from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
TARGET_MM = 170.0
PELLET_RADIUS_MM = 2.25

app = FastAPI(title="Hedef Takip Sistemi")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@dataclass
class Shot:
    id: int
    number: int
    x: float
    y: float
    score: int
    decimal: float
    confidence: float
    source: str
    player_index: int | None = None
    player_name: str | None = None


class MatchState:
    def __init__(self) -> None:
        self.shots: list[Shot] = []
        self.next_id = 1
        self.match = {
            "name": "Serbest antrenman",
            "shot_limit": 0,
            "duration_seconds": 0,
            "started_at": None,
            "running": False,
        }
        self.fun_match = {
            "active": False,
            "completed": False,
            "shots_per_player": 5,
            "players": [],
        }

    @staticmethod
    def scores(x: float, y: float) -> tuple[int, float]:
        distance_mm = math.hypot(x - 0.5, y - 0.5) * TARGET_MM
        integer = 0
        for value in range(10, 0, -1):
            if distance_mm <= (11 - value) * 8.0 + 1e-9:
                integer = value
                break

        # Her 0.8 mm yarıçap artışı ondalık puanı 0.1 azaltır.
        decimal = max(0.0, min(10.9, 10.9 - distance_mm / 8.0))
        return integer, round(decimal, 1)

    def add_shot(self, message: dict[str, Any]) -> None:
        player_index = None
        player_name = None
        if self.fun_match["active"]:
            players = self.fun_match["players"]
            shots_per_player = int(self.fun_match["shots_per_player"])
            player_index = len(self.shots) // shots_per_player
            if self.fun_match["completed"] or player_index >= len(players):
                return
            player_name = players[player_index]

        limit = int(self.match["shot_limit"] or 0)
        if limit and len(self.shots) >= limit:
            return

        x = min(1.0, max(0.0, float(message.get("x", 0.5))))
        y = min(1.0, max(0.0, float(message.get("y", 0.5))))
        score, decimal = self.scores(x, y)
        self.shots.append(
            Shot(
                id=self.next_id,
                number=len(self.shots) + 1,
                x=x,
                y=y,
                score=score,
                decimal=decimal,
                confidence=min(1.0, max(0.0, float(message.get("confidence", 0.0)))),
                source=str(message.get("source", "camera")),
                player_index=player_index,
                player_name=player_name,
            )
        )
        self.next_id += 1
        if self.fun_match["active"]:
            maximum = len(self.fun_match["players"]) * int(self.fun_match["shots_per_player"])
            if len(self.shots) >= maximum:
                self.fun_match["completed"] = True
                self.match["running"] = False

    def reset(self) -> None:
        self.shots.clear()
        self.next_id = 1
        if self.fun_match["active"]:
            self.fun_match["completed"] = False

    def configure_fun_match(self, message: dict[str, Any]) -> None:
        raw_players = message.get("players", [])
        players: list[str] = []
        for raw_name in raw_players[:50]:
            name = " ".join(str(raw_name).strip().split())[:30]
            if name and name.casefold() not in {item.casefold() for item in players}:
                players.append(name)
        if len(players) < 2:
            return

        shots_per_player = max(1, min(20, int(message.get("shots_per_player", 5))))
        self.reset()
        self.fun_match = {
            "active": True,
            "completed": False,
            "shots_per_player": shots_per_player,
            "players": players,
        }
        self.match = {
            "name": "Eğlence Maçı",
            "shot_limit": len(players) * shots_per_player,
            "duration_seconds": 0,
            "started_at": message.get("started_at"),
            "running": True,
        }

    def fun_payload(self) -> dict[str, Any]:
        players = self.fun_match["players"]
        shots_per_player = int(self.fun_match["shots_per_player"])
        standings = []
        for index, name in enumerate(players):
            player_shots = [shot for shot in self.shots if shot.player_index == index]
            standings.append(
                {
                    "index": index,
                    "name": name,
                    "count": len(player_shots),
                    "total": sum(shot.score for shot in player_shots),
                    "decimal_total": round(sum(shot.decimal for shot in player_shots), 1),
                    "best": max((shot.decimal for shot in player_shots), default=0.0),
                }
            )

        ranked = sorted(
            standings,
            key=lambda item: (item["total"], item["decimal_total"], item["best"]),
            reverse=True,
        )
        current_index = min(len(self.shots) // shots_per_player, max(0, len(players) - 1)) if players else 0
        return {
            **self.fun_match,
            "current_player_index": current_index,
            "current_shot": len(self.shots) % shots_per_player,
            "standings": standings,
            "ranking": ranked if self.fun_match["completed"] else [],
        }

    def payload(self) -> dict[str, Any]:
        total = sum(shot.score for shot in self.shots)
        decimal_total = round(sum(shot.decimal for shot in self.shots), 1)
        group_mm = 0.0
        for index, first in enumerate(self.shots):
            for second in self.shots[index + 1 :]:
                group_mm = max(
                    group_mm,
                    math.hypot(first.x - second.x, first.y - second.y) * TARGET_MM,
                )

        series = []
        for start in range(0, len(self.shots), 10):
            block = self.shots[start : start + 10]
            series.append(sum(shot.score for shot in block))

        return {
            "type": "state",
            "shots": [asdict(shot) for shot in self.shots],
            "match": self.match,
            "fun_match": self.fun_payload(),
            "stats": {
                "count": len(self.shots),
                "total": total,
                "decimal_total": decimal_total,
                "average": round(total / len(self.shots), 2) if self.shots else 0,
                "group_mm": round(group_mm, 1),
                "series": series,
            },
        }


state = MatchState()


class Connections:
    def __init__(self) -> None:
        self.items: set[WebSocket] = set()

    async def connect(self, socket: WebSocket) -> None:
        await socket.accept()
        self.items.add(socket)
        await socket.send_json(state.payload())

    async def broadcast(self, payload: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        for socket in list(self.items):
            try:
                await socket.send_json(payload)
            except Exception:
                dead.append(socket)
        for socket in dead:
            self.items.discard(socket)


connections = Connections()


@app.get("/")
async def home() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/tablet")
async def tablet() -> FileResponse:
    return FileResponse(STATIC_DIR / "tablet.html")


@app.get("/dashboard")
async def dashboard() -> FileResponse:
    return FileResponse(STATIC_DIR / "dashboard.html")


@app.get("/fun")
async def fun_match() -> FileResponse:
    return FileResponse(STATIC_DIR / "fun.html")


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"ok": True})


@app.websocket("/ws")
async def websocket(socket: WebSocket) -> None:
    await connections.connect(socket)
    try:
        while True:
            try:
                message = json.loads(await socket.receive_text())
            except json.JSONDecodeError:
                continue

            kind = message.get("type")
            if kind == "shot":
                state.add_shot(message)
            elif kind == "delete_last" and state.shots:
                state.shots.pop()
                if state.fun_match["active"]:
                    state.fun_match["completed"] = False
                    state.match["running"] = True
            elif kind == "reset":
                state.reset()
            elif kind == "configure_match":
                state.reset()
                state.fun_match["active"] = False
                state.fun_match["completed"] = False
                state.match = {
                    "name": str(message.get("name", "Özel maç"))[:80],
                    "shot_limit": max(0, min(200, int(message.get("shot_limit", 0)))),
                    "duration_seconds": max(0, min(8 * 3600, int(message.get("duration_seconds", 0)))),
                    "started_at": None,
                    "running": False,
                }
            elif kind == "configure_fun_match":
                state.configure_fun_match(message)
            elif kind == "new_fun_match":
                state.reset()
                state.fun_match = {
                    "active": False,
                    "completed": False,
                    "shots_per_player": 5,
                    "players": [],
                }
                state.match = {
                    "name": "Serbest antrenman",
                    "shot_limit": 0,
                    "duration_seconds": 0,
                    "started_at": None,
                    "running": False,
                }
            elif kind == "start_match":
                state.match["started_at"] = message.get("started_at")
                state.match["running"] = True
            elif kind == "stop_match":
                state.match["running"] = False
            else:
                continue

            await connections.broadcast(state.payload())
    except WebSocketDisconnect:
        connections.items.discard(socket)
    except Exception:
        connections.items.discard(socket)
