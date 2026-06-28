# WebBox Modbus Dashboard

Home Assistant OS **Ingress panel app** for SMA Sunny WebBox data loggers with **JSON-RPC** and **Modbus TCP** on the same host.

## Install

1. **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
2. Add: `https://github.com/mobiletru/ha_addon_webbox_modbus`
3. Install **WebBox Modbus Dashboard**
4. Configure your WebBox (see below)
5. **Start** the add-on
6. Open from the sidebar **WebBox Modbus** panel or **Open Web UI**

Works behind Home Assistant Ingress — no port forwarding required.

## Configuration

| Option | Description |
|--------|-------------|
| `webboxes` | Pre-seed WebBoxes (host, passwords, Modbus settings) |
| `scan_subnet` | Default /24 for discovery scan (e.g. `192.168.1`) |
| `log_level` | `debug` for RPC/Modbus troubleshooting |
| `cloudflare_tunnel_token` | Optional Cloudflare Tunnel for remote WebBox UI |

### Example `webboxes` entry

```yaml
webboxes:
  - name: SI6048
    host: 192.168.1.42
    password: ""
    installer_password: "your-installer-pw"
    poll_interval: 30
    modbus_port: 502
    modbus_unit_id: 3
    modbus_enabled: true
    public_url: ""
```

## Features

- Multi-WebBox sidebar with online status
- Plant overview and device tree (WebBox RPC)
- Live data, parameters, commands (RPC)
- Modbus register table from `SI6048MBP.xml`
- Dual-source snapshot comparing RPC vs Modbus
- Parameter writes via RPC, Modbus, or both

## Modbus notes

- Connects to the **same WebBox IP** on port **502** (Modbus TCP gateway)
- Default unit ID **3** (inverter)
- Register map: Sunny Island 6048 (`SI6048MBP.xml`)

## Security

Passwords are stored in the add-on `/data` volume. RPC parameter writes require the installer password.

## Support

Repository: https://github.com/mobiletru/ha_addon_webbox_modbus
