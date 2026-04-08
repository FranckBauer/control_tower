import socket
from datetime import datetime, timezone

import uvicorn
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

try:
    from agent.api import router as api_router
    from agent.metrics import start_collector, get_history
except ImportError:
    from api import router as api_router
    from metrics import start_collector, get_history

app = FastAPI(title="Control Tower Agent")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "hostname": socket.gethostname(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/metrics/history")
async def metrics_history(minutes: int = Query(default=60)):
    """Return metrics history for the last N minutes."""
    return {"metrics": get_history(minutes)}


@app.on_event("startup")
async def on_startup():
    start_collector()


if __name__ == "__main__":
    uvicorn.run("agent.main:app", host="0.0.0.0", port=3001, reload=True)
