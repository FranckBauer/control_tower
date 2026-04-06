"""Integration tests for the Control Tower API.

Run with: python -m pytest tests/ -v
Requires: dashboard on :3000, agents on :3001/:3002
"""
import pytest
import httpx
import json

BASE = "http://localhost:3000"
MACHINES = ["formule1-win", "formule1-wsl", "rasta-server"]
TIMEOUT = 10.0


@pytest.fixture
def client():
    return httpx.Client(base_url=BASE, timeout=TIMEOUT)


# ---- Machines ----

def test_machines_list(client):
    r = client.get("/api/machines")
    assert r.status_code == 200
    machines = r.json()
    assert isinstance(machines, list)
    assert len(machines) >= 1
    for m in machines:
        assert "id" in m
        assert "name" in m
        assert "status" in m
        assert m["status"] in ("online", "offline")


# ---- System ----

@pytest.mark.parametrize("machine_id", MACHINES)
def test_system(client, machine_id):
    r = client.get(f"/api/m/{machine_id}/system")
    if r.status_code == 503:
        pytest.skip(f"{machine_id} offline")
    assert r.status_code == 200
    d = r.json()
    assert "hostname" in d
    assert "platform" in d
    assert "cpu_percent" in d
    assert isinstance(d["cpu_percent"], (int, float))
    assert "memory" in d
    assert "percent" in d["memory"]
    assert "disk" in d
    assert "percent" in d["disk"]
    assert "uptime_seconds" in d
    assert "load_average" in d
    assert isinstance(d["load_average"], list)
    assert "swap" in d


# ---- Services ----

@pytest.mark.parametrize("machine_id", MACHINES)
def test_services(client, machine_id):
    r = client.get(f"/api/m/{machine_id}/services")
    if r.status_code == 503:
        pytest.skip(f"{machine_id} offline")
    assert r.status_code == 200
    services = r.json()
    assert isinstance(services, list)
    for svc in services:
        assert "name" in svc
        assert "active" in svc
        assert "enabled" in svc


# ---- Network ----

@pytest.mark.parametrize("machine_id", MACHINES)
def test_network(client, machine_id):
    r = client.get(f"/api/m/{machine_id}/network")
    if r.status_code == 503:
        pytest.skip(f"{machine_id} offline")
    assert r.status_code == 200
    d = r.json()
    assert "interfaces" in d
    assert isinstance(d["interfaces"], list)
    assert "connections" in d
    assert "io" in d
    assert "bytes_sent" in d["io"]
    assert "bytes_recv" in d["io"]


# ---- Drives ----

@pytest.mark.parametrize("machine_id", MACHINES)
def test_drives(client, machine_id):
    r = client.get(f"/api/m/{machine_id}/drives")
    if r.status_code == 503:
        pytest.skip(f"{machine_id} offline")
    assert r.status_code == 200
    d = r.json()
    assert "drives" in d
    assert isinstance(d["drives"], list)


# ---- Files ----

@pytest.mark.parametrize("machine_id", MACHINES)
def test_files_list(client, machine_id):
    r = client.get(f"/api/m/{machine_id}/files", params={"path": "/"})
    if r.status_code == 503:
        pytest.skip(f"{machine_id} offline")
    assert r.status_code == 200
    d = r.json()
    assert "path" in d
    assert "entries" in d
    assert isinstance(d["entries"], list)
    if d["entries"]:
        entry = d["entries"][0]
        assert "name" in entry
        assert "is_dir" in entry


@pytest.mark.parametrize("machine_id", ["formule1-wsl", "rasta-server"])
def test_file_content(client, machine_id):
    r = client.get(f"/api/m/{machine_id}/files/content", params={"path": "/etc/hostname"})
    if r.status_code == 503:
        pytest.skip(f"{machine_id} offline")
    assert r.status_code == 200
    d = r.json()
    assert "content" in d
    assert "path" in d
    assert len(d["content"]) > 0


# ---- Terminal ----

@pytest.mark.parametrize("machine_id", MACHINES)
def test_terminal(client, machine_id):
    r = client.post(f"/api/m/{machine_id}/terminal", json={"command": "echo hello"})
    if r.status_code == 503:
        pytest.skip(f"{machine_id} offline")
    assert r.status_code == 200
    d = r.json()
    assert "stdout" in d
    assert "stderr" in d
    assert "returncode" in d
    assert "hello" in d["stdout"]


def test_terminal_cwd(client):
    r = client.post("/api/m/formule1-wsl/terminal", json={"command": "cd /tmp"})
    if r.status_code == 503:
        pytest.skip("formule1-wsl offline")
    assert r.status_code == 200
    d = r.json()
    assert d.get("cwd") == "/tmp"

    r = client.post("/api/m/formule1-wsl/terminal", json={"command": "pwd", "cwd": "/tmp"})
    assert r.status_code == 200
    assert "/tmp" in r.json()["stdout"]


def test_terminal_blocked_command(client):
    r = client.post("/api/m/formule1-wsl/terminal", json={"command": "rm -rf /"})
    assert r.status_code == 403


# ---- Updates ----

@pytest.mark.parametrize("machine_id", ["formule1-wsl"])
def test_update_check(client, machine_id):
    r = client.post(f"/api/m/{machine_id}/update/check")
    if r.status_code == 503:
        pytest.skip(f"{machine_id} offline")
    assert r.status_code == 200
    d = r.json()
    assert "output" in d
    assert "success" in d


# ---- Logs ----

@pytest.mark.parametrize("machine_id", MACHINES)
def test_logs(client, machine_id):
    r = client.get(f"/api/m/{machine_id}/logs", params={"service": "system", "lines": 5})
    if r.status_code == 503:
        pytest.skip(f"{machine_id} offline")
    assert r.status_code == 200
    d = r.json()
    assert "lines" in d
    assert isinstance(d["lines"], list)


# ---- Static files ----

def test_static_html(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "Control Tower" in r.text


def test_static_css(client):
    r = client.get("/style.css")
    assert r.status_code == 200


def test_static_js(client):
    r = client.get("/app.js")
    assert r.status_code == 200
