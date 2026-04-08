"""
Control Tower - Central dashboard server.
Serves the frontend UI and proxies API requests to individual machine agents.
"""

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from dashboard.proxy import router as proxy_router
from dashboard.auth import router as auth_router, _check_auth

app = FastAPI(title="Control Tower")


class AuthMiddleware(BaseHTTPMiddleware):
    """Redirect to login page if not authenticated."""

    EXEMPT_PATHS = {"/auth/login", "/auth/logout", "/auth/check", "/favicon.svg"}

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Allow auth routes and static assets
        if path in self.EXEMPT_PATHS or path.startswith("/auth/"):
            return await call_next(request)

        # Check session
        if not _check_auth(request):
            # API calls get 401, browser requests get redirect
            if path.startswith("/api/"):
                from fastapi.responses import JSONResponse
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Not authenticated"},
                )
            return RedirectResponse(url="/auth/login")

        return await call_next(request)


# Add middlewares
app.add_middleware(AuthMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(auth_router)
app.include_router(proxy_router)

# Mount frontend static files LAST
frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
