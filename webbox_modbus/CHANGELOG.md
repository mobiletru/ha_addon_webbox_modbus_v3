# Changelog

## 1.4.3

- Faster startup: live dashboard loads first (`profile=false`), full SI6048 profile loads in background
- Block-read optimization for live dashboard registers (fewer Modbus round-trips)
- Background poll refreshes live values only; full profile on manual refresh or filter change
- Writable catalog loads when a WebBox is selected, not on initial page load

## 1.4.2

- Unified Modbus write policy: block profile-table and raw writes to setting registers
- Guarded setpoint / raw writes require installer password; panel restricted to admins
- Single `/modbus/bundle` poll (one TCP connection) replaces triple Modbus polling
- Connection errors return HTTP 502; invalid `kind` query returns 400

## 1.4.1

- Version bump; sync `io.hass.version` build label with add-on manifest

## 1.4.0

- Integrate webbox-panel features into the main dashboard: live verified map, register explorer, guarded setpoint writes, ack-gated raw write
- Add `grid_guard_code` and `raw_write_ack` add-on configuration options

## 1.3.0

- WebBox-level Modbus panel showing all 141 SI6048MBP registers (86 sensors, 55 settings)
- Sensors / Settings / All filter chips with grouped categories (Battery, Inverter, Grid, etc.)
- Block-read optimization for faster full-profile polling on port 502
- `host_network: true` so the add-on can reach Modbus TCP on the LAN
- Modbus port, unit ID, and enable toggle in Add/Edit WebBox form

## 1.2.0

- Full Home Assistant OS add-on packaging (Ingress panel, DOCS, cloudflared sidecar)
- Modbus + RPC dashboard UI tabs (Overview, Modbus, Compare)
- Dual-write parameter API (RPC / Modbus / both)

## 1.0.1

- Fix FastAPI startup crash on favicon route

## 1.0.0

- Initial release: WebBox RPC + Modbus TCP for Sunny Island 6048
