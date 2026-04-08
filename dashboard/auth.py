"""
Authentication module for Control Tower.
Simple token-based auth with login page.
"""

import hashlib
import secrets
import time
from pathlib import Path

from fastapi import APIRouter, Request, Response, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse

router = APIRouter()

# Config
AUTH_FILE = Path(__file__).resolve().parent.parent / "auth.json"
SESSION_DURATION = 86400 * 7  # 7 days
SESSION_FILE = Path(__file__).resolve().parent.parent / ".sessions.json"


def _load_sessions() -> dict:
    """Load sessions from file."""
    import json
    if SESSION_FILE.exists():
        try:
            data = json.loads(SESSION_FILE.read_text())
            # Clean expired sessions
            now = time.time()
            return {k: v for k, v in data.items() if v.get("expires", 0) > now}
        except Exception:
            pass
    return {}


def _save_sessions(sessions: dict):
    """Save sessions to file."""
    import json
    try:
        SESSION_FILE.write_text(json.dumps(sessions))
    except Exception:
        pass


# File-backed session store
sessions = _load_sessions()


def _load_users() -> dict:
    """Load users from auth.json."""
    import json
    if not AUTH_FILE.exists():
        # Create default auth file
        default = {
            "users": {
                "franck": _hash_password("ControlTower2026!")
            }
        }
        AUTH_FILE.write_text(json.dumps(default, indent=2))
        return default["users"]

    data = json.loads(AUTH_FILE.read_text())
    return data.get("users", {})


def _hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def _check_auth(request: Request) -> bool:
    """Check if request has a valid session token."""
    token = request.cookies.get("ct_session")
    if not token:
        return False
    session = sessions.get(token)
    if not session:
        return False
    if time.time() > session["expires"]:
        del sessions[token]
        return False
    return True


def get_login_page() -> str:
    """Return the login page HTML."""
    return """<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Control Tower - Login</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    background: #0d1117;
    color: #e6edf3;
    font-family: 'Segoe UI', system-ui, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
}
.login-card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 12px;
    padding: 40px;
    width: 100%;
    max-width: 400px;
}
.login-logo {
    text-align: center;
    margin-bottom: 24px;
}
.login-logo span { font-size: 2rem; }
.login-logo h1 {
    font-size: 1.4rem;
    margin-top: 8px;
    color: #e6edf3;
}
.login-logo p {
    font-size: 0.85rem;
    color: #8b949e;
    margin-top: 4px;
}
.form-group {
    margin-bottom: 16px;
}
.form-label {
    display: block;
    font-size: 0.85rem;
    color: #8b949e;
    margin-bottom: 6px;
}
.form-input {
    width: 100%;
    padding: 10px 14px;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 8px;
    color: #e6edf3;
    font-size: 0.95rem;
    outline: none;
    transition: border-color 0.2s;
}
.form-input:focus { border-color: #c51d4a; }
.btn-login {
    width: 100%;
    padding: 12px;
    background: #c51d4a;
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
    margin-top: 8px;
}
.btn-login:hover { background: #e94560; }
.error-msg {
    color: #f85149;
    font-size: 0.85rem;
    text-align: center;
    margin-top: 12px;
    display: none;
}
</style>
</head>
<body>
<div class="login-card">
    <div class="login-logo">
        <span>&#10029;</span>
        <h1>Control Tower</h1>
        <p>Network Administration Dashboard</p>
    </div>
    <form id="login-form" onsubmit="return doLogin(event)">
        <div class="form-group">
            <label class="form-label">Username</label>
            <input type="text" class="form-input" id="username" autocomplete="username" autofocus required>
        </div>
        <div class="form-group">
            <label class="form-label">Password</label>
            <input type="password" class="form-input" id="password" autocomplete="current-password" required>
        </div>
        <button type="submit" class="btn-login">Se connecter</button>
        <div class="error-msg" id="error-msg">Identifiants incorrects</div>
    </form>
</div>
<script>
// If already authenticated, redirect immediately (handles browser back button)
fetch("/auth/check").then(function(r) { if (r.ok) window.location.replace("/"); });

async function doLogin(e) {
    e.preventDefault();
    var user = document.getElementById("username").value;
    var pass = document.getElementById("password").value;
    var err = document.getElementById("error-msg");
    err.style.display = "none";
    try {
        var resp = await fetch("/auth/login", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({username: user, password: pass})
        });
        if (resp.ok) {
            window.location.replace("/");
        } else {
            err.style.display = "block";
        }
    } catch (ex) {
        err.style.display = "block";
    }
    return false;
}
</script>
</body>
</html>"""


@router.get("/auth/login", response_class=HTMLResponse)
async def login_page(request: Request):
    if _check_auth(request):
        return HTMLResponse(status_code=302, headers={"Location": "/"})
    return HTMLResponse(get_login_page())


@router.post("/auth/login")
async def login(request: Request):
    body = await request.json()
    username = body.get("username", "")
    password = body.get("password", "")

    users = _load_users()
    hashed = _hash_password(password)

    if username in users and users[username] == hashed:
        token = secrets.token_hex(32)
        sessions[token] = {
            "user": username,
            "expires": time.time() + SESSION_DURATION,
        }
        _save_sessions(sessions)
        response = JSONResponse({"success": True})
        response.set_cookie(
            key="ct_session",
            value=token,
            max_age=SESSION_DURATION,
            httponly=True,
            samesite="lax",
        )
        return response

    raise HTTPException(status_code=401, detail="Invalid credentials")


@router.get("/auth/logout")
async def logout(request: Request):
    token = request.cookies.get("ct_session")
    if token and token in sessions:
        del sessions[token]
        _save_sessions(sessions)
    response = HTMLResponse(status_code=302, headers={"Location": "/auth/login"})
    response.delete_cookie("ct_session")
    return response


@router.get("/auth/check")
async def check_auth(request: Request):
    if _check_auth(request):
        token = request.cookies.get("ct_session")
        session = sessions.get(token, {})
        return {"authenticated": True, "user": session.get("user", "")}
    raise HTTPException(status_code=401, detail="Not authenticated")
