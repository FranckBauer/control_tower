"""
Sites monitoring router.

Health-checks les sites web declares dans sites.json toutes les N secondes,
persiste l'historique sur disque, expose le statut courant + analytics nginx.
"""

import asyncio
import json
import re
import socket
import ssl
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException

# User-agents reconnus comme bots/scanners — exclus du compteur "visiteurs uniques".
BOT_UA_PATTERNS = re.compile(
    r"bot|crawler|spider|scanner|fasthttp|libredtail|censys|zgrab|"
    r"infrawat|keydrop|nmap|masscan|netsystemsresearch|paloaltonetworks|"
    r"controltower/|curl/|wget/|python-requests",
    re.IGNORECASE,
)


def _is_bot_ua(ua: str) -> bool:
    if not ua or ua == "-":
        return True  # absence d'UA = scanner / bot bas niveau
    return bool(BOT_UA_PATTERNS.search(ua))

router = APIRouter()

CONFIG_FILE = Path(__file__).resolve().parent.parent / "sites.json"
HISTORY_FILE = Path(__file__).resolve().parent.parent / ".sites_history.json"

# State en memoire : id -> dernier check complet (status, code, ms, ssl, headers, ts)
_current: dict[str, dict] = {}
# Historique en memoire (synchronise avec le fichier disque)
_history: list[dict] = []
# Lock pour ecriture historique
_history_lock = asyncio.Lock()

HTTP_DESCRIPTIONS = {
    200: "OK",
    301: "Moved Permanently",
    302: "Found",
    304: "Not Modified",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
}


def _load_config() -> dict:
    with open(CONFIG_FILE, "r") as f:
        return json.load(f)


def _load_history_from_disk() -> list[dict]:
    if not HISTORY_FILE.exists():
        return []
    try:
        with open(HISTORY_FILE, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def _save_history_to_disk() -> None:
    try:
        with open(HISTORY_FILE, "w") as f:
            json.dump(_history, f, separators=(",", ":"))
    except OSError:
        pass


def _trim_history(max_entries_per_site: int) -> None:
    """Cap chaque site a max_entries_per_site dans _history."""
    by_site: dict[str, list[dict]] = defaultdict(list)
    for entry in _history:
        by_site[entry["id"]].append(entry)
    trimmed: list[dict] = []
    for site_id, entries in by_site.items():
        if len(entries) > max_entries_per_site:
            entries = entries[-max_entries_per_site:]
        trimmed.extend(entries)
    trimmed.sort(key=lambda e: e["ts"])
    _history.clear()
    _history.extend(trimmed)


async def _fetch_ssl_info(host: str, port: int = 443) -> dict | None:
    """Recupere les infos du certificat SSL via socket (sync, dans un thread)."""
    def _sync_fetch():
        try:
            ctx = ssl.create_default_context()
            with socket.create_connection((host, port), timeout=5) as sock:
                with ctx.wrap_socket(sock, server_hostname=host) as ssock:
                    cert = ssock.getpeercert()
            issuer = dict(x[0] for x in cert.get("issuer", []))
            subject = dict(x[0] for x in cert.get("subject", []))
            return {
                "subject": subject.get("commonName"),
                "issuer": issuer.get("organizationName") or issuer.get("commonName"),
                "valid_from": cert.get("notBefore"),
                "valid_until": cert.get("notAfter"),
            }
        except (socket.gaierror, socket.timeout, ssl.SSLError, OSError):
            return None
    return await asyncio.to_thread(_sync_fetch)


def _build_check_url(site: dict) -> str:
    """L'URL utilisee pour le healthcheck.

    `site["url"]` = URL home du site (ce qui s'ouvre quand on clique sur le bouton).
    `site["healthcheck_path"]` (optionnel) = chemin relatif teste par le checker.
    Si absent, on tape la home directement.
    """
    base = site["url"].rstrip("/")
    path = site.get("healthcheck_path") or "/"
    if not path.startswith("/"):
        path = "/" + path
    return base + path


async def _check_site(site: dict) -> dict:
    """Effectue un check complet d'un site (HTTP + SSL si https)."""
    url = _build_check_url(site)
    parsed = urlparse(url)
    result = {
        "id": site["id"],
        "ts": datetime.now(timezone.utc).isoformat(),
        "status": "down",
        "code": None,
        "ms": None,
        "code_text": None,
        "headers": None,
        "ssl": None,
        "error": None,
    }

    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            resp = await client.get(url, headers={"User-Agent": "ControlTower/1.0"})
            elapsed_ms = int((time.monotonic() - start) * 1000)
            result["ms"] = elapsed_ms
            result["code"] = resp.status_code
            result["code_text"] = HTTP_DESCRIPTIONS.get(resp.status_code, resp.reason_phrase or "")
            # 2xx et 3xx = up, le reste = erreur
            if resp.status_code < 400:
                result["status"] = "up"
            else:
                result["status"] = "error"
            # Headers utiles
            interesting = ["server", "content-type", "content-length", "x-powered-by", "strict-transport-security"]
            result["headers"] = {k: resp.headers.get(k) for k in interesting if k in resp.headers}
    except httpx.TimeoutException:
        result["error"] = "timeout"
        result["ms"] = int((time.monotonic() - start) * 1000)
    except httpx.ConnectError as exc:
        result["error"] = f"connection error: {exc}"
    except httpx.RequestError as exc:
        result["error"] = f"request error: {exc}"

    # SSL si https
    if parsed.scheme == "https" and parsed.hostname:
        result["ssl"] = await _fetch_ssl_info(parsed.hostname, parsed.port or 443)

    return result


async def _checker_loop():
    """Boucle de fond : check tous les sites toutes les N secondes."""
    cfg = _load_config()
    interval = cfg.get("check_interval_seconds", 60)
    max_entries = cfg.get("history_max_entries", 1440)

    # Charge l'historique existant au demarrage
    _history.clear()
    _history.extend(_load_history_from_disk())

    while True:
        try:
            cfg = _load_config()
            interval = cfg.get("check_interval_seconds", 60)
            max_entries = cfg.get("history_max_entries", 1440)
            sites = cfg.get("sites", [])

            results = await asyncio.gather(*(_check_site(s) for s in sites), return_exceptions=True)

            async with _history_lock:
                for r in results:
                    if isinstance(r, Exception):
                        continue
                    _current[r["id"]] = r
                    # On ne stocke en historique que les champs legers (pas headers/ssl)
                    _history.append({
                        "id": r["id"],
                        "ts": r["ts"],
                        "status": r["status"],
                        "code": r["code"],
                        "ms": r["ms"],
                    })
                _trim_history(max_entries)
                _save_history_to_disk()
        except Exception:
            # Ne jamais tuer la boucle de fond
            pass

        await asyncio.sleep(interval)


_task: asyncio.Task | None = None


def start_background_checker():
    """A appeler dans le startup event de l'app FastAPI."""
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_checker_loop())


# Cache des compteurs analytics (visites + IPs uniques 24h) pour eviter de re-parser
# les logs nginx a chaque appel a /api/sites. Re-calcule au plus toutes les 60s.
_analytics_cache: dict[str, dict] = {}
_ANALYTICS_TTL = 60


# Heuristique "vrai navigateur" :
# - soit l'IP a charge un asset CSS/JS (un navigateur suit toujours les <link>/<script>)
# - soit l'IP a au moins une requete avec un Referer non-vide (un navigateur le met
#   automatiquement quand il charge depuis une page, un scanner bas-niveau non)
# Les sites purement statiques sans CSS/JS externes (ex: terje, HTML+images) sont
# couverts par le critere Referer (les images sont chargees avec Referer = la page).
ASSET_PATH_RE = re.compile(r"\.(css|js|mjs)(\?|$)", re.IGNORECASE)


def _quick_analytics(site_id: str, log_path: str, hostname: str | None = None) -> dict | None:
    """Renvoie les compteurs sur les dernieres 24h en parsant le log nginx.

    Heuristique "vrais visiteurs humains" :
    - exclure 127.0.0.1 (le checker / proxy se tape lui-meme)
    - exclure les UA bot connus (regex BOT_UA_PATTERNS)
    - retenir uniquement les IPs qui ont :
        soit charge un asset CSS/JS (un navigateur suit toujours <link>/<script>)
        soit eu au moins 1 hit avec Referer pointant vers le hostname legitime du site
          (pas vers l'IP brute, beaucoup de scanners forgent des Referer vers l'IP).
    Le critere Referer hostname couvre les sites statiques sans CSS/JS (ex: terje).

    Si `hostname` est None, on accepte n'importe quel Referer non-vide (fallback).

    Cache 60s pour ne pas marteler le disque."""
    now = time.time()
    cached = _analytics_cache.get(site_id)
    if cached and (now - cached["ts"]) < _ANALYTICS_TTL:
        return cached["data"]

    log_file = Path(log_path)
    if not log_file.exists():
        return None

    cutoff_24h = now - 24 * 3600
    raw_total = 0
    raw_ips: set[str] = set()
    # Par IP candidate : hits + a charge un asset + a vu un Referer non-vide
    candidate: dict[str, dict] = {}
    try:
        with open(log_file, "r", errors="replace") as f:
            f.seek(0, 2)
            size = f.tell()
            read_size = min(size, 50 * 1024 * 1024)
            f.seek(size - read_size)
            if read_size < size:
                f.readline()
            for line in f:
                parsed = _parse_nginx_log_line(line)
                if not parsed:
                    continue
                if parsed["ts"].timestamp() < cutoff_24h:
                    continue
                raw_total += 1
                raw_ips.add(parsed["ip"])
                if parsed["ip"] == "127.0.0.1":
                    continue
                if _is_bot_ua(parsed.get("ua") or ""):
                    continue
                ip = parsed["ip"]
                entry = candidate.setdefault(ip, {"hits": 0, "asset": False, "referer": False})
                entry["hits"] += 1
                if not entry["asset"] and ASSET_PATH_RE.search(parsed.get("path") or ""):
                    entry["asset"] = True
                ref = parsed.get("ref") or ""
                if not entry["referer"] and ref and ref != "-":
                    if hostname is None:
                        entry["referer"] = True
                    elif f"://{hostname}/" in ref or ref.endswith(f"://{hostname}"):
                        entry["referer"] = True
    except OSError:
        return None

    human_ips = {ip for ip, e in candidate.items() if e["asset"] or e["referer"]}
    human_total = sum(e["hits"] for ip, e in candidate.items() if ip in human_ips)

    data = {
        "requests_24h": human_total,
        "unique_ips_24h": len(human_ips),
        "raw_requests_24h": raw_total,
        "raw_unique_ips_24h": len(raw_ips),
    }
    _analytics_cache[site_id] = {"ts": now, "data": data}
    return data


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/api/sites")
async def list_sites():
    """Renvoie la config + le statut courant + un resume historique 24h."""
    cfg = _load_config()
    sites = cfg.get("sites", [])

    # Pour chaque site, calculer uptime % sur les dernieres 24h
    cutoff = datetime.now(timezone.utc).timestamp() - 24 * 3600
    recent_by_site: dict[str, list[dict]] = defaultdict(list)
    for entry in _history:
        try:
            ts = datetime.fromisoformat(entry["ts"]).timestamp()
        except (ValueError, KeyError):
            continue
        if ts >= cutoff:
            recent_by_site[entry["id"]].append(entry)

    nginx_paths = cfg.get("nginx_log_paths", {})
    out = []
    for site in sites:
        sid = site["id"]
        cur = _current.get(sid)
        recent = recent_by_site.get(sid, [])
        up_count = sum(1 for e in recent if e["status"] == "up")
        uptime_pct = round((up_count / len(recent)) * 100, 1) if recent else None
        latencies_up = [e["ms"] for e in recent if e["status"] == "up" and e.get("ms")]
        avg_ms = round(sum(latencies_up) / len(latencies_up)) if latencies_up else None

        log_path = nginx_paths.get(sid)
        site_hostname = urlparse(site["url"]).hostname
        analytics = _quick_analytics(sid, log_path, site_hostname) if log_path else None

        out.append({
            "id": sid,
            "name": site["name"],
            "url": site["url"],
            "check_url": _build_check_url(site),
            "icon": site.get("icon", ""),
            "category": site.get("category", "other"),
            "description": site.get("description", ""),
            "status": cur["status"] if cur else "unknown",
            "code": cur["code"] if cur else None,
            "code_text": cur["code_text"] if cur else None,
            "ms": cur["ms"] if cur else None,
            "ssl": cur["ssl"] if cur else None,
            "headers": cur["headers"] if cur else None,
            "error": cur["error"] if cur else None,
            "last_check": cur["ts"] if cur else None,
            "uptime_24h": uptime_pct,
            "avg_ms_24h": avg_ms,
            "history": recent,
            "has_nginx_log": sid in nginx_paths,
            "requests_24h": analytics["requests_24h"] if analytics else None,
            "unique_ips_24h": analytics["unique_ips_24h"] if analytics else None,
        })

    return {
        "sites": out,
        "check_interval_seconds": cfg.get("check_interval_seconds", 60),
    }


# Regex pour parser les access logs nginx (combined log format)
NGINX_LOG_RE = re.compile(
    r'(?P<ip>\S+) \S+ \S+ \[(?P<ts>[^\]]+)\] '
    r'"(?P<method>\S+) (?P<path>\S+) (?P<proto>[^"]+)" '
    r'(?P<status>\d+) (?P<size>\d+) '
    r'"(?P<ref>[^"]*)" "(?P<ua>[^"]*)"'
)


def _parse_nginx_log_line(line: str) -> dict | None:
    m = NGINX_LOG_RE.match(line)
    if not m:
        return None
    d = m.groupdict()
    try:
        ts = datetime.strptime(d["ts"], "%d/%b/%Y:%H:%M:%S %z")
    except ValueError:
        return None
    return {
        "ip": d["ip"],
        "ts": ts,
        "method": d["method"],
        "path": d["path"],
        "status": int(d["status"]),
        "size": int(d["size"]),
        "ua": d["ua"],
        "ref": d["ref"],
    }


@router.get("/api/sites/{site_id}/analytics")
async def site_analytics(site_id: str):
    """Analytics nginx : requetes, IPs uniques, top pages, top IPs (24h)."""
    cfg = _load_config()
    log_path = cfg.get("nginx_log_paths", {}).get(site_id)
    if not log_path:
        raise HTTPException(status_code=404, detail="No nginx log path configured for this site")

    log_file = Path(log_path)
    if not log_file.exists():
        raise HTTPException(status_code=404, detail=f"Log file not found: {log_path}")

    now = datetime.now(timezone.utc)
    cutoff_24h = now.timestamp() - 24 * 3600
    cutoff_5min = now.timestamp() - 5 * 60

    total_requests = 0
    requests_5min = 0
    ips_24h: set[str] = set()
    ips_5min: set[str] = set()
    top_paths: Counter = Counter()
    top_ips: Counter = Counter()
    status_counts: Counter = Counter()
    by_hour: Counter = Counter()

    try:
        # Lit que les dernieres lignes pour eviter de manger la RAM sur gros logs
        with open(log_file, "r", errors="replace") as f:
            f.seek(0, 2)
            size = f.tell()
            # Limite a 50 MB par defaut
            read_size = min(size, 50 * 1024 * 1024)
            f.seek(size - read_size)
            if read_size < size:
                f.readline()  # skip ligne potentiellement tronquee
            for line in f:
                parsed = _parse_nginx_log_line(line)
                if not parsed:
                    continue
                ts_epoch = parsed["ts"].timestamp()
                if ts_epoch < cutoff_24h:
                    continue
                total_requests += 1
                ips_24h.add(parsed["ip"])
                top_paths[parsed["path"]] += 1
                top_ips[parsed["ip"]] += 1
                status_counts[str(parsed["status"])[0] + "xx"] += 1
                by_hour[parsed["ts"].strftime("%Y-%m-%d %H:00")] += 1
                if ts_epoch >= cutoff_5min:
                    requests_5min += 1
                    ips_5min.add(parsed["ip"])
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Cannot read log file: {exc}")

    return {
        "site_id": site_id,
        "log_path": str(log_path),
        "total_requests_24h": total_requests,
        "unique_ips_24h": len(ips_24h),
        "requests_5min": requests_5min,
        "active_ips_5min": len(ips_5min),
        "top_paths": top_paths.most_common(15),
        "top_ips": top_ips.most_common(15),
        "status_codes": dict(status_counts),
        "by_hour": sorted(by_hour.items()),
    }
