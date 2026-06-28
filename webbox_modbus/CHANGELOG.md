# Changelog

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
