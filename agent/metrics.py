"""
Metrics collector for Control Tower.
Collects CPU, RAM, Disk, Temperature every 30 seconds.
Stores in a ring buffer (24h of data).
"""

import os
import platform
import time
import threading
import psutil
from collections import deque

IS_WINDOWS = platform.system() == "Windows"

# 24h at 30s intervals = 2880 points
MAX_POINTS = 2880
INTERVAL = 30  # seconds

# Ring buffer: deque of {timestamp, cpu, ram, disk, temp, swap, load}
metrics_history = deque(maxlen=MAX_POINTS)
_collector_running = False


def _read_temperature():
    """Read CPU temperature."""
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
    while _collector_running:
        try:
            point = collect_once()
            metrics_history.append(point)
        except Exception:
            pass
        time.sleep(INTERVAL)


def start_collector():
    """Start the background metrics collector."""
    if not _collector_running:
        t = threading.Thread(target=_collector_loop, daemon=True)
        t.start()


def get_history(minutes: int = 60) -> list:
    """Return metrics history for the last N minutes."""
    cutoff = int(time.time()) - (minutes * 60)
    return [p for p in metrics_history if p["ts"] >= cutoff]
