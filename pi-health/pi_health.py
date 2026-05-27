#!/usr/bin/env python3
"""Pi Health Monitor — rasta-server.

Tourne via systemd timer toutes les minutes. Pour chaque check :
  1. Collecte les métriques (temp, link eth0, services, charge, disque, DNS local)
  2. Log structuré en JSON dans /var/log/pi-health/health.log
  3. Détecte les anomalies vs les seuils
  4. Auto-recovery (restart service, ip link cycle)
  5. Envoie alerte mail (avec anti-spam) si anomalie critique

Conçu pour tourner en root (accès vcgencmd, systemctl, ip link, dmesg).

Historique : créé suite aux incidents 2026-05-12 et 2026-05-27 où le Pi est devenu
injoignable sans alerte. cf. incident_2026-05-12_pi_dnsmasq_eth0_phy.md.
"""
from __future__ import annotations

import json
import os
import re
import smtplib
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LOG_DIR = Path("/var/log/pi-health")
HEALTH_LOG = LOG_DIR / "health.log"
ALERTS_LOG = LOG_DIR / "alerts.log"
STATE_DIR = Path("/var/lib/pi-health")
STATE_FILE = STATE_DIR / "state.json"

# Seuils
TEMP_WARN_C = 75.0
TEMP_CRIT_C = 85.0
DISK_WARN_PCT = 85
DISK_CRIT_PCT = 95
LOAD1_WARN = 4.0  # Pi 5 = 4 cores
MEM_AVAIL_WARN_MB = 200

# Anti-spam : ne pas re-alerter sur la même condition avant N secondes
ALERT_RENOTIFY_SECONDS = 1800  # 30 min

# Mail
SMTP_HOST = "10.10.0.61"
SMTP_PORT = 25
SMTP_TIMEOUT = 10
MAIL_FROM = "fbauer@yacast.fr"
MAIL_TO = "aaaaafe63k2shrr2w6wuw3hk2i@yacast.slack.com"
RELAY_HOST = "10.2.10.173"  # fallback SSH si SMTP direct échoue
RELAY_USER = "fbauer"

# Services systemd à surveiller (critical = mail si down)
CRITICAL_SERVICES = ["nginx", "dnsmasq", "tailscaled"]

# DNS local à vérifier (résolution doit fonctionner via dnsmasq)
DNS_TEST_NAME = "jellyfin.rastapi.fr"
DNS_TEST_SERVER = "127.0.0.1"
DNS_TEST_EXPECT = "100.105.88.5"

# Interface réseau à surveiller
NET_IFACE = "eth0"

# Auto-recovery : nb de checks consécutifs en erreur avant action
RECOVERY_AFTER_N_CHECKS = 2


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def run(cmd: list[str], timeout: int = 5) -> tuple[int, str, str]:
    """Lance une commande, renvoie (rc, stdout, stderr) sans lever."""
    try:
        p = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except FileNotFoundError:
        return 127, "", "not found"


def read_text(path: str | Path) -> str | None:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def ensure_dirs() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def load_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def save_state(state: dict[str, Any]) -> None:
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(STATE_FILE)


# ---------------------------------------------------------------------------
# Métriques
# ---------------------------------------------------------------------------

def metric_temperature() -> float | None:
    """Temp CPU en °C. Source primaire : /sys, fallback : vcgencmd."""
    raw = read_text("/sys/class/thermal/thermal_zone0/temp")
    if raw and raw.isdigit():
        return round(int(raw) / 1000.0, 1)
    rc, out, _ = run(["vcgencmd", "measure_temp"])
    if rc == 0:
        m = re.search(r"temp=([\d.]+)", out)
        if m:
            return float(m.group(1))
    return None


def metric_link_status() -> dict[str, Any]:
    """État du lien eth0. operstate + carrier + speed."""
    return {
        "operstate": read_text(f"/sys/class/net/{NET_IFACE}/operstate"),
        "carrier": read_text(f"/sys/class/net/{NET_IFACE}/carrier"),
        "speed_mbps": read_text(f"/sys/class/net/{NET_IFACE}/speed"),
    }


def metric_link_flap_count() -> int:
    """Compte les Up/Down de eth0 dans dmesg sur les 60 dernières secondes.

    Un Up suivi d'un Down (ou inverse) compte pour 1 flap.
    """
    rc, out, _ = run(["dmesg", "--time-format=iso", "--since", "1 minute ago"])
    if rc != 0:
        return -1
    transitions = [
        line for line in out.splitlines()
        if re.search(r"macb.*ethernet.*Link is (Up|Down)", line)
    ]
    return max(0, len(transitions) - 1)


def metric_services() -> dict[str, str]:
    """État systemd des services critiques."""
    states = {}
    for svc in CRITICAL_SERVICES:
        rc, out, _ = run(["systemctl", "is-active", svc])
        states[svc] = out or "unknown"
    return states


def metric_load_mem_disk() -> dict[str, Any]:
    load = read_text("/proc/loadavg") or ""
    parts = load.split()
    load1 = float(parts[0]) if parts else 0.0

    # Mémoire dispo en MB
    mem_avail_mb = 0
    meminfo = read_text("/proc/meminfo") or ""
    for line in meminfo.splitlines():
        if line.startswith("MemAvailable:"):
            mem_avail_mb = int(line.split()[1]) // 1024
            break

    # Disque /
    rc, out, _ = run(["df", "-h", "--output=pcent,avail", "/"])
    disk_pct = 0
    disk_avail = "?"
    if rc == 0:
        lines = out.splitlines()
        if len(lines) >= 2:
            cols = lines[1].split()
            if cols:
                disk_pct = int(cols[0].rstrip("%"))
                disk_avail = cols[1] if len(cols) > 1 else "?"
    return {
        "load1": load1,
        "mem_avail_mb": mem_avail_mb,
        "disk_pct": disk_pct,
        "disk_avail": disk_avail,
    }


def metric_dns_local() -> dict[str, Any]:
    """Vérifie que dnsmasq local résout *.rastapi.fr correctement."""
    rc, out, err = run(
        ["dig", "+short", f"+time=2", "+tries=1", f"@{DNS_TEST_SERVER}", DNS_TEST_NAME],
        timeout=4,
    )
    return {
        "ok": rc == 0 and DNS_TEST_EXPECT in out,
        "result": out or err,
    }


def metric_uptime_seconds() -> int:
    raw = read_text("/proc/uptime")
    if raw:
        try:
            return int(float(raw.split()[0]))
        except (ValueError, IndexError):
            pass
    return 0


# ---------------------------------------------------------------------------
# Détection anomalies + actions
# ---------------------------------------------------------------------------

def evaluate(metrics: dict[str, Any], state: dict[str, Any]) -> list[dict[str, Any]]:
    """Renvoie une liste d'anomalies. Chaque anomalie = {key, level, msg, action}."""
    anomalies = []

    t = metrics.get("temp_c")
    if t is not None:
        if t >= TEMP_CRIT_C:
            anomalies.append({
                "key": "temp_crit",
                "level": "critical",
                "msg": f"Température CPU critique : {t}°C (seuil {TEMP_CRIT_C}°C, throttling imminent)",
            })
        elif t >= TEMP_WARN_C:
            anomalies.append({
                "key": "temp_warn",
                "level": "warning",
                "msg": f"Température CPU élevée : {t}°C (seuil {TEMP_WARN_C}°C)",
            })

    link = metrics.get("link", {})
    if link.get("operstate") != "up" or link.get("carrier") != "1":
        anomalies.append({
            "key": "link_down",
            "level": "critical",
            "msg": f"Link {NET_IFACE} DOWN (operstate={link.get('operstate')}, carrier={link.get('carrier')})",
            "action": "cycle_link",
        })

    flaps = metrics.get("link_flap_count_1min", 0)
    if flaps >= 4:
        anomalies.append({
            "key": "link_flap",
            "level": "warning",
            "msg": f"Link {NET_IFACE} flap {flaps} fois en 1 min",
        })

    for svc, st in metrics.get("services", {}).items():
        if st != "active":
            anomalies.append({
                "key": f"svc_{svc}",
                "level": "critical",
                "msg": f"Service {svc} non actif : {st}",
                "action": f"restart_service:{svc}",
            })

    if not metrics.get("dns", {}).get("ok"):
        anomalies.append({
            "key": "dns_local",
            "level": "critical",
            "msg": f"DNS local KO : {DNS_TEST_NAME} via {DNS_TEST_SERVER} → {metrics['dns'].get('result')}",
            "action": "restart_service:dnsmasq",
        })

    lmd = metrics.get("lmd", {})
    if lmd.get("disk_pct", 0) >= DISK_CRIT_PCT:
        anomalies.append({
            "key": "disk_crit",
            "level": "critical",
            "msg": f"Disque / plein à {lmd['disk_pct']}% (libre {lmd.get('disk_avail')})",
        })
    elif lmd.get("disk_pct", 0) >= DISK_WARN_PCT:
        anomalies.append({
            "key": "disk_warn",
            "level": "warning",
            "msg": f"Disque / plein à {lmd['disk_pct']}% (libre {lmd.get('disk_avail')})",
        })

    if lmd.get("mem_avail_mb", 9999) < MEM_AVAIL_WARN_MB:
        anomalies.append({
            "key": "mem_low",
            "level": "warning",
            "msg": f"RAM disponible basse : {lmd['mem_avail_mb']} MB",
        })

    if lmd.get("load1", 0) > LOAD1_WARN:
        anomalies.append({
            "key": "load_high",
            "level": "warning",
            "msg": f"Charge CPU élevée : load1={lmd['load1']}",
        })

    return anomalies


def trigger_recovery(action: str) -> tuple[bool, str]:
    """Exécute une action de recovery. Renvoie (succès, log)."""
    if action == "cycle_link":
        run(["ip", "link", "set", NET_IFACE, "down"], timeout=5)
        time.sleep(2)
        rc, _, err = run(["ip", "link", "set", NET_IFACE, "up"], timeout=5)
        return (rc == 0, f"ip link cycle {NET_IFACE} (rc={rc} {err})")
    if action.startswith("restart_service:"):
        svc = action.split(":", 1)[1]
        rc, _, err = run(["systemctl", "restart", svc], timeout=20)
        return (rc == 0, f"systemctl restart {svc} (rc={rc} {err})")
    return (False, f"action inconnue: {action}")


def should_recover(state: dict, key: str) -> bool:
    """Recovery uniquement après N checks consécutifs en erreur."""
    counters = state.setdefault("err_counters", {})
    counters[key] = counters.get(key, 0) + 1
    return counters[key] >= RECOVERY_AFTER_N_CHECKS


def reset_err_counter(state: dict, key: str) -> None:
    state.setdefault("err_counters", {}).pop(key, None)


# ---------------------------------------------------------------------------
# Mail
# ---------------------------------------------------------------------------

def send_mail(subject: str, body: str) -> bool:
    """SMTP direct, fallback SSH relay si Yacast pas joignable."""
    msg = MIMEText(body)
    msg["From"] = MAIL_FROM
    msg["To"] = MAIL_TO
    msg["Subject"] = subject
    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=SMTP_TIMEOUT) as s:
            s.send_message(msg)
        return True
    except (OSError, smtplib.SMTPException):
        pass
    # Fallback SSH relay
    body_escaped = body.replace("'", "'\\''")
    subj_escaped = subject.replace("'", "'\\''")
    py = (
        "import smtplib; from email.mime.text import MIMEText; "
        f"m=MIMEText('''{body_escaped}'''); "
        f"m['From']='{MAIL_FROM}'; m['To']='{MAIL_TO}'; m['Subject']='''{subj_escaped}'''; "
        f"smtplib.SMTP('{SMTP_HOST}',{SMTP_PORT},timeout={SMTP_TIMEOUT}).send_message(m)"
    )
    rc, _, _ = run(
        ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes",
         f"{RELAY_USER}@{RELAY_HOST}", f"python3 -c \"{py}\""],
        timeout=15,
    )
    return rc == 0


def should_notify(state: dict, key: str, level: str) -> bool:
    """Re-notif si nouvelle alerte ou si la même persiste depuis > ALERT_RENOTIFY_SECONDS."""
    notifs = state.setdefault("notifs", {})
    last = notifs.get(key, {})
    now = int(time.time())
    if last.get("level") != level:
        notifs[key] = {"level": level, "ts": now}
        return True
    if now - last.get("ts", 0) >= ALERT_RENOTIFY_SECONDS:
        notifs[key]["ts"] = now
        return True
    return False


def mark_resolved(state: dict, key: str) -> bool:
    """Renvoie True si la clé était en alerte et qu'on doit notifier la résolution."""
    notifs = state.setdefault("notifs", {})
    if key in notifs:
        notifs.pop(key)
        return True
    return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ensure_dirs()
    state = load_state()

    metrics = {
        "ts": now_iso(),
        "hostname": socket.gethostname(),
        "uptime_s": metric_uptime_seconds(),
        "temp_c": metric_temperature(),
        "link": metric_link_status(),
        "link_flap_count_1min": metric_link_flap_count(),
        "services": metric_services(),
        "lmd": metric_load_mem_disk(),
        "dns": metric_dns_local(),
    }

    # Log toujours
    with HEALTH_LOG.open("a") as f:
        f.write(json.dumps(metrics, separators=(",", ":")) + "\n")

    # Evaluate
    anomalies = evaluate(metrics, state)
    active_keys = {a["key"] for a in anomalies}

    # Reset counters des clés qui sont rentrées dans l'ordre
    for k in list(state.get("err_counters", {}).keys()):
        if k not in active_keys:
            reset_err_counter(state, k)

    # Notif résolution
    notif_keys = set(state.get("notifs", {}).keys())
    for k in notif_keys - active_keys:
        if mark_resolved(state, k):
            send_mail(
                f"[pi-health] OK — {k} résolu",
                f"L'alerte {k} est résolue à {now_iso()}.\n"
                f"Metrics : {json.dumps(metrics, indent=2)}",
            )

    # Traite chaque anomalie
    for a in anomalies:
        # Auto-recovery (Phase 2)
        action = a.get("action")
        if action and should_recover(state, a["key"]):
            ok, log = trigger_recovery(action)
            a["recovery"] = log
            a["recovery_ok"] = ok

        with ALERTS_LOG.open("a") as f:
            f.write(json.dumps({"ts": metrics["ts"], **a}, separators=(",", ":")) + "\n")

        # Mail
        if should_notify(state, a["key"], a["level"]):
            subj = f"[pi-health] {a['level'].upper()} — {a['msg'][:80]}"
            body = (
                f"Alerte : {a['msg']}\n"
                f"Niveau : {a['level']}\n"
                f"Quand  : {metrics['ts']}\n"
                f"Hôte   : {metrics['hostname']}\n"
            )
            if a.get("recovery"):
                body += f"Recovery : {a['recovery']} (ok={a.get('recovery_ok')})\n"
            body += f"\nMetrics complètes :\n{json.dumps(metrics, indent=2)}\n"
            send_mail(subj, body)

    save_state(state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
