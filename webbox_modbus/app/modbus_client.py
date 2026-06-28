"""Synchronous SMA Modbus TCP client (run via asyncio.to_thread)."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Union

from pymodbus.client import ModbusTcpClient

from .profile_loader import RegisterDef, get_registers

_LOGGER = logging.getLogger(__name__)

_MAX_BLOCK_WORDS = 120
_MAX_BLOCK_GAP = 6


def _word_count(reg: RegisterDef) -> int:
    return 2 if reg.dtype in ("U32", "S32") else 1


def _merge_read_blocks(regs: list[RegisterDef]) -> list[tuple[int, int, list[RegisterDef]]]:
    if not regs:
        return []
    sorted_regs = sorted(regs, key=lambda r: r.address)
    blocks: list[tuple[int, int, list[RegisterDef]]] = []
    block_start = sorted_regs[0].address
    block_end = sorted_regs[0].address + _word_count(sorted_regs[0])
    block_regs = [sorted_regs[0]]

    for reg in sorted_regs[1:]:
        reg_start = reg.address
        reg_end = reg.address + _word_count(reg)
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


def _decode(words: List[int], reg: RegisterDef) -> Union[int, float]:
    dtype = reg.dtype
    if dtype == "U16":
        raw = words[0] & 0xFFFF
    elif dtype == "S16":
        raw = words[0]
        if raw >= 0x8000:
            raw -= 0x10000
    elif dtype == "S32":
        raw = ((words[0] & 0xFFFF) << 16) | (words[1] & 0xFFFF)
        if raw >= 0x80000000:
            raw -= 0x100000000
    else:
        raw = ((words[0] & 0xFFFF) << 16) | (words[1] & 0xFFFF)

    scale = reg.value_scale
    if scale == 1.0:
        return raw
    return round(raw * scale, 4)


def _encode(value: Union[int, float], reg: RegisterDef) -> List[int]:
    scale = reg.value_scale
    raw = int(round(float(value) / scale))
    if reg.dtype in ("U16", "S16"):
        return [raw & 0xFFFF]
    if raw < 0:
        raw = (1 << 32) + raw
    return [(raw >> 16) & 0xFFFF, raw & 0xFFFF]


class SMAModbusClient:
    def __init__(
        self,
        host: str,
        *,
        port: int = 502,
        unit_id: int = 3,
        registers: dict[str, RegisterDef] | None = None,
    ) -> None:
        self._host = host
        self._port = port
        self._unit = unit_id
        self._registers = registers or get_registers()
        self._client: Optional[ModbusTcpClient] = None

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def _ensure(self) -> ModbusTcpClient:
        if self._client is None:
            self._client = ModbusTcpClient(host=self._host, port=self._port)
        if not self._client.connected:
            if not self._client.connect():
                raise ConnectionError(f"Modbus TCP connect failed to {self._host}:{self._port}")
        return self._client

    def _read_words(self, address: int, count: int) -> List[int]:
        client = self._ensure()
        kwargs: dict[str, Any] = {"address": address, "count": count}
        try:
            kwargs["device_id"] = self._unit
            result = client.read_holding_registers(**kwargs)
        except TypeError:
            kwargs["slave"] = self._unit
            result = client.read_holding_registers(**kwargs)
        if result.isError():
            raise RuntimeError(f"Modbus read error @ {address}: {result}")
        return list(result.registers)

    def _write_words(self, address: int, values: List[int]) -> None:
        client = self._ensure()
        if len(values) == 1:
            kwargs: dict[str, Any] = {"address": address, "value": values[0]}
            try:
                kwargs["device_id"] = self._unit
                result = client.write_register(**kwargs)
            except TypeError:
                kwargs["slave"] = self._unit
                result = client.write_register(**kwargs)
        else:
            kwargs = {"address": address, "values": values}
            try:
                kwargs["device_id"] = self._unit
                result = client.write_registers(**kwargs)
            except TypeError:
                kwargs["slave"] = self._unit
                result = client.write_registers(**kwargs)
        if result.isError():
            raise RuntimeError(f"Modbus write error @ {address}: {result}")

    def read_register(self, name: str) -> Union[int, float]:
        reg = self._registers[name]
        count = 2 if reg.dtype in ("U32", "S32") else 1
        words = self._read_words(reg.address, count)
        return _decode(words, reg)

    def write_register(self, name: str, value: Union[int, float]) -> None:
        reg = self._registers[name]
        if not reg.write:
            raise ValueError(f"Register {name!r} is read-only")
        self._write_words(reg.address, _encode(value, reg))

    def read_many(self, names: List[str]) -> Dict[str, Union[int, float]]:
        targets = [self._registers[n] for n in names if n in self._registers]
        if not targets:
            return {}
        out: Dict[str, Union[int, float]] = {}
        for start, count, block_regs in _merge_read_blocks(targets):
            try:
                words = self._read_words(start, count)
            except Exception as exc:
                _LOGGER.warning("Modbus block read @ %s failed: %s", start, exc)
                for reg in block_regs:
                    try:
                        out[reg.name] = self.read_register(reg.name)
                    except Exception as inner:
                        _LOGGER.warning("Modbus read %s failed: %s", reg.name, inner)
                continue
            for reg in block_regs:
                offset = reg.address - start
                wc = _word_count(reg)
                try:
                    out[reg.name] = _decode(words[offset : offset + wc], reg)
                except Exception as exc:
                    _LOGGER.warning("Modbus decode %s failed: %s", reg.name, exc)
        return out

    def read_all(self) -> Dict[str, Union[int, float]]:
        return self.read_many(list(self._registers.keys()))

    def test_connection(self) -> bool:
        self.read_register("BatSoc")
        return True

    def register_info(self, name: str) -> dict[str, Any]:
        reg = self._registers[name]
        return {
            "name": reg.name,
            "address": reg.address,
            "dtype": reg.dtype,
            "write": reg.write,
            "unit": reg.unit,
            "disp": reg.disp,
        }
