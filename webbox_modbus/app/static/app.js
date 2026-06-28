// WebBox Dashboard — rebuilt single-page UI (vanilla, zero deps).
// Goals: cleaner structure, better state management, first-class support for
// custom commands, improved maintainability and UX.
//
// All paths are relative for Ingress or direct serving.

const API_BASE = "api";

// ----- state (single source of truth) --------------------------------------

const state = {
    webboxes: [],
    selectedId: null,
    selectedDeviceKey: null,
    status: null,
    modbusStatus: null,
    snapshot: null,
    devices: [],
    parameters: [],
    commands: [],
    modbusRegisters: [],
    modbusSummary: null,
    liveDashboard: null,
    writableCatalog: null,
    panelOptions: null,
    parameterFilter: "",
    modbusFilter: "",
    modbusKind: "sensors",
    activeTab: "dual",
    livePollTimer: null,
    healthTimer: null,
    editingId: null,
};

// Simple reactive update helper — merge partial state and re-render affected parts.
function setState(partial) {
    Object.assign(state, partial);
    // Selective re-renders (cheap enough for this scale)
    if ("webboxes" in partial || "selectedId" in partial) renderWebBoxList();
    if ("status" in partial || "selectedId" in partial || "snapshot" in partial) renderOverview();
    if ("modbusStatus" in partial || "selectedId" in partial) renderTransportStatus();
    if ("devices" in partial || "selectedDeviceKey" in partial) renderDevices();
    if ("commands" in partial) renderCommands();
    if ("parameters" in partial || "parameterFilter" in partial) renderParameters();
    if ("modbusRegisters" in partial || "modbusFilter" in partial || "modbusKind" in partial) renderModbusRegisters();
    if ("liveDashboard" in partial) renderLiveDashboard();
    if ("snapshot" in partial) renderDualOverview();
    if ("snapshot" in partial) renderCompare();
}

// ----- DOM helpers ---------------------------------------------------------

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === "class") node.className = value;
        else if (key === "dataset") Object.assign(node.dataset, value);
        else if (key.startsWith("on") && typeof value === "function") {
            node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === "html") {
            node.innerHTML = value;
        } else {
            node.setAttribute(key, value);
        }
    }
    for (const child of children.flat()) {
        if (child == null || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

function toast(message, kind = "info", timeout = 4000) {
    const el = h("div", { class: `toast ${kind}` }, message);
    $("#toasts").append(el);
    setTimeout(() => {
        el.style.transition = "opacity 200ms";
        el.style.opacity = "0";
        setTimeout(() => el.remove(), 220);
    }, timeout);
}

// ----- API -----------------------------------------------------------------

async function api(path, options = {}) {
    const resp = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    if (resp.status === 204) return null;
    let body = null;
    try { body = await resp.json(); } catch { body = null; }
    if (!resp.ok) {
        const detail = (body && body.detail) || resp.statusText;
        throw new Error(detail);
    }
    return body;
}

// ----- rendering: sidebar --------------------------------------------------

function renderWebBoxList() {
    const list = $("#webbox-list");
    list.replaceChildren();
    if (state.webboxes.length === 0) {
        list.append(h("p", { class: "muted", style: "padding: 12px; font-size: 13px;" },
            "No WebBoxes yet. Click “Add WebBox” to start."));
        return;
    }
    for (const wb of state.webboxes) {
        const status = wb._status ?? "unknown";
        list.append(h("div", {
            class: `webbox-item ${state.selectedId === wb.id ? "active" : ""}`,
            onclick: () => selectWebBox(wb.id),
        },
            h("span", { class: `status-dot ${status}` }),
            h("div", { class: "meta" },
                h("div", { class: "name" }, wb.name),
                h("div", { class: "host" }, wb.host)
            )
        ));
    }
}

// ----- rendering: view -----------------------------------------------------

function renderOverview() {
    const empty = $("#empty-state");
    const view = $("#webbox-view");
    const wb = currentWebBox();

    if (!wb) {
        empty.classList.remove("hidden");
        view.classList.add("hidden");
        return;
    }
    empty.classList.add("hidden");
    view.classList.remove("hidden");

    $("#wb-title").textContent = wb.name;
    const passwordBadges = [];
    if (wb.has_password) passwordBadges.push("user password ✓");
    if (wb.has_installer_password) passwordBadges.push("installer password ✓");
    const badgeStr = passwordBadges.length ? ` · ${passwordBadges.join(" · ")}` : "";
    $("#wb-subtitle").textContent =
        `${wb.host} · Modbus :${wb.modbus_port ?? 502} · unit ${wb.modbus_unit_id ?? 3}${badgeStr}`;

    renderTransportStatus();

    const isOptionEntry = wb.source === "options";
    const deleteBtn = $("#delete-webbox-btn");
    deleteBtn.disabled = isOptionEntry;
    deleteBtn.title = isOptionEntry
        ? "Defined in the add-on options. Remove it from Settings → Add-ons → WebBox Dashboard → Configuration."
        : "";

    const editBtn = $("#edit-webbox-btn");
    editBtn.disabled = isOptionEntry;
    editBtn.title = isOptionEntry
        ? "Defined in the add-on options. Edit it in Settings → Add-ons → WebBox Dashboard → Configuration, then restart the add-on."
        : "";

    const openBtn = $("#open-webbox-btn");
    const hasPublicUrl = Boolean(wb.public_url);
    openBtn.disabled = !hasPublicUrl;
    openBtn.title = hasPublicUrl
        ? "Open the WebBox's native web UI via its Cloudflare Tunnel"
        : "Set a Public URL (Cloudflare Tunnel hostname) on this WebBox to enable this.";

    const cards = $("#overview-cards");
    cards.replaceChildren();

    if (!state.status) {
        cards.append(h("div", { class: "card" },
            h("div", { class: "label" }, "Status"),
            h("div", { class: "value muted" }, "Loading…")));
        return;
    }
    if (!state.status.online) {
        cards.append(h("div", { class: "card" },
            h("div", { class: "label" }, "Status"),
            h("div", { class: "value", style: "color: var(--danger)" }, "Offline"),
            h("div", { class: "muted", style: "font-size: 12px; margin-top: 4px;" }, state.status.error || "Unreachable")));
        return;
    }

    const overview = state.status.overview || {};
    const entries = Object.entries(overview);
    if (entries.length === 0) {
        cards.append(h("div", { class: "card" },
            h("div", { class: "label" }, "Status"),
            h("div", { class: "value", style: "color: var(--success)" }, "Online")));
        return;
    }
    for (const [key, info] of entries) {
        cards.append(h("div", { class: "card" },
            h("div", { class: "label" }, formatLabel(key)),
            h("div", { class: "value" },
                formatValue(info?.value),
                info?.unit ? h("span", { class: "unit" }, info.unit) : null
            )
        ));
    }
}

function renderTransportStatus() {
    const el = $("#transport-status");
    if (!el) return;
    el.replaceChildren();
    const wb = currentWebBox();
    if (!wb) return;

    const rpcOnline = state.status?.online;
    const modEnabled = wb.modbus_enabled !== false;
    const modOnline = modEnabled && state.modbusStatus?.online;

    el.append(
        h("span", { class: `transport-badge rpc ${rpcOnline ? "online" : "offline"}` }, `RPC ${rpcOnline ? "online" : "offline"}`),
        modEnabled
            ? h("span", { class: `transport-badge modbus ${modOnline ? "online" : "offline"}` },
                `Modbus :${wb.modbus_port ?? 502} ${modOnline ? "online" : "offline"}`)
            : h("span", { class: "transport-badge modbus disabled" }, "Modbus disabled"),
    );
    if (modEnabled && state.modbusStatus?.error && !modOnline) {
        el.append(h("span", { class: "transport-error muted" }, state.modbusStatus.error));
    }
}

function renderDualOverview() {
    const grid = $("#dual-cards");
    if (!grid) return;
    grid.replaceChildren();
    const snap = state.snapshot;
    if (!snap) {
        grid.append(h("p", { class: "muted" }, "Select a device to compare RPC vs Modbus metrics."));
        return;
    }
    const rows = (snap.comparison || []).filter((r) => r.rpc_value != null || r.modbus_value != null);
    if (!rows.length) {
        grid.append(h("p", { class: "muted" }, "No comparison data yet."));
        return;
    }
    for (const row of rows) {
        grid.append(h("div", { class: "data-row dual-row" },
            h("div", { class: "name" }, row.label),
            h("div", { class: "dual-values" },
                h("span", { class: "tag rpc" }, `RPC ${formatValue(row.rpc_value)}${row.unit ? " " + row.unit : ""}`),
                h("span", { class: `tag modbus ${row.match ? "match" : "mismatch"}` },
                    `Modbus ${formatValue(row.modbus_value)}${row.unit ? " " + row.unit : ""}`),
            )
        ));
    }
}

function filteredModbusRegisters() {
    const q = state.modbusFilter.trim().toLowerCase();
    let rows = state.modbusRegisters || [];
    if (state.modbusKind === "sensors") rows = rows.filter((r) => !r.write);
    else if (state.modbusKind === "settings") rows = rows.filter((r) => r.write);
    if (!q) return rows;
    return rows.filter((r) =>
        (r.name || "").toLowerCase().includes(q) ||
        String(r.address).includes(q) ||
        (r.unit || "").toLowerCase().includes(q) ||
        (r.category || "").toLowerCase().includes(q));
}

function renderModbusRegisters() {
    const table = $("#modbus-table");
    if (!table) return;
    table.replaceChildren();

    const wb = currentWebBox();
    const rows = filteredModbusRegisters();
    const summary = state.modbusSummary || {};
    const populated = rows.filter((r) => r.value != null).length;
    const info = $("#modbus-info");
    if (info) {
        const kindLabel = state.modbusKind === "all" ? "registers" : state.modbusKind;
        info.textContent = `${rows.length} ${kindLabel} · ${populated} with live values · profile ${summary.total ?? "—"} total`;
    }

    const subtitle = $("#modbus-panel-subtitle");
    if (subtitle && wb) {
        subtitle.textContent = `Reading ${wb.host}:${wb.modbus_port ?? 502} unit ${wb.modbus_unit_id ?? 3} · SI6048MBP (${summary.sensors ?? 86} sensors, ${summary.settings ?? 55} settings)`;
    }

    if (!wb) {
        table.append(h("p", { class: "muted", style: "padding:12px" }, "Select a WebBox to load Modbus sensors."));
        return;
    }
    if (wb.modbus_enabled === false) {
        table.append(h("p", { class: "muted", style: "padding:12px" }, "Modbus is disabled for this WebBox. Edit the WebBox to enable port 502."));
        return;
    }
    if (state.modbusStatus && !state.modbusStatus.online) {
        table.append(h("p", { class: "muted", style: "padding:12px" },
            `Cannot connect to Modbus on port ${wb.modbus_port ?? 502}: ${state.modbusStatus.error || "offline"}`));
    }
    if (!rows.length) {
        table.append(h("p", { class: "muted", style: "padding:12px" }, "No registers match your filter."));
        return;
    }

    table.append(h("div", { class: "modbus-row modbus-header" },
        h("span", {}, "Addr"), h("span", {}, "Name"), h("span", {}, "Value"), h("span", {}, "Unit"), h("span", {}, "R/W"), h("span", {}, "")));

    let lastCategory = null;
    for (const reg of rows) {
        const category = reg.category || "Other";
        if (category !== lastCategory) {
            table.append(h("div", { class: "modbus-group-title" }, category));
            lastCategory = category;
        }
        const isWrite = reg.write;
        let valueEl = h("span", { class: `modbus-readonly ${reg.value != null ? "has-value" : "no-value"}` },
            reg.value != null ? `${formatValue(reg.value)}` : "—");
        if (isWrite) {
            valueEl = h("span", { class: "modbus-readonly muted", title: "Use Guarded setpoint write or RPC Parameters" }, "W (via Guarded/RPC)");
        }
        table.append(h("div", { class: "modbus-row" },
            h("span", { class: "mono" }, String(reg.address)),
            h("span", { class: "mono name" }, reg.name),
            h("span", {}, valueEl),
            h("span", {}, reg.unit || "—"),
            h("span", {}, isWrite ? "W" : "R"),
            h("span", {}, null),
        ));
    }
}

function renderCompare() {
    const table = $("#compare-table");
    if (!table) return;
    table.replaceChildren();
    const rows = state.snapshot?.comparison || [];
    if (!rows.length) {
        table.append(h("p", { class: "muted" }, "Select a device to compare RPC vs Modbus."));
        return;
    }
    table.append(h("div", { class: "compare-row compare-header" },
        h("span", {}, "Metric"), h("span", {}, "RPC"), h("span", {}, "Modbus"), h("span", {}, "Match")));
    for (const row of rows) {
        table.append(h("div", { class: "compare-row" },
            h("span", {}, row.label),
            h("span", { class: "mono" }, `${formatValue(row.rpc_value)} ${row.unit || ""}`.trim()),
            h("span", { class: "mono" }, `${formatValue(row.modbus_value)} ${row.unit || ""}`.trim()),
            h("span", { class: row.match ? "match-yes" : "match-no" }, row.match ? "✓" : "≠"),
        ));
    }
}

async function probeModbusStatus(id) {
    if (state.selectedId === id && currentWebBox()?.modbus_enabled !== false) {
        await loadModbusBundle();
        return;
    }
    const wb = state.webboxes.find((w) => w.id === id);
    if (!wb || wb.modbus_enabled === false) {
        if (state.selectedId === id) setState({ modbusStatus: { online: false, error: "Modbus disabled" } });
    }
}

async function loadModbusBundle(options = {}) {
    const includeProfile = options.includeProfile !== false;
    const wb = currentWebBox();
    if (!wb || wb.modbus_enabled === false) {
        setState({ modbusRegisters: [], modbusSummary: null, liveDashboard: null, modbusStatus: null });
        return;
    }
    try {
        const kind = state.modbusKind || "sensors";
        const data = await api(
            `/webboxes/${wb.id}/modbus/bundle?kind=${encodeURIComponent(kind)}&profile=${includeProfile}`,
        );
        setState({
            modbusRegisters: data.registers || [],
            modbusSummary: data.summary || null,
            liveDashboard: data.live || null,
            modbusStatus: {
                online: data.online,
                error: data.error,
                port: data.port,
                unit_id: data.unit_id,
            },
        });
    } catch (err) {
        setState({ modbusRegisters: [], liveDashboard: { online: false, error: err.message, values: {} } });
        toast(`Modbus read failed: ${err.message}`, "error");
    }
}

async function loadModbusRegisters() {
    return loadModbusBundle();
}

async function loadLiveDashboard() {
    return loadModbusBundle();
}

async function loadSnapshot() {
    const wb = currentWebBox();
    if (!wb || !state.selectedDeviceKey) {
        setState({ snapshot: null });
        return;
    }
    try {
        const snap = await api(`/webboxes/${wb.id}/snapshot?device_key=${encodeURIComponent(state.selectedDeviceKey)}`);
        setState({ snapshot: snap });
    } catch (err) {
        setState({ snapshot: null });
    }
}

function syncModbusUnitFields() {
    const wb = currentWebBox();
    if (!wb) return;
    const unit = wb.modbus_unit_id ?? 3;
    const eu = $("#explorer-unit");
    const ru = $("#raw-unit");
    if (eu && !eu.dataset.userEdited) eu.value = String(unit);
    if (ru && !ru.dataset.userEdited) ru.value = String(unit);
}

function renderLiveDashboard() {
    const grid = $("#live-dashboard");
    if (!grid) return;
    grid.replaceChildren();
    const data = state.liveDashboard;
    if (!data) {
        grid.append(h("p", { class: "muted" }, "Loading live Modbus dashboard…"));
        return;
    }
    if (!data.online) {
        grid.append(h("p", { class: "muted" }, data.error || "Modbus offline"));
        return;
    }
    const values = data.values || {};
    const keys = Object.keys(values).filter((k) => !k.startsWith("_"));
    if (!keys.length) {
        grid.append(h("p", { class: "muted" }, "No live values returned."));
        return;
    }
    for (const key of keys) {
        const row = values[key];
        grid.append(h("div", { class: "live-dash-card" },
            h("div", { class: "label" }, row.label || key),
            h("div", { class: "value" }, `${formatValue(row.value)} ${row.unit || ""}`.trim()),
            h("div", { class: "addr" }, String(row.address)),
        ));
    }
}

async function loadWritableCatalog() {
    try {
        const data = await api("/catalog/modbus/writable");
        setState({ writableCatalog: data.setpoints || {}, panelOptions: data.options || {} });
        const sel = $("#guarded-param");
        if (!sel) return;
        sel.replaceChildren();
        for (const [key, meta] of Object.entries(state.writableCatalog || {})) {
            sel.append(h("option", { value: key }, `${key} (${meta.min}–${meta.max} ${meta.unit})`));
        }
    } catch {
        setState({ writableCatalog: {}, panelOptions: {} });
    }
}

async function doExplorerRead() {
    const wb = currentWebBox();
    if (!wb) return;
    const out = $("#explorer-output");
    out.textContent = "reading…";
    const q = new URLSearchParams({
        address: $("#explorer-address").value,
        dtype: $("#explorer-dtype").value,
        fix: $("#explorer-fix").value,
        unit_id: $("#explorer-unit").value,
    });
    try {
        const data = await api(`/webboxes/${wb.id}/modbus/read?${q}`);
        out.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
        out.textContent = err.message;
    }
}

async function guardedWrite(confirm) {
    const wb = currentWebBox();
    if (!wb) return;
    const out = $("#guarded-output");
    out.textContent = "working…";
    const body = {
        param: $("#guarded-param").value,
        value: parseFloat($("#guarded-value").value),
        confirm,
        unit_id: Number($("#explorer-unit").value),
    };
    try {
        const data = await api(`/webboxes/${wb.id}/modbus/write`, {
            method: "POST",
            body: JSON.stringify(body),
        });
        out.textContent = JSON.stringify(data, null, 2);
        if (confirm) {
            toast(data.verified ? "Write verified" : "Write sent (verify mismatch)", data.verified ? "success" : "warning");
            loadModbusBundle();
        }
    } catch (err) {
        out.textContent = err.message;
    }
}

async function doRawWrite() {
    const wb = currentWebBox();
    if (!wb) return;
    if (!confirm("RAW write to a live battery inverter. Are you sure?")) return;
    const out = $("#raw-output");
    out.textContent = "working…";
    const words = $("#raw-words").value.split(",").map((s) => {
        const t = s.trim();
        return parseInt(t, /[a-f]/i.test(t) ? 16 : 10);
    });
    try {
        const data = await api(`/webboxes/${wb.id}/modbus/write_raw`, {
            method: "POST",
            body: JSON.stringify({
                address: parseInt($("#raw-address").value, 10),
                words,
                unit_id: Number($("#raw-unit").value),
                ack: $("#raw-ack").value,
                confirm: true,
            }),
        });
        out.textContent = JSON.stringify(data, null, 2);
        loadModbusBundle();
    } catch (err) {
        out.textContent = err.message;
    }
}

function renderDevices() {
    const list = $("#device-list");
    list.replaceChildren();
    const devices = state.devices || [];
    $("#device-count").textContent = String(devices.length);

    if (devices.length === 0) {
        list.append(h("p", { class: "muted" }, "No devices reported."));
        return;
    }
    for (const dev of devices) {
        list.append(h("div", {
            class: `device ${state.selectedDeviceKey === dev.key ? "active" : ""}`,
            onclick: () => selectDevice(dev.key),
        },
            h("div", { class: "name" }, dev.name || dev.key || "Unknown"),
            h("div", { class: "key" }, dev.key || "")
        ));
    }
}

function renderDeviceDetail() {
    const detail = $("#device-detail");
    const dev = state.devices.find((d) => d.key === state.selectedDeviceKey);
    if (!dev) {
        detail.classList.add("hidden");
        return;
    }
    detail.classList.remove("hidden");
    $("#device-title").textContent = `${dev.name || dev.key} — ${dev.key}`;

    // Quick command buttons in header for the "app" feel
    renderQuickCommands();
}

function renderQuickCommands() {
    const container = $("#quick-commands");
    if (!container) return;
    container.replaceChildren();

    const wb = currentWebBox();
    if (!state.selectedDeviceKey || !wb || !wb.has_installer_password) return;

    const all = state.commands || [];
    const byName = (n) => all.find((c) => c.name === n);

    // Prominent Start / Stop buttons for the inverter (Operation.Mode)
    // These are the main "start stop button" controls the user requested.
    const startCmd = byName("start") || { name: "start", label: "Start", group: "Inverter" };
    const stopCmd = byName("stop") || { name: "stop", label: "Stop", group: "Inverter" };

    // Special prominent Start/Stop buttons (larger, colored)
    const startBtn = makeCommandButton(startCmd, true);
    startBtn.classList.add("btn-start");
    startBtn.style.fontWeight = "600";
    startBtn.style.minWidth = "70px";

    const stopBtn = makeCommandButton(stopCmd, true);
    stopBtn.classList.add("btn-stop");
    stopBtn.style.fontWeight = "600";
    stopBtn.style.minWidth = "70px";

    container.append(startBtn, stopBtn);

    // Grid Start/Stop as secondary quick actions (using GdManStr or GdOnOff as appropriate)
    const startGrid = byName("start_grid") || byName("on_grid");
    const stopGrid = byName("stop_grid") || byName("off_grid");

    if (startGrid) {
        const btn = makeCommandButton(startGrid, true);
        btn.style.fontSize = "12px";
        container.append(btn);
    }
    if (stopGrid) {
        const btn = makeCommandButton(stopGrid, true);
        btn.style.fontSize = "12px";
        container.append(btn);
    }

    // Add a few more useful custom/built-in commands (generator, self-consumption, etc.)
    const forcedNames = new Set(["start", "stop", startGrid?.name, stopGrid?.name].filter(Boolean));
    let extraCount = 0;
    for (const c of all) {
        if (forcedNames.has(c.name)) continue;
        if (extraCount >= 2) break;
        const btn = makeCommandButton(c, true);
        btn.style.fontSize = "12px";
        container.append(btn);
        extraCount++;
    }
}

function renderLiveData(rows) {
    const grid = $("#live-data");
    grid.replaceChildren();
    if (!rows || rows.length === 0) {
        grid.append(h("p", { class: "muted" }, "No live data channels."));
        return;
    }
    for (const row of rows) {
        grid.append(h("div", { class: "data-row" },
            h("div", { class: "name" }, formatLabel(row.name)),
            h("div", { class: "value" },
                formatValue(row.value),
                row.unit ? h("span", { class: "unit" }, row.unit) : null
            )
        ));
    }
}

function renderParameters() {
    const container = $("#parameter-groups");
    container.replaceChildren();
    const params = filteredParameters();
    $("#param-info").textContent = `${params.length} parameter${params.length === 1 ? "" : "s"}`;

    if (params.length === 0) {
        container.append(h("p", { class: "muted" }, "No parameters match your filter."));
        return;
    }

    const groups = new Map();
    for (const p of params) {
        const g = p.group || "Other";
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(p);
    }

    const order = ["Battery", "Charging", "Discharging", "Inverter", "Grid", "Energy management", "Backup", "Generator", "Other"];
    const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
        const ia = order.indexOf(a); const ib = order.indexOf(b);
        if (ia === -1 && ib === -1) return a.localeCompare(b);
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
    });

    for (const [group, rows] of sortedGroups) {
        const groupEl = h("div", { class: "parameter-group" }, h("h4", {}, group));
        for (const param of rows) {
            groupEl.append(parameterRow(param));
        }
        container.append(groupEl);
    }
}

function parameterRow(param) {
    const writable = param.writable !== false;
    const original = param.value;
    const wb = currentWebBox();
    const canWrite = writable && wb && wb.has_installer_password;

    const control = buildControl(param);
    control.disabled = !canWrite;

    const saveBtn = h("button", {
        class: "btn btn-primary save-btn",
        onclick: () => saveParameter(param, control, row),
    }, "Save");

    const row = h("div", { class: "parameter-row" },
        h("div", { class: "meta" },
            h("div", { class: "label-row" },
                h("span", { class: "label" }, param.label || param.name),
                h("span", { class: "key" }, param.key || param.name),
                h("span", { class: "badges" },
                    param.unit ? h("span", { class: "badge-pill" }, param.unit) : null,
                    !writable ? h("span", { class: "badge-pill" }, "read-only") : null,
                    canWrite ? null : (writable ? h("span", { class: "badge-pill", title: "Installer password required" }, "locked") : null)
                )
            ),
            param.description ? h("div", { class: "description" }, param.description) : null
        ),
        h("div", { class: "control" }, control, saveBtn)
    );

    control.addEventListener("input", () => {
        const dirty = String(getControlValue(control)) !== String(original ?? "");
        row.classList.toggle("dirty", dirty);
    });

    return row;
}

function buildControl(param) {
    if (param.type === "enum" && Array.isArray(param.options) && param.options.length) {
        const select = h("select", {});
        for (const opt of param.options) {
            const optEl = h("option", { value: String(opt.value) }, opt.label);
            if (String(opt.value) === String(param.value)) optEl.selected = true;
            select.append(optEl);
        }
        return select;
    }
    if (param.type === "bool") {
        const select = h("select", {});
        for (const opt of [["true", "On"], ["false", "Off"]]) {
            const optEl = h("option", { value: opt[0] }, opt[1]);
            if (String(opt[0]) === String(param.value)) optEl.selected = true;
            select.append(optEl);
        }
        return select;
    }
    if (param.type === "number" || param.type === "duration") {
        return h("input", {
            type: "number",
            value: param.value ?? "",
            min: param.min ?? "",
            max: param.max ?? "",
            step: param.step ?? "any",
        });
    }
    return h("input", { type: "text", value: param.value ?? "" });
}

function getControlValue(control) {
    if (control.type === "number") return control.value === "" ? null : Number(control.value);
    return control.value;
}

// ----- commands ------------------------------------------------------------

async function executeCommand(cmdName, triggerBtn = null) {
    const wb = currentWebBox();
    if (!wb || !state.selectedDeviceKey) return;

    const btn = triggerBtn || (typeof event !== "undefined" ? event.currentTarget : null);
    if (btn) btn.disabled = true;

    try {
        await api(`/webboxes/${wb.id}/devices/${encodeURIComponent(state.selectedDeviceKey)}/command`, {
            method: "POST",
            body: JSON.stringify({ command: cmdName }),
        });
        toast(`Command "${cmdName}" executed`, "success");

        // Refresh so the UI reflects any state changes immediately
        await Promise.all([loadDeviceData(), loadParameters()]);
    } catch (err) {
        toast(`Command failed: ${err.message}`, "error");
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * Build a nice command button element.
 * Used for both the Commands tab grid and the quick header actions.
 */
function makeCommandButton(cmd, compact = false) {
    const wb = currentWebBox();
    const can = !!(wb && wb.has_installer_password);
    const label = cmd.label || cmd.name;

    const btn = h("button", {
        class: compact ? "btn btn-ghost cmd-quick" : "btn btn-command",
        disabled: !can,
        title: cmd.description || label,
        onclick: (e) => executeCommand(cmd.name, e.currentTarget),
    });

    // Lightweight icon (emoji fallback — no external assets)
    const iconMap = {
        Inverter: "⚡", Grid: "🔌", Energy: "☀️", Generator: "🔋", Battery: "🔋", Custom: "★"
    };
    const icon = iconMap[cmd.group] || (compact ? "" : "▶");
    btn.innerHTML = icon ? `<span class="cmd-icon">${icon}</span> ${label}` : label;

    return btn;
}

function renderCommands() {
    const container = $("#command-grid");
    if (!container) return;
    container.replaceChildren();

    const cmds = state.commands || [];
    const infoEl = $("#command-info");
    if (infoEl) infoEl.textContent = `${cmds.length} command${cmds.length === 1 ? "" : "s"} (customs included)`;

    if (cmds.length === 0) {
        container.append(h("p", { class: "muted" }, "No commands defined."));
        return;
    }

    const wb = currentWebBox();
    const canExecute = !!(wb && wb.has_installer_password);

    // Group like the parameter editor
    const groups = new Map();
    for (const cmd of cmds) {
        const g = cmd.group || "Other";
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(cmd);
    }

    const order = ["Inverter", "Grid", "Energy", "Generator", "Battery", "Custom", "Other"];
    const sorted = [...groups.entries()].sort(([a], [b]) => {
        const ia = order.indexOf(a); const ib = order.indexOf(b);
        if (ia === -1 && ib === -1) return a.localeCompare(b);
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
    });

    for (const [group, groupCmds] of sorted) {
        const groupEl = h("div", { class: "command-group" },
            h("h5", { class: "command-group-title" }, group)
        );

        const grid = h("div", { class: "command-btn-grid" });

        for (const cmd of groupCmds) {
            grid.append(makeCommandButton(cmd, false));
        }

        groupEl.append(grid);
        container.append(groupEl);
    }

    if (!canExecute) {
        container.append(h("p", { class: "muted small-note" },
            "Installer password required to execute commands on this WebBox."));
    }
}

// ----- actions -------------------------------------------------------------

async function loadWebBoxes() {
    try {
        const items = await api("/webboxes");
        state.webboxes = items;
        renderWebBoxList();
        // Probe statuses in background.
        items.forEach((wb) => probeStatus(wb.id));
    } catch (err) {
        toast(`Failed to load WebBoxes: ${err.message}`, "error");
    }
}

async function probeStatus(id) {
    try {
        const result = await api(`/webboxes/${id}/status`);
        const wb = state.webboxes.find((w) => w.id === id);
        if (!wb) return;
        wb._status = result.online ? "online" : "offline";
        renderWebBoxList();
        if (state.selectedId === id) {
            state.status = result;
            state.devices = result.devices || [];
            renderOverview();
            renderDevices();
        }
    } catch (err) {
        const wb = state.webboxes.find((w) => w.id === id);
        if (wb) {
            wb._status = "offline";
            renderWebBoxList();
        }
    }
}

function currentWebBox() {
    return state.webboxes.find((w) => w.id === state.selectedId) || null;
}

function selectWebBox(id) {
    setState({
        selectedId: id,
        selectedDeviceKey: null,
        status: null,
        modbusStatus: null,
        snapshot: null,
        modbusRegisters: [],
        modbusSummary: null,
        devices: [],
        parameters: [],
        commands: [],
    });
    $("#device-detail").classList.add("hidden");
    syncModbusUnitFields();
    probeStatus(id);
    loadModbusBundle({ includeProfile: false }).then(() => loadModbusBundle());
    loadWritableCatalog();
    schedulePolling();
}

async function selectDevice(deviceKey) {
    setState({ selectedDeviceKey: deviceKey });
    renderDevices();
    renderDeviceDetail();
    activateTab("live");
    await Promise.all([loadDeviceData(), loadParameters(), loadCommands(), loadSnapshot()]);
}

async function loadDeviceData() {
    const wb = currentWebBox();
    if (!wb || !state.selectedDeviceKey) return;
    try {
        const rows = await api(`/webboxes/${wb.id}/devices/${encodeURIComponent(state.selectedDeviceKey)}/data`);
        renderLiveData(rows);
    } catch (err) {
        $("#live-data").replaceChildren(h("p", { class: "muted" }, `Couldn’t read live data: ${err.message}`));
    }
}

async function loadParameters() {
    const wb = currentWebBox();
    if (!wb || !state.selectedDeviceKey) return;
    if (!wb.has_installer_password && !wb.has_password) {
        setState({ parameters: [] });
        $("#param-info").textContent = "Add an installer password on this WebBox to load parameters.";
        return;
    }
    try {
        const rows = await api(`/webboxes/${wb.id}/devices/${encodeURIComponent(state.selectedDeviceKey)}/parameters`);
        setState({ parameters: rows || [] });
    } catch (err) {
        setState({ parameters: [] });
        $("#param-info").textContent = `Couldn’t read parameters: ${err.message}`;
    }
}

async function loadCommands() {
    const wb = currentWebBox();
    if (!wb || !state.selectedDeviceKey) {
        setState({ commands: [] });
        return;
    }
    // Global catalog (now includes any custom_commands from add-on options)
    try {
        const rows = await api(`/commands`);
        setState({ commands: rows || [] });
    } catch (err) {
        setState({ commands: [] });
        const container = $("#command-grid");
        if (container) container.replaceChildren(h("p", { class: "muted" }, `Couldn’t load commands: ${err.message}`));
    }
}

async function saveParameter(param, control, row) {
    const wb = currentWebBox();
    if (!wb) return;
    const value = getControlValue(control);
    const button = $(".save-btn", row);
    button.disabled = true;
    try {
        await api(`/webboxes/${wb.id}/devices/${encodeURIComponent(state.selectedDeviceKey)}/parameters`, {
            method: "PUT",
            body: JSON.stringify({ channel: param.key || param.name, value }),
        });
        toast(`Updated ${param.label || param.name}`, "success");
        row.classList.remove("dirty");

        // Re-fetch authoritative values from the device.
        // This ensures the UI shows the actual (possibly normalized) current value
        // instead of the optimistic one the user typed. Fixes "parameters not changing"
        // perception when the device rejects, rounds, or delays the update.
        await loadParameters();
    } catch (err) {
        toast(`Failed to update: ${err.message}`, "error");
    } finally {
        button.disabled = false;
    }
}

function filteredParameters() {
    const q = state.parameterFilter.trim().toLowerCase();
    if (!q) return state.parameters;
    return state.parameters.filter((p) =>
        (p.label || "").toLowerCase().includes(q) ||
        (p.key || p.name || "").toLowerCase().includes(q) ||
        (p.group || "").toLowerCase().includes(q));
}

function schedulePolling() {
    if (state.livePollTimer) clearInterval(state.livePollTimer);
    if (!state.selectedId) return;
    const wb = currentWebBox();
    const intervalMs = Math.max(30000, (wb?.poll_interval || 30) * 1000);
    state.livePollTimer = setInterval(() => {
        probeStatus(state.selectedId);
        loadModbusBundle({ includeProfile: false });
        if (state.selectedDeviceKey) {
            loadDeviceData();
            if (state.activeTab === "dual" || state.activeTab === "compare") loadSnapshot();
        }
    }, intervalMs);
}

function activateTab(name) {
    state.activeTab = name;
    for (const tab of $$(".tab")) {
        tab.classList.toggle("active", tab.dataset.tab === name);
    }
    const dual = $("#tab-dual");
    if (dual) dual.classList.toggle("hidden", name !== "dual");
    $("#tab-live").classList.toggle("hidden", name !== "live");
    $("#tab-parameters").classList.toggle("hidden", name !== "parameters");
    const comparePane = $("#tab-compare");
    if (comparePane) comparePane.classList.toggle("hidden", name !== "compare");
    const cmdPane = $("#tab-commands");
    if (cmdPane) {
        cmdPane.classList.toggle("hidden", name !== "commands");
        if (name === "commands" && state.commands.length === 0 && state.selectedDeviceKey) {
            loadCommands();
        }
    }
    if ((name === "dual" || name === "compare") && state.selectedDeviceKey) {
        loadSnapshot();
    }
    if (name === "live" || name === "parameters") {
        renderQuickCommands();
    }
}



// ----- formatting ----------------------------------------------------------

function formatLabel(raw) {
    if (!raw) return "";
    return String(raw)
        .replace(/[._-]+/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^./, (c) => c.toUpperCase());
}

function formatValue(value) {
    if (value == null) return "—";
    if (typeof value === "number") {
        if (Number.isInteger(value)) return value.toLocaleString();
        return Number(value.toFixed(3)).toLocaleString();
    }
    if (typeof value === "boolean") return value ? "On" : "Off";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

// ----- modal plumbing ------------------------------------------------------

function openModal(id, { reset = true } = {}) {
    const modal = document.getElementById(id);
    if (!modal) return;
    if (reset) {
        const form = modal.querySelector("form");
        if (form) form.reset();
    }
    modal.classList.remove("hidden");
}

function closeModal(id) {
    document.getElementById(id)?.classList.add("hidden");
}

document.addEventListener("click", (event) => {
    const t = event.target;
    if (t.matches("[data-close-modal]")) {
        closeModal(t.dataset.closeModal);
    }
    if (t.classList.contains("modal")) {
        t.classList.add("hidden");
    }
});

// Close modals on Escape (better UX)
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        const openModals = $$(".modal:not(.hidden)");
        if (openModals.length) closeModal(openModals[openModals.length - 1].id);
    }
});

// ----- event wiring (improved) ---------------------------------------------

let searchDebounce = null;

function wireEvents() {
    const search = $("#param-search");
    if (search) {
        search.addEventListener("input", (e) => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => {
                setState({ parameterFilter: e.target.value });
            }, 120);
        });
    }
    $("#add-webbox-btn").addEventListener("click", () => {
        setState({ editingId: null });
        $("#webbox-modal-title").textContent = "Add WebBox";
        const form = $("#webbox-form");
        form.reset();
        form.elements.password.placeholder = "";
        form.elements.installer_password.placeholder = "";
        openModal("webbox-modal", { reset: false });
    });

    $("#edit-webbox-btn").addEventListener("click", () => {
        const wb = currentWebBox();
        if (!wb) return;
        setState({ editingId: wb.id });
        $("#webbox-modal-title").textContent = "Edit WebBox";
        const form = $("#webbox-form");
        form.reset();
        form.elements.name.value = wb.name || "";
        form.elements.host.value = wb.host || "";
        form.elements.public_url.value = wb.public_url || "";
        form.elements.poll_interval.value = wb.poll_interval || 30;
        if (form.elements.modbus_port) form.elements.modbus_port.value = wb.modbus_port ?? 502;
        if (form.elements.modbus_unit_id) form.elements.modbus_unit_id.value = wb.modbus_unit_id ?? 3;
        if (form.elements.modbus_enabled) form.elements.modbus_enabled.checked = wb.modbus_enabled !== false;
        // Stored passwords are intentionally not sent back to the browser.
        // Surface that with a placeholder so users know blank = keep current.
        form.elements.password.placeholder =
            wb.has_password ? "(saved — leave blank to keep)" : "";
        form.elements.installer_password.placeholder =
            wb.has_installer_password ? "(saved — leave blank to keep)" : "";
        openModal("webbox-modal", { reset: false });
    });

    $("#delete-webbox-btn").addEventListener("click", async () => {
        const wb = currentWebBox();
        if (!wb) return;
        if (!confirm(`Delete WebBox "${wb.name}"?`)) return;
        try {
            await api(`/webboxes/${wb.id}`, { method: "DELETE" });
            toast("WebBox removed", "success");
            setState({ selectedId: null });
            await loadWebBoxes();
        } catch (err) {
            toast(`Couldn’t delete: ${err.message}`, "error");
        }
    });

    $("#refresh-btn").addEventListener("click", () => {
        if (!state.selectedId) return;
        probeStatus(state.selectedId);
        loadModbusBundle();
        if (state.selectedDeviceKey) {
            loadDeviceData();
            loadParameters();
            loadCommands();
            loadSnapshot();
        }
    });

    $("#open-webbox-btn").addEventListener("click", () => {
        const wb = currentWebBox();
        if (!wb || !wb.public_url) return;
        window.open(wb.public_url, "_blank", "noopener");
    });

    $("#webbox-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.target).entries());
        if (data.poll_interval) data.poll_interval = Number(data.poll_interval);
        if (event.target.elements.modbus_enabled) {
            data.modbus_enabled = event.target.elements.modbus_enabled.checked;
        }
        if (data.modbus_port) data.modbus_port = Number(data.modbus_port);
        if (data.modbus_unit_id) data.modbus_unit_id = Number(data.modbus_unit_id);
        let savedId = state.editingId;
        // Don't send blank passwords on edit — they'd wipe stored secrets.
        if (state.editingId) {
            if (!data.password) delete data.password;
            if (!data.installer_password) delete data.installer_password;
            try {
                await api(`/webboxes/${state.editingId}`, { method: "PATCH", body: JSON.stringify(data) });
                toast("WebBox updated", "success");
            } catch (err) { toast(`Update failed: ${err.message}`, "error"); return; }
        } else {
            try {
                const created = await api(`/webboxes`, { method: "POST", body: JSON.stringify(data) });
                savedId = created?.id ?? null;
                toast("WebBox added", "success");
            } catch (err) { toast(`Add failed: ${err.message}`, "error"); return; }
        }
        closeModal("webbox-modal");
        await loadWebBoxes();
        // Force the main view to re-render against the fresh data so the
        // "installer password ✓" badge appears immediately, even if the
        // WebBox isn't reachable yet.
        if (savedId) setState({ selectedId: savedId });
    });

    $("#scan-btn").addEventListener("click", () => openModal("scan-modal"));

    $("#scan-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const subnet = new FormData(event.target).get("subnet");
        const button = event.target.querySelector("button[type=submit]");
        button.disabled = true;
        button.textContent = "Scanning…";
        const results = $("#scan-results");
        results.replaceChildren();
        results.classList.remove("has-results");
        try {
            const data = await api("/scan", { method: "POST", body: JSON.stringify({ subnet }) });
            results.classList.add("has-results");
            if (!data.found.length) {
                results.append(h("p", { class: "muted", style: "padding: 6px;" }, "No WebBoxes responded."));
            } else {
                for (const ip of data.found) {
                    results.append(h("div", { class: "scan-result-row" },
                        h("span", {}, ip),
                        h("button", {
                            class: "btn btn-primary",
                            style: "padding: 4px 8px; font-size: 12px;",
                            onclick: () => {
                                const form = $("#webbox-form");
                                form.reset();
                                form.elements.host.value = ip;
                                form.elements.name.value = `WebBox @ ${ip}`;
                                setState({ editingId: null });
                                $("#webbox-modal-title").textContent = "Add WebBox";
                                closeModal("scan-modal");
                                openModal("webbox-modal", { reset: false });
                            },
                        }, "Add"),
                    ));
                }
            }
        } catch (err) {
            toast(`Scan failed: ${err.message}`, "error");
        } finally {
            button.disabled = false;
            button.textContent = "Start scan";
        }
    });

    for (const tab of $$(".tab")) {
        tab.addEventListener("click", () => activateTab(tab.dataset.tab));
    }

    const modbusSearch = $("#modbus-search");
    if (modbusSearch) {
        modbusSearch.addEventListener("input", (e) => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => {
                setState({ modbusFilter: e.target.value });
            }, 120);
        });
    }

    for (const chip of $$("[data-modbus-kind]")) {
        chip.addEventListener("click", () => {
            for (const c of $$("[data-modbus-kind]")) c.classList.toggle("active", c === chip);
            setState({ modbusKind: chip.dataset.modbusKind });
            loadModbusBundle();
        });
    }

    $("#modbus-test-btn")?.addEventListener("click", async () => {
        const wb = currentWebBox();
        if (!wb) return;
        const btn = $("#modbus-test-btn");
        btn.disabled = true;
        try {
            await loadModbusBundle();
            if (state.modbusStatus?.online) {
                toast(`Modbus OK on ${wb.host}:${wb.modbus_port ?? 502}`, "success");
            } else {
                toast(state.modbusStatus?.error || "Modbus offline", "error");
            }
        } finally {
            btn.disabled = false;
        }
    });

    $("#modbus-refresh-btn")?.addEventListener("click", () => {
        loadModbusBundle();
    });

    $("#explorer-read-btn")?.addEventListener("click", doExplorerRead);
    $("#guarded-check-btn")?.addEventListener("click", () => guardedWrite(false));
    $("#guarded-write-btn")?.addEventListener("click", () => {
        if (confirm("Write this setpoint to the live inverter?")) guardedWrite(true);
    });
    $("#raw-write-btn")?.addEventListener("click", doRawWrite);
    for (const id of ["explorer-unit", "raw-unit"]) {
        $(`#${id}`)?.addEventListener("input", (e) => { e.target.dataset.userEdited = "1"; });
    }

}

async function pollHealth() {
    try {
        const data = await api("/health");
        $("#health-indicator").className = "health-dot online";
        $("#health-label").textContent = `connected · v${data.version}`;
    } catch {
        $("#health-indicator").className = "health-dot offline";
        $("#health-label").textContent = "backend unreachable";
    }
}

async function main() {
    wireEvents();
    await pollHealth();
    if (state.healthTimer) clearInterval(state.healthTimer);
    state.healthTimer = setInterval(pollHealth, 30000);
    await loadWebBoxes();
}

main().catch((err) => {
    console.error(err);
    toast(`Initialisation failed: ${err.message}`, "error");
});
