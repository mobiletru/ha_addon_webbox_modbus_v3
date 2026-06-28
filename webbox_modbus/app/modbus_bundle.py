"""Single-connection Modbus poll: status + live dashboard + profile registers."""

from __future__ import annotations

import asyncio
from typing import Any

from .live_registers import DEFAULT_MAP, LiveReg, decode_live_reg
from .modbus_client import _MAX_BLOCK_GAP, _MAX_BLOCK_WORDS, _decode, _merge_read_blocks, _word_count
from .modbus_policy import assert_modbus_enabled
from .panel_modbus import _client_for, _unit_id, _unit_kw
from .profile_loader import catalog_summary, filter_catalog, get_registers
from pymodbus.client import ModbusTcpClient


def _merge_live_blocks(regs: list[LiveReg]) -> list[tuple[int, int, list[LiveReg]]]:
    if not regs:
        return []
    sorted_regs = sorted(regs, key=lambda r: r.address)
    blocks: list[tuple[int, int, list[LiveReg]]] = []
    block_start = sorted_regs[0].address
    block_end = sorted_regs[0].address + sorted_regs[0].count
    block_regs = [sorted_regs[0]]

    for reg in sorted_regs[1:]:
        reg_start = reg.address
        reg_end = reg.address + reg.count
        gap = reg_start - block_end
        new_end = max(block_end, reg_end)
        if gap <= _MAX_BLOCK_GAP and (new_end - block_start) <= _MAX_BLOCK_WORDS:
            block_end = new_end
            block_regs.append(reg)
        else:
            blocks.append((block_start, block_end - block_start, block_regs))
            block_start = reg_start
            block_end = reg_end
            block_regs = [reg]

    blocks.append((block_start, block_end - block_start, block_regs))
    return blocks


def _read_profile_values(
    client: ModbusTcpClient,
    unit: int,
    rkw: str,
    names: list[str],
) -> dict[str, Any]:
    registers = get_registers()
    targets = [registers[n] for n in names if n in registers]
    if not targets:
        return {}
    out: dict[str, Any] = {}
    for start, count, block_regs in _merge_read_blocks(targets):
        try:
            rr = client.read_holding_registers(start, count=count, **{rkw: unit})
        except (ValueError, OSError):
            continue
        if rr.isError():
            continue
        words = list(rr.registers)
        for reg in block_regs:
            offset = reg.address - start
            wc = _word_count(reg)
            try:
                out[reg.name] = _decode(words[offset : offset + wc], reg)
            except Exception:
                pass
    return out


def _read_live_values(client: ModbusTcpClient, unit: int, rkw: str) -> dict[str, Any]:
    values: dict[str, Any] = {}
    decoded: dict[str, Any] = {}
    for start, count, block_regs in _merge_live_blocks(DEFAULT_MAP):
        try:
            rr = client.read_holding_registers(start, count=count, **{rkw: unit})
        except (ValueError, OSError):
            rr = None
        words = [] if rr is None or rr.isError() else list(rr.registers)
        for reg in block_regs:
            offset = reg.address - start
            try:
                decoded[reg.name] = (
                    None if not words else decode_live_reg(reg, words[offset : offset + reg.count])
                )
            except Exception:
                decoded[reg.name] = None
    for reg in DEFAULT_MAP:
        values[reg.name] = {
            "value": decoded.get(reg.name),
            "unit": reg.unit,
            "address": reg.address,
            "label": reg.label,
        }
    return values


def read_modbus_bundle_sync(
    webbox: dict[str, Any],
    kind: str | None = None,
    *,
    include_profile: bool = True,
) -> dict[str, Any]:
    try:
        assert_modbus_enabled(webbox)
    except ValueError as exc:
        return {
            "online": False,
            "error": str(exc),
            "host": webbox["host"],
            "port": int(webbox.get("modbus_port") or 502),
            "unit_id": int(webbox.get("modbus_unit_id") or 3),
            "live": {"values": {}},
            "registers": [],
            "summary": catalog_summary(),
            "populated": 0,
        }

    host = webbox["host"]
    port = int(webbox.get("modbus_port") or 502)
    unit = _unit_id(webbox)
    catalog = filter_catalog(kind) if include_profile else []
    names = [r["name"] for r in catalog]

    client = _client_for(webbox)
    if not client.connect():
        return {
            "online": False,
            "error": f"cannot reach {host}:{port}",
            "host": host,
            "port": port,
            "unit_id": unit,
            "live": {"values": {}},
            "registers": [{**reg, "value": None} for reg in catalog],
            "summary": catalog_summary(),
            "populated": 0,
        }

    rkw = _unit_kw(ModbusTcpClient.read_holding_registers)
    try:
        status_rr = client.read_holding_registers(30845, count=2, **{rkw: unit})
        online = not status_rr.isError()
        live_values = _read_live_values(client, unit, rkw) if online else {}
        profile_values = (
            _read_profile_values(client, unit, rkw, names) if online and include_profile else {}
        )
    except Exception as exc:
        return {
            "online": False,
            "error": str(exc),
            "host": host,
            "port": port,
            "unit_id": unit,
            "live": {"values": {}},
            "registers": [{**reg, "value": None} for reg in catalog],
            "summary": catalog_summary(),
            "populated": 0,
        }
    finally:
        client.close()

    rows = [{**reg, "value": profile_values.get(reg["name"])} for reg in catalog]
    populated = sum(1 for r in rows if r.get("value") is not None)
    return {
        "online": online,
        "error": None if online else "Modbus read failed",
        "host": host,
        "port": port,
        "unit_id": unit,
        "live": {
            "online": online,
            "host": host,
            "port": port,
            "unit_id": unit,
            "values": live_values,
        },
        "registers": rows,
        "summary": catalog_summary(),
        "populated": populated,
    }


async def read_modbus_bundle(
    webbox: dict[str, Any],
    kind: str | None = None,
    *,
    include_profile: bool = True,
) -> dict[str, Any]:
    return await asyncio.to_thread(read_modbus_bundle_sync, webbox, kind, include_profile=include_profile)
