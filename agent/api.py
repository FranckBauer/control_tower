import asyncio
import os
import platform
import shutil
import socket
import string
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import psutil
from fastapi import APIRouter, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import FileResponse
from pydantic import BaseModel

router = APIRouter()

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

IS_WINDOWS = platform.system() == "Windows"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

LINUX_SERVICES = [
    "ssh",
    "sshd",
    "pihole-FTL",
    "nginx",
    "docker",
    "bluetooth",
    "avahi-daemon",
    "cron",
    "tailscaled",
]

WINDOWS_SERVICES = [
    "Tailscale",
    "Spooler",
    "wuauserv",
    "W32Time",
    "Dhcp",
    "Dnscache",
    "LanmanServer",
    "LanmanWorkstation",
    "WinRM",
    "sshd",
    "WSearch",
    "Themes",
    "AudioSrv",
]

ALLOWED_SERVICES = WINDOWS_SERVICES if IS_WINDOWS else LINUX_SERVICES

LINUX_ALLOWED_FILE_PREFIXES = ["/etc", "/home", "/var", "/opt", "/tmp", "/root", "/usr/local"]

BLOCKED_COMMANDS = [
    "rm -rf /",
    "mkfs",
    "dd if=",
    ":()",
    "fork bomb",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
    "init 0",
    "init 6",
]

WINDOWS_BLOCKED_COMMANDS = [
    "format",
    "del /s",
    "rd /s",
    "remove-item -recurse",
]

if IS_WINDOWS:
    BLOCKED_COMMANDS.extend(WINDOWS_BLOCKED_COMMANDS)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class TerminalCommand(BaseModel):
    command: str
    cwd: Optional[str] = None


class FileContent(BaseModel):
    path: str
    content: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_path_allowed(path: str) -> bool:
    """Check that the resolved path is safe to access."""
    try:
        resolved = str(Path(path).resolve())
        # Block /proc, /sys, /dev on Linux (virtual filesystems)
        if not IS_WINDOWS:
            blocked = ["/proc", "/sys", "/dev"]
            if any(resolved == b or resolved.startswith(b + "/") for b in blocked):
                return False
        return True
    except Exception:
        return False


def _is_command_blocked(command: str) -> bool:
    """Return True if the command matches any blocked pattern."""
    cmd_lower = command.lower().strip()
    for blocked in BLOCKED_COMMANDS:
        if blocked in cmd_lower:
            return True
    return False


def _read_temperature() -> Optional[float]:
    """Read CPU temperature. Try thermal_zone0 first, then psutil, else None."""
    if not IS_WINDOWS:
        try:
            with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
                return int(f.read().strip()) / 1000.0
        except Exception:
            pass

    try:
        temps = psutil.sensors_temperatures()
        if temps:
            for entries in temps.values():
                if entries:
                    return entries[0].current
    except (AttributeError, Exception):
        pass

    if IS_WINDOWS:
        # Try WMI thermal zone query
        try:
            import subprocess
            result = subprocess.run(
                ["wmic", "/namespace:\\\\root\\wmi", "PATH",
                 "MSAcpi_ThermalZoneTemperature", "get", "CurrentTemperature"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0:
                for line in result.stdout.strip().splitlines():
                    line = line.strip()
                    if line.isdigit():
                        raw = int(line)
                        return raw / 10.0 - 273.15
        except Exception:
            pass

    return None


async def _async_run(cmd: str, timeout: int = 10, stdin_data: Optional[str] = None) -> dict:
    """Run a shell command asynchronously and return stdout/stderr/returncode."""
    try:
        if IS_WINDOWS:
            proc = await asyncio.create_subprocess_exec(
                "cmd.exe", "/c", cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.PIPE if stdin_data else None,
            )
        else:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.PIPE if stdin_data else None,
            )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(input=stdin_data.encode() if stdin_data else None),
            timeout=timeout,
        )
        return {
            "stdout": stdout.decode(errors="replace"),
            "stderr": stderr.decode(errors="replace"),
            "returncode": proc.returncode,
        }
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return {"stdout": "", "stderr": "Command timed out", "returncode": -1}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "returncode": -1}


async def _async_run_powershell(cmd: str, timeout: int = 10) -> dict:
    """Run a PowerShell command asynchronously (Windows only)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "powershell.exe", "-NoProfile", "-OutputFormat", "Text", "-Command",
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " + cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(),
            timeout=timeout,
        )
        return {
            "stdout": stdout.decode(errors="replace"),
            "stderr": stderr.decode(errors="replace"),
            "returncode": proc.returncode,
        }
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return {"stdout": "", "stderr": "Command timed out", "returncode": -1}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "returncode": -1}


# ---------------------------------------------------------------------------
# System endpoints
# ---------------------------------------------------------------------------

@router.get("/api/system")
async def get_system_info():
    cpu_freq = psutil.cpu_freq()
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()

    if IS_WINDOWS:
        disk = psutil.disk_usage("C:\\")
    else:
        disk = psutil.disk_usage("/")

    try:
        load = list(os.getloadavg())
    except (AttributeError, OSError):
        # os.getloadavg() does not exist on Windows
        try:
            load = list(psutil.getloadavg())
        except (AttributeError, Exception):
            load = [0, 0, 0]

    return {
        "hostname": socket.gethostname(),
        "platform": platform.system(),
        "platform_release": platform.release(),
        "platform_version": platform.version(),
        "architecture": platform.machine(),
        "cpu_percent": psutil.cpu_percent(interval=0.5, percpu=False),
        "cpu_count": psutil.cpu_count(logical=True),
        "cpu_freq": cpu_freq.current if cpu_freq else None,
        "memory": {
            "total": mem.total,
            "used": mem.used,
            "available": mem.available,
            "percent": mem.percent,
        },
        "disk": {
            "total": disk.total,
            "used": disk.used,
            "free": disk.free,
            "percent": disk.percent,
        },
        "temperature": _read_temperature(),
        "uptime_seconds": time.time() - psutil.boot_time(),
        "load_average": load,
        "swap": {
            "total": swap.total,
            "used": swap.used,
            "percent": swap.percent,
        },
    }


# ---------------------------------------------------------------------------
# Process list endpoint
# ---------------------------------------------------------------------------

@router.get("/api/processes")
async def get_processes(sort: str = "cpu", limit: int = 25):
    """Return top processes sorted by cpu or memory usage."""
    import concurrent.futures

    def _collect():
        if IS_WINDOWS:
            # Fast path for Windows: minimal attrs to avoid slow syscalls
            total_mem = psutil.virtual_memory().total
            procs = []
            for p in psutil.process_iter(["pid", "name", "memory_info"]):
                try:
                    info = p.info
                    rss = info["memory_info"].rss if info.get("memory_info") else 0
                    procs.append({
                        "pid": info["pid"],
                        "name": info["name"] or "unknown",
                        "cpu_percent": 0.0,
                        "memory_percent": round((rss / total_mem) * 100, 1) if total_mem else 0.0,
                        "memory_rss": rss,
                        "status": "running",
                        "user": "",
                    })
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                    pass
            return procs
        else:
            attrs = ["pid", "name", "cpu_percent", "memory_percent", "memory_info", "status", "username"]
            procs = []
            for p in psutil.process_iter(attrs):
                try:
                    info = p.info
                    procs.append({
                        "pid": info["pid"],
                        "name": info["name"] or "unknown",
                        "cpu_percent": info["cpu_percent"] or 0.0,
                        "memory_percent": round(info["memory_percent"] or 0.0, 1),
                        "memory_rss": info["memory_info"].rss if info.get("memory_info") else 0,
                        "status": info["status"] or "unknown",
                        "user": info.get("username", "") or "",
                    })
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                    pass
            return procs

    # Run in thread to avoid blocking the event loop
    loop = asyncio.get_event_loop()
    procs = await loop.run_in_executor(None, _collect)

    if sort == "memory":
        procs.sort(key=lambda x: x["memory_percent"], reverse=True)
    else:
        procs.sort(key=lambda x: x["cpu_percent"], reverse=True)

    return {"processes": procs[:limit], "total": len(procs)}


@router.get("/api/disk/usage")
async def get_disk_usage():
    """Return disk usage per partition/drive with top directories if possible."""
    partitions = []
    for p in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(p.mountpoint)
            partitions.append({
                "device": p.device,
                "mountpoint": p.mountpoint,
                "fstype": p.fstype,
                "total": usage.total,
                "used": usage.used,
                "free": usage.free,
                "percent": usage.percent,
            })
        except (PermissionError, OSError):
            pass
    return {"partitions": partitions}


# ---------------------------------------------------------------------------
# Network endpoints
# ---------------------------------------------------------------------------

@router.get("/api/network")
async def get_network_info():
    addrs = psutil.net_if_addrs()
    interfaces = []
    for iface, addr_list in addrs.items():
        iface_lower = iface.lower()
        if iface_lower in ("lo", "loopback"):
            continue
        # Skip Windows loopback pseudo-interface
        if "loopback pseudo-interface" in iface_lower:
            continue
        addresses = []
        for addr in addr_list:
            if addr.family.name == "AF_INET":
                addresses.append({"ip": addr.address, "netmask": addr.netmask})
        if addresses:
            interfaces.append({"name": iface, "addresses": addresses})

    try:
        connections = len(psutil.net_connections())
    except (psutil.AccessDenied, PermissionError, OSError):
        connections = 0

    io = psutil.net_io_counters()

    return {
        "interfaces": interfaces,
        "connections": connections,
        "io": {
            "bytes_sent": io.bytes_sent,
            "bytes_recv": io.bytes_recv,
            "packets_sent": io.packets_sent,
            "packets_recv": io.packets_recv,
        },
    }


# ---------------------------------------------------------------------------
# Services endpoints
# ---------------------------------------------------------------------------

async def _get_windows_service_status(name: str) -> dict:
    """Query a Windows service status using sc query and sc qc."""
    service_info = {
        "name": name,
        "active": "unknown",
        "enabled": "unknown",
    }

    # Get running state
    result = await _async_run(f"sc query {name}", timeout=5)
    if result["returncode"] == 0:
        state_map = {
            "RUNNING": "active",
            "STOPPED": "inactive",
            "STOP_PENDING": "deactivating",
            "START_PENDING": "activating",
            "PAUSED": "inactive",
            "PAUSE_PENDING": "deactivating",
            "CONTINUE_PENDING": "activating",
        }
        for line in result["stdout"].splitlines():
            line = line.strip()
            if "STATE" in line:
                for state_key, state_val in state_map.items():
                    if state_key in line:
                        service_info["active"] = state_val
                        break
                break

    # Get enabled/disabled (start type)
    result = await _async_run(f"sc qc {name}", timeout=5)
    if result["returncode"] == 0:
        for line in result["stdout"].splitlines():
            line = line.strip()
            if "START_TYPE" in line:
                line_upper = line.upper()
                if "AUTO_START" in line_upper or "DELAYED" in line_upper:
                    service_info["enabled"] = "enabled"
                elif "DEMAND_START" in line_upper:
                    service_info["enabled"] = "manual"
                elif "DISABLED" in line_upper:
                    service_info["enabled"] = "disabled"
                break

    return service_info


@router.get("/api/services")
async def get_services():
    if IS_WINDOWS:
        # List all real Windows services via PowerShell (fast, with description)
        result = await _async_run_powershell(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Service | Select-Object Name, DisplayName, Status, StartType | ConvertTo-Json -Compress -Depth 1",
            timeout=15
        )
        services = []
        if result["returncode"] == 0 and result["stdout"].strip():
            try:
                import json as _json
                raw = _json.loads(result["stdout"])
                if isinstance(raw, dict):
                    raw = [raw]
                for svc in raw:
                    # PowerShell may return string names or integer enum values
                    status_map = {"Running": "active", "Stopped": "inactive", "StartPending": "activating", "StopPending": "deactivating",
                                  "4": "active", "1": "inactive", "2": "activating", "3": "deactivating", "5": "activating", "6": "inactive", "7": "inactive"}
                    start_map = {"Automatic": "enabled", "Manual": "manual", "Disabled": "disabled", "Boot": "enabled", "System": "enabled",
                                 "2": "enabled", "3": "manual", "4": "disabled", "0": "enabled", "1": "enabled"}
                    services.append({
                        "name": svc.get("Name", ""),
                        "display_name": svc.get("DisplayName", ""),
                        "active": status_map.get(str(svc.get("Status", "")), "unknown"),
                        "enabled": start_map.get(str(svc.get("StartType", "")), "unknown"),
                    })
            except Exception:
                pass
        # Sort: active first, then by name
        services.sort(key=lambda s: (0 if s["active"] == "active" else 1, s["name"].lower()))
        return services

    # Linux path: list all installed services dynamically
    if not shutil.which("systemctl"):
        return []

    # Get all unit files of type service
    result = await _async_run(
        "systemctl list-units --type=service --all --no-pager --no-legend --plain",
        timeout=10
    )
    services = []
    seen = set()

    if result["returncode"] == 0:
        for line in result["stdout"].splitlines():
            parts = line.split()
            if len(parts) < 4:
                continue
            unit = parts[0]
            # Remove .service suffix
            name = unit.replace(".service", "")
            if name in seen:
                continue
            seen.add(name)

            active = parts[2] if len(parts) > 2 else "unknown"  # active/inactive/failed
            sub = parts[3] if len(parts) > 3 else ""
            # Description is everything after the 4th column
            description = " ".join(parts[4:]) if len(parts) > 4 else ""

            services.append({
                "name": name,
                "display_name": description,
                "active": active if active in ("active", "inactive", "failed") else "unknown",
                "enabled": "",  # filled below
            })

    # Get enabled status in batch
    enabled_result = await _async_run(
        "systemctl list-unit-files --type=service --no-pager --no-legend --plain",
        timeout=10
    )
    enabled_map = {}
    if enabled_result["returncode"] == 0:
        for line in enabled_result["stdout"].splitlines():
            parts = line.split()
            if len(parts) >= 2:
                uname = parts[0].replace(".service", "")
                enabled_map[uname] = parts[1]  # enabled/disabled/static/masked

    for svc in services:
        svc["enabled"] = enabled_map.get(svc["name"], "unknown")

    # Sort: active first, then by name
    services.sort(key=lambda s: (0 if s["active"] == "active" else 1 if s["active"] == "inactive" else 2, s["name"].lower()))
    return services


@router.post("/api/services/{name}/{action}")
async def manage_service(name: str, action: str):
    # Validate service name (prevent injection: only allow alphanumeric, dash, underscore, dot)
    import re
    if not re.match(r'^[a-zA-Z0-9._-]+$', name):
        raise HTTPException(status_code=400, detail=f"Invalid service name.")
    if action not in ("start", "stop", "restart"):
        raise HTTPException(status_code=400, detail=f"Action '{action}' is not allowed. Use start, stop, or restart.")

    if IS_WINDOWS:
        if action == "restart":
            result = await _async_run(f'sc stop "{name}"', timeout=15)
            # Wait briefly for the service to stop
            await asyncio.sleep(1)
            result = await _async_run(f'sc start "{name}"', timeout=15)
        else:
            result = await _async_run(f'sc {action} "{name}"', timeout=15)

        if result["returncode"] == 0:
            return {"success": True, "message": f"Service '{name}' {action}ed successfully."}

        # Fallback to net start/stop
        if action == "restart":
            await _async_run(f'net stop "{name}"', timeout=15)
            await asyncio.sleep(1)
            result = await _async_run(f'net start "{name}"', timeout=15)
        elif action == "start":
            result = await _async_run(f'net start "{name}"', timeout=15)
        elif action == "stop":
            result = await _async_run(f'net stop "{name}"', timeout=15)

        if result["returncode"] == 0:
            return {"success": True, "message": f"Service '{name}' {action}ed successfully."}
        return {"success": False, "message": result["stderr"].strip() or result["stdout"].strip() or "Unknown error"}
    else:
        result = await _async_run(f"sudo systemctl {action} {name}", timeout=15)
        if result["returncode"] == 0:
            return {"success": True, "message": f"Service '{name}' {action}ed successfully."}
        return {"success": False, "message": result["stderr"].strip() or "Unknown error"}


# ---------------------------------------------------------------------------
# Logs endpoints
# ---------------------------------------------------------------------------

@router.get("/api/logs")
async def get_logs(service: str = Query(default="system"), lines: int = Query(default=100)):
    if IS_WINDOWS:
        if service == "system":
            ps_cmd = (
                f"Get-EventLog -LogName System -Newest {lines} "
                f"| Format-Table -AutoSize -Wrap"
            )
        else:
            ps_cmd = (
                f"Get-WinEvent -FilterHashtable @{{LogName='System'; ProviderName='{service}'}} "
                f"-MaxEvents {lines} | Format-Table -AutoSize -Wrap"
            )
        result = await _async_run_powershell(ps_cmd, timeout=15)
        if result["returncode"] != 0:
            return {"lines": [], "error": result["stderr"].strip()}
        return {"lines": result["stdout"].strip().splitlines()}
    else:
        if service == "system":
            cmd = f"journalctl -n {lines} --no-pager -o short"
        else:
            cmd = f"journalctl -u {service} -n {lines} --no-pager -o short"

        result = await _async_run(cmd, timeout=10)
        if result["returncode"] != 0:
            return {"lines": [], "error": result["stderr"].strip()}
        return {"lines": result["stdout"].strip().splitlines()}


# ---------------------------------------------------------------------------
# Terminal endpoint
# ---------------------------------------------------------------------------

@router.post("/api/terminal")
async def run_terminal_command(body: TerminalCommand):
    command = body.command.strip()
    cwd = body.cwd
    if not command:
        raise HTTPException(status_code=400, detail="Empty command.")

    if _is_command_blocked(command):
        raise HTTPException(status_code=403, detail="This command is blocked for safety reasons.")

    # Handle 'cd' to track working directory
    new_cwd = cwd
    if command == "cd" or command.startswith("cd "):
        target = command[3:].strip() if command.startswith("cd ") else os.path.expanduser("~")
        target = target.strip('"').strip("'")
        # Resolve relative to current cwd
        if cwd and not os.path.isabs(target):
            target = os.path.join(cwd, target)
        resolved = str(Path(target).resolve())
        if os.path.isdir(resolved):
            return {"stdout": "", "stderr": "", "returncode": 0, "cwd": resolved}
        else:
            return {"stdout": "", "stderr": f"cd: {target}: No such directory", "returncode": 1, "cwd": cwd}

    # Prefix command with cd to cwd if set
    if cwd and os.path.isdir(cwd):
        if IS_WINDOWS:
            full_command = f'cd /d "{cwd}" && {command}'
        else:
            full_command = f'cd "{cwd}" && {command}'
    else:
        full_command = command

    if IS_WINDOWS:
        cmd_lower = command.lower()
        if cmd_lower.startswith("powershell ") or cmd_lower.startswith("ps "):
            if cmd_lower.startswith("ps "):
                ps_command = command[3:].strip()
            else:
                ps_command = command[len("powershell "):].strip()
            result = await _async_run_powershell(ps_command, timeout=15)
        else:
            result = await _async_run(full_command, timeout=15)
    else:
        result = await _async_run(full_command, timeout=15)

    return {
        "stdout": result["stdout"],
        "stderr": result["stderr"],
        "returncode": result["returncode"],
        "cwd": cwd,
    }


# ---------------------------------------------------------------------------
# Update endpoints
# ---------------------------------------------------------------------------

@router.post("/api/update/check")
async def update_check():
    if IS_WINDOWS:
        result = await _async_run_powershell(
            "winget upgrade --include-unknown", timeout=60
        )
    else:
        result = await _async_run("sudo apt update 2>&1", timeout=60)

    return {
        "output": result["stdout"] + result["stderr"],
        "success": result["returncode"] == 0,
    }


@router.post("/api/update/upgrade")
async def update_upgrade():
    if IS_WINDOWS:
        result = await _async_run_powershell(
            "winget upgrade --all --accept-source-agreements --accept-package-agreements",
            timeout=600,
        )
    else:
        result = await _async_run("sudo apt upgrade -y 2>&1", timeout=600)

    return {
        "output": result["stdout"] + result["stderr"],
        "success": result["returncode"] == 0,
    }


# ---------------------------------------------------------------------------
# File browser endpoints
# ---------------------------------------------------------------------------

@router.get("/api/drives")
async def list_drives():
    """List available drives (Windows) or mount points (Linux)."""
    if IS_WINDOWS:
        drives = []
        for letter in string.ascii_uppercase:
            drive_path = f"{letter}:\\"
            if os.path.exists(drive_path):
                try:
                    usage = psutil.disk_usage(drive_path)
                    drives.append({
                        "path": drive_path,
                        "label": f"{letter}:",
                        "total": usage.total,
                        "used": usage.used,
                        "free": usage.free,
                        "percent": usage.percent,
                    })
                except Exception:
                    drives.append({"path": drive_path, "label": f"{letter}:"})
        return {"drives": drives}
    else:
        # On Linux, return mount points from /proc/mounts
        mounts = []
        try:
            partitions = psutil.disk_partitions(all=False)
            for p in partitions:
                try:
                    usage = psutil.disk_usage(p.mountpoint)
                    mounts.append({
                        "path": p.mountpoint,
                        "label": p.device,
                        "fstype": p.fstype,
                        "total": usage.total,
                        "used": usage.used,
                        "free": usage.free,
                        "percent": usage.percent,
                    })
                except Exception:
                    mounts.append({"path": p.mountpoint, "label": p.device, "fstype": p.fstype})
        except Exception:
            mounts = [{"path": "/", "label": "/"}]
        return {"drives": mounts}


@router.get("/api/files")
async def list_files(path: str = Query(default=None)):
    if path is None:
        path = "C:\\" if IS_WINDOWS else "/etc"

    if not _is_path_allowed(path):
        raise HTTPException(status_code=403, detail="Access to this path is not allowed.")

    target = Path(path)
    if not target.is_dir():
        return {"error": "Directory not found."}

    entries = []
    try:
        for entry in target.iterdir():
            try:
                stat = entry.stat()
                entries.append({
                    "name": entry.name,
                    "is_dir": entry.is_dir(),
                    "size": stat.st_size,
                    "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                })
            except (PermissionError, OSError):
                entries.append({
                    "name": entry.name,
                    "is_dir": False,
                    "size": None,
                    "modified": None,
                })
    except PermissionError:
        return {"error": "Permission denied reading directory."}

    # Sort: directories first, then by name
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))

    return {"path": str(target.resolve()), "entries": entries}


@router.get("/api/files/content")
async def read_file_content(path: str = Query(...)):
    if not _is_path_allowed(path):
        raise HTTPException(status_code=403, detail="Access to this path is not allowed.")

    target = Path(path)
    if not target.is_file():
        return {"error": "File not found."}

    try:
        size = target.stat().st_size
        if size > 2_097_152:  # 2 MB
            return {"error": "File exceeds 2 MB size limit."}
        content = target.read_text(errors="replace")
    except PermissionError:
        if IS_WINDOWS:
            return {"error": "Permission denied reading file."}
        # Fall back to sudo cat on Linux
        result = await _async_run(f"sudo cat '{path}'", timeout=5)
        if result["returncode"] != 0:
            return {"error": "Permission denied reading file."}
        content = result["stdout"]
        size = len(content.encode())

    return {"path": str(target.resolve()), "content": content, "size": size}


@router.post("/api/files/content")
async def write_file_content(body: FileContent):
    if not _is_path_allowed(body.path):
        raise HTTPException(status_code=403, detail="Access to this path is not allowed.")

    # Try writing directly first
    try:
        Path(body.path).write_text(body.content)
        return {"success": True, "message": f"File '{body.path}' written successfully."}
    except PermissionError:
        pass

    if IS_WINDOWS:
        return {"success": False, "message": "Permission denied writing file."}

    # Fall back to sudo tee on Linux
    result = await _async_run(f"sudo tee '{body.path}'", timeout=10, stdin_data=body.content)
    if result["returncode"] != 0:
        return {"success": False, "message": result["stderr"].strip() or "Unknown error"}
    return {"success": True, "message": f"File '{body.path}' written successfully."}


@router.post("/api/files/upload")
async def upload_file(file: UploadFile = File(...), path: str = Form(...)):
    if not _is_path_allowed(path):
        raise HTTPException(status_code=403, detail="Access to this path is not allowed.")

    target_dir = Path(path)
    if not target_dir.is_dir():
        return {"success": False, "path": "", "error": "Target directory does not exist."}

    dest = target_dir / file.filename
    content = await file.read()
    try:
        dest.write_bytes(content)
    except PermissionError:
        if IS_WINDOWS:
            return {"success": False, "path": str(dest), "error": "Permission denied."}
        # Fall back to sudo tee with binary on Linux
        result = await _async_run(
            f"sudo tee '{dest}'",
            timeout=10,
            stdin_data=content.decode("latin-1"),
        )
        if result["returncode"] != 0:
            return {"success": False, "path": str(dest), "error": "Permission denied."}

    return {"success": True, "path": str(dest)}


@router.get("/api/files/download")
async def download_file(path: str = Query(...)):
    if not _is_path_allowed(path):
        raise HTTPException(status_code=403, detail="Access to this path is not allowed.")

    target = Path(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found.")

    return FileResponse(str(target.resolve()), filename=target.name)
