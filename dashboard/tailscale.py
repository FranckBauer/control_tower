"""
Tailnet devices router.

Liste tous les noeuds du tailnet Tailscale (Self + Peers) avec leur etat
en temps reel : online/offline, IP v4/v6, OS, type de connexion (direct ou DERP),
trafic Tx/Rx, last seen, capacites (exit node), etc.

Le binaire `tailscale` (Linux) ou `tailscale.exe` (Windows) est invoque en local
sur la machine qui heberge le dashboard.
"""

import asyncio
import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter()

# Cache des resultats pour eviter de spammer le binaire (qui parle au demon Tailscale)
_cache: dict | None = None
_cache_ts: float = 0
_CACHE_TTL = 15  # secondes


def _find_tailscale_binary() -> str | None:
    """Cherche le binaire tailscale dans les emplacements standards Linux puis Windows."""
    # Linux/macOS : dans le PATH ou emplacements standards
    for candidate in ["tailscale", "/usr/bin/tailscale", "/usr/sbin/tailscale", "/usr/local/bin/tailscale"]:
        path = shutil.which(candidate) if "/" not in candidate else (candidate if os.path.exists(candidate) else None)
        if path:
            return path
    # Windows natif ou via WSL (/mnt/c/...)
    for candidate in [
        r"C:\Program Files\Tailscale\tailscale.exe",
        "/mnt/c/Program Files/Tailscale/tailscale.exe",
    ]:
        if os.path.exists(candidate):
            return candidate
    return None


def _format_relay(relay: str | None) -> str | None:
    """Convertit le code DERP court (par, sjc, fra...) en label lisible."""
    if not relay:
        return None
    # Codes DERP officiels Tailscale (2026) -> villes
    derp_map = {
        "par": "Paris",
        "fra": "Francfort",
        "lhr": "Londres",
        "ams": "Amsterdam",
        "mad": "Madrid",
        "waw": "Varsovie",
        "sto": "Stockholm",
        "nyc": "New York",
        "sjc": "San Jose",
        "lax": "Los Angeles",
        "sea": "Seattle",
        "chi": "Chicago",
        "dfw": "Dallas",
        "den": "Denver",
        "tor": "Toronto",
        "sao": "Sao Paulo",
        "tok": "Tokyo",
        "sin": "Singapour",
        "syd": "Sydney",
        "blr": "Bangalore",
        "hkg": "Hong Kong",
        "dbi": "Dubai",
        "jnb": "Johannesburg",
    }
    return derp_map.get(relay, relay.upper())


def _parse_node(node: dict, is_self: bool = False) -> dict:
    """Convertit un noeud Tailscale brut en payload normalise pour le frontend."""
    ips = node.get("TailscaleIPs") or []
    ip_v4 = next((ip for ip in ips if ":" not in ip), None)
    ip_v6 = next((ip for ip in ips if ":" in ip), None)

    # LastSeen "0001-01-01T00:00:00Z" = jamais (online en permanence)
    last_seen = node.get("LastSeen")
    if last_seen and last_seen.startswith("0001-01-01"):
        last_seen = None

    # Created peut aussi etre 0001-01-01 pour le Self -> ignorer
    created = node.get("Created")
    if created and created.startswith("0001-01-01"):
        created = None

    # CurAddr = adresse directe quand connexion P2P etablie. Vide si DERP only.
    cur_addr = node.get("CurAddr") or None
    relay = node.get("Relay") or None
    has_direct = bool(cur_addr)

    # DNSName = "hostname.tailbb26eb.ts.net." -> on retire le point final
    dns_name = (node.get("DNSName") or "").rstrip(".")

    return {
        "id": node.get("ID") or node.get("PublicKey", "")[:12],
        "host_name": node.get("HostName"),
        "dns_name": dns_name,
        "os": (node.get("OS") or "").lower(),
        "ip_v4": ip_v4,
        "ip_v6": ip_v6,
        "online": bool(node.get("Online")),
        "last_seen": last_seen,
        "created": created,
        "is_self": is_self,
        "is_active": bool(node.get("Active")),
        "exit_node": bool(node.get("ExitNode")),
        "exit_node_option": bool(node.get("ExitNodeOption")),
        "tags": node.get("Tags") or [],
        "tx_bytes": node.get("TxBytes") or 0,
        "rx_bytes": node.get("RxBytes") or 0,
        "last_handshake": node.get("LastHandshake"),
        "last_write": node.get("LastWrite"),
        "relay": relay,
        "relay_label": _format_relay(relay),
        "cur_addr": cur_addr,
        "has_direct": has_direct,
    }


async def _run_tailscale_status() -> dict:
    """Execute `tailscale status --json` et renvoie le dict parse."""
    binary = _find_tailscale_binary()
    if not binary:
        raise HTTPException(
            status_code=503,
            detail="Binaire tailscale introuvable sur cette machine",
        )

    try:
        proc = await asyncio.create_subprocess_exec(
            binary, "status", "--json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Timeout sur tailscale status")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Erreur execution tailscale: {exc}")

    if proc.returncode != 0:
        err = (stderr or b"").decode(errors="replace").strip()
        raise HTTPException(status_code=500, detail=f"tailscale status a echoue: {err}")

    try:
        return json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"Sortie tailscale non parsable: {exc}")


@router.get("/api/tailscale/devices")
async def list_devices():
    """Renvoie la liste de tous les noeuds du tailnet (Self + Peers)."""
    global _cache, _cache_ts
    now = time.time()
    if _cache is not None and (now - _cache_ts) < _CACHE_TTL:
        return _cache

    raw = await _run_tailscale_status()

    devices: list[dict] = []
    self_node = raw.get("Self")
    if self_node:
        devices.append(_parse_node(self_node, is_self=True))
    for peer in (raw.get("Peer") or {}).values():
        devices.append(_parse_node(peer, is_self=False))

    # Tri : Self en premier, puis online avant offline, puis par nom
    devices.sort(key=lambda d: (
        not d["is_self"],
        not d["online"],
        (d["host_name"] or "").lower(),
    ))

    payload = {
        "devices": devices,
        "magic_dns_suffix": raw.get("MagicDNSSuffix"),
        "tailnet": raw.get("CurrentTailnet", {}).get("Name") if isinstance(raw.get("CurrentTailnet"), dict) else None,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }
    _cache = payload
    _cache_ts = now
    return payload
