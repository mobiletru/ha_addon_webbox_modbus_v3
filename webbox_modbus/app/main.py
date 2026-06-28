"""FastAPI dashboard: Sunny WebBox RPC + Modbus TCP."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .crosswalk import crosswalk_catalog
from .parameters import enrich_parameters, get_commands, parameter_catalog
from .profile_loader import catalog_summary, filter_catalog, register_catalog
from .services import (
    build_snapshot,
    dual_write_parameter,
    modbus_client_for,
    read_modbus_registers,
    webbox_client_for,
    write_modbus_register,
)
from .webbox.client import WebBoxClient, WebBoxCredentials, WebBoxError, scan_subnet
from .webbox.storage import Storage

LOGGER = logging.getLogger("webbox.api")


def _configure_logging() -> None:
    level_name = os.environ.get("WEBBOX_LOG_LEVEL", "info").upper()
    level = getattr(logging, level_name, logging.INFO)
    logging.getLogger("webbox").setLevel(level)
    logging.getLogger("webbox.api").setLevel(level)
    logging.getLogger("webbox.client").setLevel(level)
    if not logging.getLogger().handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        logging.getLogger().addHandler(handler)
        logging.getLogger().setLevel(level)


_configure_logging()

_STATIC_DIR = Path(__file__).parent / "static"
_DATA_DIR = os.environ.get("WEBBOX_DATA_DIR", "/data")
_OPTIONS_PATH = os.environ.get("WEBBOX_OPTIONS_PATH", os.path.join(_DATA_DIR, "options.json"))
_PROFILE_DIR = Path(__file__).resolve().parent.parent / "profiles"
os.environ.setdefault("MODBUS_PROFILE_PATH", str(_PROFILE_DIR / "SI6048MBP.xml"))

storage = Storage(_DATA_DIR, _OPTIONS_PATH)


def _render_index_html() -> str:
    html = (_STATIC_DIR / "index.html").read_text(encoding="utf-8")
    return (
        html.replace('href="static/styles.css"', f'href="static/styles.css?v={__version__}"')
        .replace('src="static/app.js"', f'src="static/app.js?v={__version__}"')
    )


_INDEX_HTML = _render_index_html() if (_STATIC_DIR / "index.html").exists() else ""

app = FastAPI(title="WebBox Modbus Dashboard", version=__version__)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class WebBoxIn(BaseModel):
    name: str | None = None
    host: str
    password: str | None = None
    installer_password: str | None = None
    poll_interval: int | None = Field(default=30, ge=30, le=3600)
    public_url: str | None = None
    modbus_port: int | None = Field(default=502, ge=1, le=65535)
    modbus_unit_id: int | None = Field(default=3, ge=1, le=247)
    modbus_enabled: bool | None = True


class WebBoxPatch(BaseModel):
    name: str | None = None
    host: str | None = None
    password: str | None = None
    installer_password: str | None = None
    poll_interval: int | None = Field(default=None, ge=30, le=3600)
    public_url: str | None = None
    modbus_port: int | None = Field(default=None, ge=1, le=65535)
    modbus_unit_id: int | None = Field(default=None, ge=1, le=247)
    modbus_enabled: bool | None = None


class ParameterUpdate(BaseModel):
    channel: str
    value: Any


class DualParameterUpdate(BaseModel):
    value: Any
    via: Literal["rpc", "modbus", "both"] = "rpc"


class ModbusRegisterUpdate(BaseModel):
    value: Any


class ScanRequest(BaseModel):
    subnet: str | None = None


class CommandRequest(BaseModel):
    command: str | None = None
    channel: str | None = None
    value: Any | None = None


def _client_for(webbox: dict[str, Any]) -> WebBoxClient:
    return webbox_client_for(webbox)


def _require(webbox_id: str) -> dict[str, Any]:
    wb = storage.find(webbox_id)
    if not wb:
        raise HTTPException(status_code=404, detail=f"WebBox {webbox_id!r} not found")
    return wb


def _is_options_entry(webbox_id: str) -> bool:
    return webbox_id.startswith("opt:")


def _safe(webbox: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in webbox.items() if k not in ("password", "installer_password")}
    out["has_password"] = bool(webbox.get("password"))
    out["has_installer_password"] = bool(webbox.get("installer_password"))
    return out


if _STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


@app.get("/", include_in_schema=False, response_model=None)
async def index():
    return Response(content=_INDEX_HTML, media_type="text/html")


@app.get("/favicon.ico", include_in_schema=False, response_model=None)
async def favicon():
    icon = _STATIC_DIR / "favicon.svg"
    if icon.exists():
        return FileResponse(icon)
    return Response(status_code=204)


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "version": __version__}


@app.get("/api/webboxes")
async def list_webboxes() -> list[dict[str, Any]]:
    return [_safe(wb) for wb in storage.list_webboxes()]


@app.post("/api/webboxes", status_code=201)
async def create_webbox(payload: WebBoxIn) -> dict[str, Any]:
    try:
        wb = storage.add_webbox(payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return _safe(wb)


@app.patch("/api/webboxes/{webbox_id}")
async def update_webbox(webbox_id: str, payload: WebBoxPatch) -> dict[str, Any]:
    _require(webbox_id)
    if _is_options_entry(webbox_id):
        raise HTTPException(status_code=400, detail="Edit this WebBox in add-on Configuration.")
    try:
        wb = storage.update_webbox(webbox_id, payload.model_dump(exclude_unset=True))
    except KeyError:
        raise HTTPException(status_code=404, detail=f"WebBox {webbox_id!r} not found")
    return _safe(wb)


@app.delete("/api/webboxes/{webbox_id}", status_code=204, response_class=Response)
async def delete_webbox(webbox_id: str) -> Response:
    if _is_options_entry(webbox_id):
        raise HTTPException(status_code=400, detail="Remove this WebBox from add-on Configuration.")
    if not storage.remove_webbox(webbox_id):
        raise HTTPException(status_code=404, detail=f"WebBox {webbox_id!r} not found")
    return Response(status_code=204)


@app.get("/api/webboxes/{webbox_id}/status")
async def webbox_status(webbox_id: str) -> dict[str, Any]:
    wb = _require(webbox_id)
    async with _client_for(wb) as client:
        try:
            overview = await client.plant_overview()
            devices = await client.list_devices()
        except WebBoxError as exc:
            return {"online": False, "error": str(exc), "host": wb["host"]}
    return {"online": True, "host": wb["host"], "overview": overview, "devices": devices}


@app.get("/api/webboxes/{webbox_id}/devices")
async def webbox_devices(webbox_id: str) -> list[dict[str, Any]]:
    wb = _require(webbox_id)
    async with _client_for(wb) as client:
        try:
            return await client.list_devices()
        except WebBoxError as exc:
            raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/webboxes/{webbox_id}/devices/{device_key}/data")
async def webbox_device_data(webbox_id: str, device_key: str) -> list[dict[str, Any]]:
    wb = _require(webbox_id)
    async with _client_for(wb) as client:
        try:
            return await client.process_data(device_key)
        except WebBoxError as exc:
            raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/webboxes/{webbox_id}/devices/{device_key}/parameters")
async def webbox_device_parameters(webbox_id: str, device_key: str) -> list[dict[str, Any]]:
    wb = _require(webbox_id)
    async with _client_for(wb) as client:
        try:
            raw = await client.get_parameters(device_key)
        except WebBoxError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
    return enrich_parameters(raw)


@app.get("/api/catalog/sunny-island")
async def sunny_island_catalog() -> list[dict[str, Any]]:
    return parameter_catalog()


@app.get("/api/catalog/modbus")
async def modbus_catalog(kind: str | None = None) -> dict[str, Any]:
    items = filter_catalog(kind)
    return {"summary": catalog_summary(), "registers": items}


@app.get("/api/catalog/crosswalk")
async def catalog_crosswalk() -> list[dict[str, Any]]:
    return crosswalk_catalog()


@app.get("/api/commands")
async def list_commands() -> list[dict[str, Any]]:
    options = storage.options()
    custom = options.get("custom_commands") or []
    return get_commands(custom)


@app.put("/api/webboxes/{webbox_id}/devices/{device_key}/parameters")
async def webbox_set_parameter(
    webbox_id: str, device_key: str, payload: ParameterUpdate
) -> dict[str, Any]:
    wb = _require(webbox_id)
    if not wb.get("installer_password"):
        raise HTTPException(status_code=400, detail="Installer password required.")
    async with _client_for(wb) as client:
        try:
            result = await client.set_parameter(device_key, payload.channel, payload.value)
        except WebBoxError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
    return {"status": "ok", "result": result}


@app.put("/api/webboxes/{webbox_id}/devices/{device_key}/parameters/{param_id}")
async def webbox_dual_parameter(
    webbox_id: str, device_key: str, param_id: str, payload: DualParameterUpdate
) -> dict[str, Any]:
    wb = _require(webbox_id)
    if payload.via in ("rpc", "both") and not wb.get("installer_password"):
        raise HTTPException(status_code=400, detail="Installer password required for RPC writes.")
    try:
        return await dual_write_parameter(wb, device_key, param_id, payload.value, payload.via)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except WebBoxError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/api/webboxes/{webbox_id}/devices/{device_key}/command")
async def webbox_execute_command(
    webbox_id: str, device_key: str, payload: CommandRequest
) -> dict[str, Any]:
    wb = _require(webbox_id)
    if not wb.get("installer_password"):
        raise HTTPException(status_code=400, detail="Installer password required.")
    channel = payload.channel
    value = payload.value
    if payload.command:
        options = storage.options()
        custom = options.get("custom_commands") or []
        effective_commands = get_commands(custom)
        cmd = next((c for c in effective_commands if c["name"] == payload.command), None)
        if not cmd:
            raise HTTPException(status_code=400, detail=f"Unknown command {payload.command!r}")
        channel = cmd["channel"]
        value = cmd["value"]
    if not channel:
        raise HTTPException(status_code=400, detail="Either 'command' or 'channel' is required.")
    async with _client_for(wb) as client:
        try:
            result = await client.set_parameter(device_key, channel, value)
        except WebBoxError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
    return {"status": "ok", "command": payload.command, "channel": channel, "value": value, "result": result}


@app.get("/api/webboxes/{webbox_id}/modbus/status")
async def modbus_status(webbox_id: str) -> dict[str, Any]:
    wb = _require(webbox_id)
    result = await read_modbus_registers(wb, ["BatSoc"])
    return {"host": wb["host"], "port": wb.get("modbus_port", 502), "unit_id": wb.get("modbus_unit_id", 3), **result}


@app.get("/api/webboxes/{webbox_id}/modbus/registers")
async def modbus_registers(webbox_id: str, kind: str | None = None) -> dict[str, Any]:
    wb = _require(webbox_id)
    catalog = filter_catalog(kind)
    names = [r["name"] for r in catalog]
    live = await read_modbus_registers(wb, names)
    rows = []
    values = live.get("registers") or {}
    for reg in catalog:
        rows.append({**reg, "value": values.get(reg["name"])})
    populated = sum(1 for r in rows if r.get("value") is not None)
    return {
        "online": live.get("online", False),
        "error": live.get("error"),
        "host": wb["host"],
        "port": wb.get("modbus_port", 502),
        "unit_id": wb.get("modbus_unit_id", 3),
        "summary": catalog_summary(),
        "populated": populated,
        "registers": rows,
    }


@app.put("/api/webboxes/{webbox_id}/modbus/registers/{name}")
async def modbus_write_register(
    webbox_id: str, name: str, payload: ModbusRegisterUpdate
) -> dict[str, Any]:
    wb = _require(webbox_id)
    try:
        await write_modbus_register(wb, name, payload.value)
        reread = await read_modbus_registers(wb, [name])
        return {
            "status": "ok",
            "name": name,
            "value": reread.get("registers", {}).get(name),
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/webboxes/{webbox_id}/snapshot")
async def webbox_snapshot(webbox_id: str, device_key: str | None = None) -> dict[str, Any]:
    wb = _require(webbox_id)
    try:
        return await build_snapshot(wb, device_key)
    except WebBoxError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/api/scan")
async def scan(payload: ScanRequest) -> dict[str, Any]:
    subnet = (payload.subnet or "").strip()
    if not subnet:
        options = storage.options()
        subnet = (options.get("scan_subnet") or "").strip()
    if not subnet:
        raise HTTPException(status_code=400, detail="No subnet supplied.")
    try:
        found = await scan_subnet(subnet)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"subnet": subnet, "found": found}
