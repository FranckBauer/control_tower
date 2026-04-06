"""
Pi Dashboard - Central dashboard server for managing multiple Raspberry Pi machines.

Serves the frontend UI and proxies API requests to individual machine agents.
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from dashboard.proxy import router as proxy_router

app = FastAPI(title="Pi Dashboard")

# CORS middleware - allow all origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include the proxy router (API routes)
app.include_router(proxy_router)

# Mount frontend static files LAST so it doesn't catch API routes
frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
