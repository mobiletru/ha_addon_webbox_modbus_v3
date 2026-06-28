# WebBox Modbus Dashboard — Home Assistant OS Add-on

Home Assistant **Ingress panel app** for SMA Sunny WebBox **JSON-RPC** + **Modbus TCP** (Sunny Island 6048).

## Install in Home Assistant

1. **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
2. Add: `https://github.com/mobiletru/ha_addon_webbox_modbus`
3. Install **WebBox Modbus Dashboard** (v1.2.0+)
4. Configure WebBox host, passwords, Modbus port/unit ID
5. **Rebuild** then **Start**
6. Open the **WebBox Modbus** sidebar panel

## Repository structure

```
repository.yaml          ← add this URL in HA Add-on Store
webbox_modbus/           ← add-on slug folder
  config.yaml            ← HA Supervisor manifest
  Dockerfile
  build.yaml
  run.sh
  DOCS.md                ← shown in add-on Documentation tab
  app/                   ← FastAPI + dashboard UI
  profiles/SI6048MBP.xml   ← Modbus register map
```

## Example configuration

```yaml
webboxes:
  - name: SI6048
    host: 192.168.1.42
    installer_password: "your-installer-pw"
    poll_interval: 30
    modbus_port: 502
    modbus_unit_id: 3
    modbus_enabled: true
```

## Local development

```powershell
.\dev.ps1
```

Open http://127.0.0.1:8765

## License

MIT
