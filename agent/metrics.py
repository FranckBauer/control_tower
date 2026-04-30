"""
Metrics collector for Control Tower.
Collects CPU, RAM, Disk, Temperature every 30 seconds.
Stores in a ring buffer (24h of data), persisté sur disque pour survivre aux reboots.
"""

import json
import os
import platform
import time
import threading
import psutil
from collections import deque
from pathlib import Path

IS_WINDOWS = platform.system() == "Windows"

# 24h at 30s intervals = 2880 points
MAX_POINTS = 2880
INTERVAL = 30  # seconds

# Persistence : fichier dans le working dir de l'agent
HISTORY_FILE = Path(os.environ.get("CT_HISTORY_FILE", ".metrics_history.json"))

# Ring buffer: deque of {timestamp, cpu, ram, disk, temp, swap, load}
metrics_history = deque(maxlen=MAX_POINTS)
_collector_running = False
_save_lock = threading.Lock()


def _load_history():
    """Recharge la deque depuis le disque au demarrage de l'agent."""
    if not HISTORY_FILE.exists():
        return
    try:
        with open(HISTORY_FILE, "r") as f:
            data = json.load(f)
        # On garde seulement les points encore dans la fenetre 24h
        cutoff = int(time.time()) - (MAX_POINTS * INTERVAL)
        for point in data:
            if point.get("ts", 0) >= cutoff:
                metrics_history.append(point)
    except Exception:
        # Fichier corrompu : on ignore plutot que de crasher l'agent
        pass


def _save_history():
    """Sauvegarde la deque sur disque (atomique via fichier temporaire)."""
    with _save_lock:
        try:
            tmp = HISTORY_FILE.with_suffix(HISTORY_FILE.suffix + ".tmp")
            with open(tmp, "w") as f:
                json.dump(list(metrics_history), f)
            tmp.replace(HISTORY_FILE)
        except Exception:
            pass


def _read_temperature():
    """Read CPU temperature.

    Sur Windows : pas de mesure fiable sans driver dedie (valeurs figees ACPI),
    on renvoie None pour eviter d'afficher une fausse valeur.
    """
    if IS_WINDOWS:
        return None
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return round(int(f.read().strip()) / 1000, 1)
    except Exception:
        pass
    try:
        temps = psutil.sensors_temperatures()
        if temps:
            for name, entries in temps.items():
                if entries:
                    return round(entries[0].current, 1)
    except Exception:
        pass
    return None


def collect_once():
    """Collect a single metrics snapshot."""
    cpu = psutil.cpu_percent(interval=0)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("C:\\" if IS_WINDOWS else "/")
    swap = psutil.swap_memory()
    temp = _read_temperature()

    try:
        load = list(psutil.getloadavg())
    except (AttributeError, OSError):
        load = [0, 0, 0]

    return {
        "ts": int(time.time()),
        "cpu": round(cpu, 1),
        "ram": round(mem.percent, 1),
        "disk": round(disk.percent, 1),
        "temp": temp,
        "swap": round(swap.percent, 1),
        "load": round(load[0], 2),
    }


def _collector_loop():
    """Background thread that collects metrics every INTERVAL seconds."""
    global _collector_running
    _collector_running = True
    save_every = 4  # sauvegarde tous les 4 points = toutes les 2 minutes
    counter = 0
    while _collector_running:
        try:
            point = collect_once()
            metrics_history.append(point)
            counter += 1
            if counter >= save_every:
                _save_history()
                counter = 0
        except Exception:
            pass
        time.sleep(INTERVAL)


def start_collector():
    """Start the background metrics collector."""
    if not _collector_running:
        _load_history()
        t = threading.Thread(target=_collector_loop, daemon=True)
        t.start()


def get_history(minutes: int = 60) -> list:
    """Return metrics history for the last N minutes."""
    cutoff = int(time.time()) - (minutes * 60)
    return [p for p in metrics_history if p["ts"] >= cutoff]
