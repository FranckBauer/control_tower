"""
Proxy router for the Pi Dashboard.

Forwards requests to the appropriate machine agent and provides
dashboard-specific endpoints for machine management and file transfer.
"""

import json
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse, Response

router = APIRouter()

MACHINES_FILE = Path(__file__).resolve().parent.parent / "machines.json"


def _load_machines() -> list[dict]:
    """Load machines list from machines.json."""
    with open(MACHINES_FILE, "r") as f:
        return json.load(f)["machines"]


def _save_machines(machines: list[dict]) -> None:
    """Save machines list to machines.json."""
    with open(MACHINES_FILE, "w") as f:
        json.dump({"machines": machines}, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _find_machine(machine_id: str) -> Optional[dict]:
    """Find a machine by its id."""
    machines = _load_machines()
    for m in machines:
        if m["id"] == machine_id:
            return m
    return None


# ---------------------------------------------------------------------------
# Dashboard-specific endpoints
# ---------------------------------------------------------------------------

@router.get("/api/machines")
async def list_machines():
    """Return all machines with their online/offline status."""
    machines = _load_machines()
    results = []
    async with httpx.AsyncClient(timeout=2.0) as client:
        for machine in machines:
            url = f"http://{machine['ip']}:{machine['agent_port']}/health"
            status = "offline"
            try:
                resp = await client.get(url)
                if resp.status_code == 200:
                    status = "online"
            except (httpx.ConnectError, httpx.TimeoutException, httpx.RequestError):
                pass
            results.append({**machine, "status": status})
    return results


@router.post("/api/machines")
async def add_machine(request: Request):
    """Add a new machine to the configuration."""
    body = await request.json()
    required = {"id", "name", "description", "ip", "agent_port", "icon"}
    missing = required - set(body.keys())
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing fields: {', '.join(missing)}")

    machines = _load_machines()
    if any(m["id"] == body["id"] for m in machines):
        raise HTTPException(status_code=409, detail=f"Machine '{body['id']}' already exists")

    new_machine = {k: body[k] for k in required}
    machines.append(new_machine)
    _save_machines(machines)
    return {"success": True, "machine": new_machine}


@router.delete("/api/machines/{machine_id}")
async def remove_machine(machine_id: str):
    """Remove a machine from the configuration."""
    machines = _load_machines()
    original_len = len(machines)
    machines = [m for m in machines if m["id"] != machine_id]
    if len(machines) == original_len:
        raise HTTPException(status_code=404, detail=f"Machine '{machine_id}' not found")
    _save_machines(machines)
    return {"success": True, "message": f"Machine '{machine_id}' removed"}


@router.post("/api/transfer")
async def transfer_file(request: Request):
    """Transfer a file from one machine to another via the dashboard."""
    body = await request.json()
    required = {"source_machine", "source_path", "dest_machine", "dest_path"}
    missing = required - set(body.keys())
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing fields: {', '.join(missing)}")

    source = _find_machine(body["source_machine"])
    dest = _find_machine(body["dest_machine"])

    if not source:
        raise HTTPException(status_code=404, detail=f"Source machine '{body['source_machine']}' not found")
    if not dest:
        raise HTTPException(status_code=404, detail=f"Destination machine '{body['dest_machine']}' not found")

    source_url = f"http://{source['ip']}:{source['agent_port']}/api/files/download"
    dest_url = f"http://{dest['ip']}:{dest['agent_port']}/api/files/upload"

    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            # Download from source
            download_resp = await client.get(source_url, params={"path": body["source_path"]})
            if download_resp.status_code != 200:
                return JSONResponse(
                    status_code=502,
                    content={"success": False, "message": f"Failed to download from source: {download_resp.status_code}"},
                )

            # Upload to destination
            filename = Path(body["source_path"]).name
            upload_resp = await client.post(
                dest_url,
                files={"file": (filename, download_resp.content)},
                data={"path": body["dest_path"]},
            )
            if upload_resp.status_code != 200:
                return JSONResponse(
                    status_code=502,
                    content={"success": False, "message": f"Failed to upload to destination: {upload_resp.status_code}"},
                )

            return {"success": True, "message": f"Transferred {filename} from {source['name']} to {dest['name']}"}

    except (httpx.ConnectError, httpx.TimeoutException) as exc:
        return JSONResponse(
            status_code=503,
            content={"success": False, "message": f"Connection error during transfer: {str(exc)}"},
        )


# ---------------------------------------------------------------------------
# Catch-all proxy: /api/m/{machine_id}/{path}
# ---------------------------------------------------------------------------

@router.api_route("/api/m/{machine_id}/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_to_agent(machine_id: str, path: str, request: Request):
    """Proxy any request to the appropriate machine agent."""
    machine = _find_machine(machine_id)
    if not machine:
        raise HTTPException(status_code=404, detail=f"Machine '{machine_id}' not found")

    base_url = f"http://{machine['ip']}:{machine['agent_port']}"
    target_url = f"{base_url}/api/{path}"

    # Longer timeout for update/upgrade operations
    timeout = 600.0 if "update" in path else 30.0

    # Forward query params
    if request.url.query:
        target_url = f"{target_url}?{request.url.query}"

    # Forward headers (skip hop-by-hop headers)
    skip_headers = {"host", "transfer-encoding", "connection"}
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in skip_headers
    }

    # Read body
    body = await request.body()

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body if body else None,
            )

            # Build response, forwarding content-type
            response_headers = {}
            if "content-type" in resp.headers:
                response_headers["content-type"] = resp.headers["content-type"]

            content_type = resp.headers.get("content-type", "")
            if "application/json" in content_type:
                return JSONResponse(
                    status_code=resp.status_code,
                    content=resp.json(),
                    headers=response_headers,
                )
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                headers=response_headers,
            )

    except (httpx.ConnectError, httpx.TimeoutException) as exc:
        return JSONResponse(
            status_code=503,
            content={"error": f"Agent unreachable: {str(exc)}"},
        )
    except httpx.RequestError as exc:
        return JSONResponse(
            status_code=503,
            content={"error": f"Proxy error: {str(exc)}"},
        )
