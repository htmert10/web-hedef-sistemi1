from __future__ import annotations

import json
import math
import socket
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Web Hedef Sistemi")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@dataclass
class Shot:
    id: int
    number: int
    x: float
    y: float
    score: int
    confidence: float
    status: str
    source: str


class SessionState:
    def __init__(self) -> None:
        self.shots: list[Shot] = []
        self.next_id = 1

    @staticmethod
    def calculate_score(x: float, y: float) -> int:
        """Daha toleranslı ve gerçekçi scoring"""
        dx_mm = (x - 0.5) * 170.0
        dy_mm = (y - 0.5) * 170.0
        distance_mm = math.hypot(dx_mm, dy_mm)
    
        # 10'luk için daha geniş tolerans (gerçek mermi + algılama hatası)
        if distance_mm <= 7.5:
            return 10
        elif distance_mm <= 15.5:
            return 9
        elif distance_mm <= 23.5:
            return 8
        elif distance_mm <= 31.5:
            return 7
        elif distance_mm <= 39.5:
            return 6
        elif distance_mm <= 47.5:
            return 5
        elif distance_mm <= 55.5:
            return 4
        elif distance_mm <= 63.5:
            return 3
        elif distance_mm <= 71.5:
            return 2
        elif distance_mm <= 80.0:
            return 1
        return 0

    def add_shot(
        self,
        x: float,
        y: float,
        confidence: float,
        status: str,
        source: str,
    ) -> Shot:
        x = min(1.0, max(0.0, float(x)))
        y = min(1.0, max(0.0, float(y)))
        shot = Shot(
            id=self.next_id,
            number=len(self.shots) + 1,
            x=x,
            y=y,
            score=self.calculate_score(x, y),
            confidence=min(1.0, max(0.0, float(confidence))),
            status=status if status in {"confirmed", "suspect"} else "suspect",
            source=source,
        )
        self.next_id += 1
        self.shots.append(shot)
        return shot

    def delete_last(self) -> None:
        if self.shots:
            self.shots.pop()
        for index, shot in enumerate(self.shots, start=1):
            shot.number = index

    def reset(self) -> None:
        self.shots.clear()
        self.next_id = 1

    def payload(self) -> dict[str, Any]:
        total = sum(s.score for s in self.shots)
        average = total / len(self.shots) if self.shots else 0.0

        max_distance_mm = 0.0
        for i, first in enumerate(self.shots):
            for second in self.shots[i + 1 :]:
                dx = (first.x - second.x) * 170.0
                dy = (first.y - second.y) * 170.0
                max_distance_mm = max(max_distance_mm, math.hypot(dx, dy))

        return {
            "type": "state",
            "shots": [asdict(s) for s in self.shots],
            "stats": {
                "count": len(self.shots),
                "total": total,
                "average": round(average, 2),
                "group_mm": round(max_distance_mm, 1),
            },
        }


state = SessionState()


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections.add(websocket)
        await websocket.send_json(state.payload())

    def disconnect(self, websocket: WebSocket) -> None:
        self.connections.discard(websocket)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        stale: list[WebSocket] = []
        for connection in list(self.connections):
            try:
                await connection.send_json(payload)
            except Exception:
                stale.append(connection)
        for connection in stale:
            self.disconnect(connection)


manager = ConnectionManager()


@app.get("/")
async def home() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/tablet")
async def tablet() -> FileResponse:
    return FileResponse(STATIC_DIR / "tablet.html")


@app.get("/dashboard")
async def dashboard() -> FileResponse:
    return FileResponse(STATIC_DIR / "dashboard.html")


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"ok": True})


@app.get("/api/local-ip")
async def local_ip() -> JSONResponse:
    ip = "127.0.0.1"
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
    except OSError:
        pass
    return JSONResponse({"ip": ip})


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)
            except json.JSONDecodeError:
                continue

            kind = message.get("type")

            if kind == "shot":
                state.add_shot(
                    x=message.get("x", 0.5),
                    y=message.get("y", 0.5),
                    confidence=message.get("confidence", 0.5),
                    status=message.get("status", "suspect"),
                    source=message.get("source", "camera"),
                )
                await manager.broadcast(state.payload())

            elif kind == "delete_last":
                state.delete_last()
                await manager.broadcast(state.payload())

            elif kind == "reset":
                state.reset()
                await manager.broadcast(state.payload())

            elif kind == "request_state":
                await websocket.send_json(state.payload())

            elif kind == "sensor_event":
                await manager.broadcast(
                    {
                        "type": "sensor_event",
                        "message": str(message.get("message", "Sensör olayı")),
                        "level": str(message.get("level", "info")),
                    }
                )

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)
