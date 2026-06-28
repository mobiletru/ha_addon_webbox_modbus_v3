"""Parse SMA Modbus profile XML (SI6048MBP.xml) into register definitions."""

from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any


DISP_SCALE = {
    "FIX0": 1.0,
    "FIX1": 0.1,
    "FIX2": 0.01,
    "FIX3": 0.001,
    "RAW": 1.0,
    "TEMP": 1.0,
    "Dauer": 1.0,
    "DT": 1.0,
    "FW": 1.0,
    "TAGLIST": 1.0,
}


@dataclass(frozen=True)
class RegisterDef:
    address: int
    name: str
    dtype: str
    write: bool
    scale: float
    disp: str
    unit: str

    @property
    def value_scale(self) -> float:
        base = DISP_SCALE.get(self.disp, 1.0)
        if self.scale and self.scale != 1:
            return base / self.scale
        return base


def _default_profile_path() -> Path:
    env = os.environ.get("MODBUS_PROFILE_PATH")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "profiles" / "SI6048MBP.xml"


def load_profile(path: Path | None = None) -> dict[str, RegisterDef]:
    profile_path = path or _default_profile_path()
    tree = ET.parse(profile_path)
    root = tree.getroot()
    registers: dict[str, RegisterDef] = {}
    for ch in root.findall("channel"):
        name = ch.get("name") or ""
        if not name:
            continue
        registers[name] = RegisterDef(
            address=int(ch.get("address", "0")),
            name=name,
            dtype=(ch.get("type") or "U32").upper(),
            write=(ch.get("write") or "false").lower() == "true",
            scale=float(ch.get("scale") or "1"),
            disp=ch.get("disp") or "FIX0",
            unit=ch.get("unit") or "",
        )
    return registers


@lru_cache(maxsize=1)
def get_registers() -> dict[str, RegisterDef]:
    return load_profile()


def register_catalog() -> list[dict[str, Any]]:
    regs = get_registers()
    items = [asdict(r) for r in regs.values()]
    items.sort(key=lambda x: x["address"])
    for item in items:
        item["category"] = _register_category(int(item["address"]))
    return items


def catalog_summary() -> dict[str, int]:
    items = register_catalog()
    sensors = sum(1 for i in items if not i["write"])
    settings = sum(1 for i in items if i["write"])
    return {"total": len(items), "sensors": sensors, "settings": settings}


def filter_catalog(kind: str | None = None) -> list[dict[str, Any]]:
    items = register_catalog()
    if kind == "sensors":
        return [i for i in items if not i["write"]]
    if kind == "settings":
        return [i for i in items if i["write"]]
    return items


def _register_category(address: int) -> str:
    if address < 30500:
        return "Device"
    if address < 30700:
        return "Energy counters"
    if address < 30840:
        return "Inverter"
    if address < 30860:
        return "Battery"
    if address < 30885:
        return "Power & grid"
    if address < 40000:
        return "External & generator"
    return "Configuration"
