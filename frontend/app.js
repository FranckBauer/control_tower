/* ===================================================================
   Control Tower - Network Administration Dashboard
   =================================================================== */
(function () {
  "use strict";

  /* ---------------------------------------------------------------
     State
     --------------------------------------------------------------- */
  let machines = [];
  let selectedMachineId = null;   // null = "All"
  let currentSection = "monitoring";
  let terminalCwd = null;
  let terminalHistory = [];
  let terminalHistoryIdx = -1;
  let currentFilePath = null;
  let fileEditorPath = null;
  let monitoringCache = {};       // machineId -> system data
  let refreshTimer = null;

  /* ---------------------------------------------------------------
     Helpers
     --------------------------------------------------------------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return "N/A";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + " " + units[i];
  }

  function formatBytesShort(bytes) {
    if (bytes == null || isNaN(bytes)) return "N/A";
    if (bytes === 0) return "0";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
  }

  function formatUptime(seconds) {
    if (!seconds || isNaN(seconds)) return "N/A";
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return d + "d " + h + "h " + m + "m";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  }

  function formatNumber(n) {
    if (n == null || isNaN(n)) return "N/A";
    return Number(n).toLocaleString();
  }

  function formatDate(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return iso;
    }
  }

  function gaugeColor(percent) {
    if (percent == null) return "#30363d";
    if (percent < 50) return "#3fb950";
    if (percent < 80) return "#d29922";
    return "#f85149";
  }

  function tempColor(temp) {
    if (temp == null) return "#30363d";
    if (temp < 50) return "#3fb950";
    if (temp < 70) return "#d29922";
    return "#f85149";
  }

  function toast(msg, type) {
    type = type || "info";
    var c = $("#toast-container");
    var el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  async function api(url, opts) {
    try {
      var resp = await fetch(url, opts);
      if (!resp.ok) {
        var errText = "";
        try { var j = await resp.json(); errText = j.detail || j.error || j.message || ""; } catch (e) { errText = resp.statusText; }
        throw new Error(errText || "Request failed (" + resp.status + ")");
      }
      return await resp.json();
    } catch (err) {
      throw err;
    }
  }

  function selectedMachine() {
    return machines.find(function (m) { return m.id === selectedMachineId; });
  }

  /* ---------------------------------------------------------------
     Path utilities (handle both Unix / and Windows \)
     --------------------------------------------------------------- */
  function pathSeparator(p) {
    if (!p) return "/";
    // If the path starts with a drive letter like C:\ it's Windows
    if (/^[A-Za-z]:\\/.test(p)) return "\\";
    return "/";
  }

  function pathJoin(base, name) {
    var sep = pathSeparator(base);
    if (base.endsWith(sep)) return base + name;
    return base + sep + name;
  }

  function pathParts(p) {
    if (!p) return [];
    var sep = pathSeparator(p);
    var parts = p.split(sep).filter(Boolean);
    // For Windows: re-add the drive letter
    if (/^[A-Za-z]:/.test(p)) {
      parts[0] = parts[0] + sep;
    }
    return parts;
  }

  function pathFromParts(parts, originalPath) {
    var sep = pathSeparator(originalPath);
    if (sep === "\\") {
      // Windows
      return parts.join(sep);
    }
    return sep + parts.join(sep);
  }

  /* ---------------------------------------------------------------
     Machine Selector Bar
     --------------------------------------------------------------- */
  function renderMachineSelector() {
    var bar = $("#machine-selector");
    bar.innerHTML = "";

    // "All" tab
    var allTab = document.createElement("div");
    allTab.className = "machine-tab" + (selectedMachineId === null ? " active" : "");
    allTab.textContent = "All";
    allTab.addEventListener("click", function () {
      selectMachine(null);
    });
    bar.appendChild(allTab);

    machines.forEach(function (m) {
      var tab = document.createElement("div");
      tab.className = "machine-tab" + (selectedMachineId === m.id ? " active" : "");
      tab.innerHTML =
        '<span class="status-dot ' + m.status + '"></span>' +
        '<span>' + m.icon + ' ' + escapeHtml(m.name) + '</span>';
      tab.addEventListener("click", function () {
        selectMachine(m.id);
      });
      bar.appendChild(tab);
    });
  }

  function selectMachine(id) {
    selectedMachineId = id;
    var m = selectedMachine();
    $("#current-machine-name").textContent = m ? m.icon + " " + m.name : "All machines";
    renderMachineSelector();
    loadSection(currentSection);
  }

  /* ---------------------------------------------------------------
     Navigation
     --------------------------------------------------------------- */
  function showSection(name) {
    currentSection = name;
    $$(".section").forEach(function (s) { s.classList.remove("active"); });
    var sec = $("#section-" + name);
    if (sec) sec.classList.add("active");

    $$(".nav-link").forEach(function (l) {
      l.classList.toggle("active", l.dataset.section === name);
    });

    loadSection(name);
  }

  function loadSection(name) {
    // Clear auto-refresh
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

    switch (name) {
      case "monitoring": loadMonitoring(); break;
      case "services": loadServices(); break;
      case "network": loadNetwork(); break;
      case "files": loadFiles(); break;
      case "terminal": initTerminal(); break;
      case "updates": initUpdates(); break;
      case "logs": loadLogs(); break;
    }
  }

  /* ---------------------------------------------------------------
     Escape HTML
     --------------------------------------------------------------- */
  function escapeHtml(str) {
    if (!str) return "";
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  /* ---------------------------------------------------------------
     MONITORING
     --------------------------------------------------------------- */
  async function loadMonitoring() {
    var content = $("#monitoring-content");
    var badge = $("#monitoring-machine-count");

    if (selectedMachineId === null) {
      // === ALL MACHINES OVERVIEW ===
      badge.textContent = machines.length + " machines";
      content.innerHTML = '<div class="loading-indicator">Loading machines...</div>';

      var html = '<div class="overview-grid">';
      // Fetch system info for all online machines in parallel
      var promises = machines.map(function (m) {
        if (m.status === "online") {
          return api("/api/m/" + m.id + "/system").then(function (data) {
            monitoringCache[m.id] = data;
            return { machine: m, data: data };
          }).catch(function () {
            return { machine: m, data: null };
          });
        }
        return Promise.resolve({ machine: m, data: null });
      });

      var results = await Promise.all(promises);

      html = '<div class="overview-grid">';
      results.forEach(function (r) {
        html += buildOverviewCard(r.machine, r.data);
      });
      html += '</div>';
      content.innerHTML = html;

      // Attach click handlers
      content.querySelectorAll(".overview-card").forEach(function (card) {
        card.addEventListener("click", function () {
          selectMachine(card.dataset.machineId);
        });
      });

      // Set gauge CSS variables
      content.querySelectorAll("[data-gauge-value]").forEach(function (el) {
        el.style.setProperty("--gauge-value", el.dataset.gaugeValue);
        el.style.setProperty("--gauge-color", el.dataset.gaugeColor);
      });

      // Auto-refresh every 15 seconds
      refreshTimer = setInterval(function () {
        if (currentSection === "monitoring" && selectedMachineId === null) {
          loadMonitoring();
        }
      }, 15000);

    } else {
      // === SINGLE MACHINE DETAIL ===
      var m = selectedMachine();
      badge.textContent = m ? m.name : "";

      if (!m || m.status === "offline") {
        content.innerHTML = '<div class="select-machine-msg">Machine is offline.</div>';
        return;
      }

      content.innerHTML = '<div class="loading-indicator">Loading system data...</div>';

      try {
        var data = await api("/api/m/" + m.id + "/system");
        monitoringCache[m.id] = data;
        content.innerHTML = buildSingleMachineView(data);

        // Set gauge CSS variables
        content.querySelectorAll("[data-gauge-value]").forEach(function (el) {
          el.style.setProperty("--gauge-value", el.dataset.gaugeValue);
          el.style.setProperty("--gauge-color", el.dataset.gaugeColor);
        });

        // Auto-refresh every 10 seconds
        refreshTimer = setInterval(async function () {
          if (currentSection === "monitoring" && selectedMachineId === m.id) {
            try {
              var fresh = await api("/api/m/" + m.id + "/system");
              monitoringCache[m.id] = fresh;
              content.innerHTML = buildSingleMachineView(fresh);
              content.querySelectorAll("[data-gauge-value]").forEach(function (el) {
                el.style.setProperty("--gauge-value", el.dataset.gaugeValue);
                el.style.setProperty("--gauge-color", el.dataset.gaugeColor);
              });
            } catch (e) { /* silent */ }
          }
        }, 10000);

      } catch (err) {
        content.innerHTML = '<div class="select-machine-msg">Failed to load system data: ' + escapeHtml(err.message) + '</div>';
      }
    }
  }

  function buildOverviewCard(machine, data) {
    var html = '<div class="overview-card" data-machine-id="' + machine.id + '">';
    html += '<div class="overview-card-header">';
    html += '<div class="overview-card-title"><span class="icon">' + machine.icon + '</span><span class="name">' + escapeHtml(machine.name) + '</span></div>';
    html += '<span class="overview-status-pill ' + machine.status + '">' + machine.status + '</span>';
    html += '</div>';

    if (machine.status === "offline" || !data) {
      html += '<div class="overview-card-offline-body">Machine unreachable</div>';
      html += '</div>';
      return html;
    }

    var cpuPct = data.cpu_percent != null ? Math.round(data.cpu_percent) : 0;
    var memPct = data.memory ? Math.round(data.memory.percent) : 0;
    var diskPct = data.disk ? Math.round(data.disk.percent) : 0;
    var temp = data.temperature;
    var tempPct = temp != null ? Math.min(100, Math.round(temp)) : 0;

    html += '<div class="overview-gauges">';
    html += buildMiniGauge(cpuPct, "%", "CPU", gaugeColor(cpuPct));
    html += buildMiniGauge(memPct, "%", "RAM", gaugeColor(memPct));
    html += buildMiniGauge(diskPct, "%", "DISK", gaugeColor(diskPct));
    if (temp != null) {
      html += buildMiniGauge(Math.round(temp), "\u00B0C", "TEMP", tempColor(temp));
    } else {
      html += buildMiniGauge("--", "", "TEMP", "#30363d");
    }
    html += '</div>';

    html += '<div class="overview-info">';
    html += '<div class="overview-info-item"><span class="label">Host:</span><span class="value">' + escapeHtml(data.hostname) + '</span></div>';
    html += '<div class="overview-info-item"><span class="label">OS:</span><span class="value">' + escapeHtml(data.platform + " " + data.platform_release) + '</span></div>';
    html += '<div class="overview-info-item"><span class="label">IP:</span><span class="value">' + escapeHtml(machine.ip) + '</span></div>';
    html += '<div class="overview-info-item"><span class="label">Uptime:</span><span class="value">' + formatUptime(data.uptime_seconds) + '</span></div>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  function buildMiniGauge(value, unit, label, color) {
    var numVal = (typeof value === "number") ? value : 0;
    var displayVal = (typeof value === "number") ? value : value;
    return '<div class="overview-gauge-item">' +
      '<div class="gauge-mini" data-gauge-value="' + numVal + '" data-gauge-color="' + color + '">' +
      '<div class="gauge-mini-inner">' +
      '<span class="gauge-mini-value">' + displayVal + '</span>' +
      '<span class="gauge-mini-unit">' + unit + '</span>' +
      '</div></div>' +
      '<span class="overview-gauge-label">' + label + '</span>' +
      '</div>';
  }

  function buildSingleMachineView(data) {
    var cpuPct = data.cpu_percent != null ? Math.round(data.cpu_percent) : 0;
    var memPct = data.memory ? Math.round(data.memory.percent) : 0;
    var diskPct = data.disk ? Math.round(data.disk.percent) : 0;
    var temp = data.temperature;
    var tempPct = temp != null ? Math.min(100, Math.round(temp)) : 0;

    var html = '<div class="metric-grid">';

    // CPU Card
    html += buildMetricCard(
      cpuPct, "%", "CPU", gaugeColor(cpuPct),
      data.cpu_count + " cores" + (data.cpu_freq ? " @ " + Math.round(data.cpu_freq) + " MHz" : "")
    );

    // RAM Card
    var memSubtitle = data.memory
      ? formatBytesShort(data.memory.used) + " / " + formatBytesShort(data.memory.total)
      : "";
    html += buildMetricCard(memPct, "%", "Memory", gaugeColor(memPct), memSubtitle);

    // Disk Card
    var diskSubtitle = data.disk
      ? formatBytesShort(data.disk.used) + " / " + formatBytesShort(data.disk.total)
      : "";
    html += buildMetricCard(diskPct, "%", "Disk", gaugeColor(diskPct), diskSubtitle);

    // Temp Card
    if (temp != null) {
      html += buildMetricCard(Math.round(temp), "\u00B0C", "Temperature", tempColor(temp), "CPU thermal zone");
    } else {
      html += buildMetricCard("--", "", "Temperature", "#30363d", "Not available");
    }

    html += '</div>';

    // System Info Panel
    html += '<div class="sysinfo-panel">';
    html += '<div class="sysinfo-title">System Information</div>';
    html += '<div class="sysinfo-grid">';

    var load = data.load_average || [0, 0, 0];
    var loadStr = load.map(function (v) { return v.toFixed(2); }).join(", ");

    var infoRows = [
      ["Hostname", data.hostname],
      ["Platform", data.platform + " " + data.platform_release],
      ["Architecture", data.architecture],
      ["Kernel", data.platform_version],
      ["CPU Cores", data.cpu_count],
      ["CPU Frequency", data.cpu_freq ? Math.round(data.cpu_freq) + " MHz" : "N/A"],
      ["Load Average", loadStr],
      ["Uptime", formatUptime(data.uptime_seconds)],
      ["Memory Total", formatBytes(data.memory ? data.memory.total : null)],
      ["Memory Available", formatBytes(data.memory ? data.memory.available : null)],
      ["Swap Used", data.swap ? formatBytes(data.swap.used) + " / " + formatBytes(data.swap.total) + " (" + Math.round(data.swap.percent) + "%)" : "N/A"],
      ["Disk Free", formatBytes(data.disk ? data.disk.free : null)],
    ];

    infoRows.forEach(function (row) {
      html += '<div class="sysinfo-row"><span class="sysinfo-key">' + row[0] + '</span><span class="sysinfo-val">' + escapeHtml(String(row[1] || "N/A")) + '</span></div>';
    });

    html += '</div></div>';
    return html;
  }

  function buildMetricCard(value, unit, label, color, subtitle) {
    var numVal = (typeof value === "number") ? value : 0;
    return '<div class="metric-card">' +
      '<div class="gauge" data-gauge-value="' + numVal + '" data-gauge-color="' + color + '">' +
      '<div class="gauge-inner">' +
      '<span class="gauge-value">' + value + '</span>' +
      '<span class="gauge-unit">' + unit + '</span>' +
      '</div></div>' +
      '<div class="metric-label">' + label + '</div>' +
      (subtitle ? '<div class="metric-subtitle">' + escapeHtml(subtitle) + '</div>' : '') +
      '</div>';
  }

  /* ---------------------------------------------------------------
     SERVICES
     --------------------------------------------------------------- */
  async function loadServices() {
    var selectMsg = $("#services-select-msg");
    var card = $("#services-card");
    var body = $("#services-body");

    if (!selectedMachineId) {
      selectMsg.style.display = "";
      card.style.display = "none";
      return;
    }

    var m = selectedMachine();
    if (!m || m.status === "offline") {
      selectMsg.textContent = "Machine is offline.";
      selectMsg.style.display = "";
      card.style.display = "none";
      return;
    }

    selectMsg.style.display = "none";
    card.style.display = "";
    body.innerHTML = '<tr><td colspan="4" class="loading-indicator">Loading services...</td></tr>';

    try {
      var services = await api("/api/m/" + m.id + "/services");
      body.innerHTML = "";

      if (!services || services.length === 0) {
        body.innerHTML = '<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--text-muted)">No services found.</td></tr>';
        return;
      }

      services.forEach(function (svc) {
        var tr = document.createElement("tr");

        // Name
        var tdName = document.createElement("td");
        tdName.innerHTML = '<span style="font-family:var(--font-mono);font-weight:500">' + escapeHtml(svc.name) + '</span>';
        tr.appendChild(tdName);

        // Status
        var tdStatus = document.createElement("td");
        var pillClass = svc.active === "active" ? "pill-green" : svc.active === "inactive" ? "pill-red" : "pill-gray";
        tdStatus.innerHTML = '<span class="pill ' + pillClass + '">' + escapeHtml(svc.active) + '</span>';
        tr.appendChild(tdStatus);

        // Enabled
        var tdEnabled = document.createElement("td");
        var enPillClass = svc.enabled === "enabled" ? "pill-blue" : svc.enabled === "disabled" ? "pill-gray" : "pill-yellow";
        tdEnabled.innerHTML = '<span class="pill ' + enPillClass + '">' + escapeHtml(svc.enabled) + '</span>';
        tr.appendChild(tdEnabled);

        // Actions
        var tdActions = document.createElement("td");
        tdActions.innerHTML =
          '<div class="btn-group">' +
          '<button class="btn btn-xs" data-action="start" data-service="' + escapeHtml(svc.name) + '">Start</button>' +
          '<button class="btn btn-xs" data-action="stop" data-service="' + escapeHtml(svc.name) + '">Stop</button>' +
          '<button class="btn btn-xs" data-action="restart" data-service="' + escapeHtml(svc.name) + '">Restart</button>' +
          '</div>';
        tr.appendChild(tdActions);

        body.appendChild(tr);
      });

      // Action handlers
      body.querySelectorAll("[data-action]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var action = btn.dataset.action;
          var service = btn.dataset.service;
          btn.disabled = true;
          btn.textContent = "...";
          try {
            var result = await api("/api/m/" + m.id + "/services/" + service + "/" + action, { method: "POST" });
            toast(result.message || (service + " " + action + "ed"), result.success ? "success" : "error");
            setTimeout(function () { loadServices(); }, 1000);
          } catch (err) {
            toast("Failed: " + err.message, "error");
          }
          btn.disabled = false;
          btn.textContent = action.charAt(0).toUpperCase() + action.slice(1);
        });
      });
    } catch (err) {
      body.innerHTML = '<tr><td colspan="4" style="padding:20px;color:var(--red)">' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  /* ---------------------------------------------------------------
     NETWORK
     --------------------------------------------------------------- */
  async function loadNetwork() {
    var selectMsg = $("#network-select-msg");
    var content = $("#network-content");
    var stats = $("#network-stats");
    var ifaces = $("#network-interfaces");
    var traffic = $("#network-traffic");

    if (!selectedMachineId) {
      selectMsg.style.display = "";
      content.style.display = "none";
      return;
    }

    var m = selectedMachine();
    if (!m || m.status === "offline") {
      selectMsg.textContent = "Machine is offline.";
      selectMsg.style.display = "";
      content.style.display = "none";
      return;
    }

    selectMsg.style.display = "none";
    content.style.display = "";
    stats.innerHTML = '<div class="stat-card"><div class="stat-card-label">Loading...</div></div>';
    ifaces.innerHTML = "";
    traffic.innerHTML = "";

    try {
      var data = await api("/api/m/" + m.id + "/network");

      // Stats cards
      stats.innerHTML =
        '<div class="stat-card"><div class="stat-card-label">Connections</div><div class="stat-card-value">' + formatNumber(data.connections) + '</div></div>' +
        '<div class="stat-card"><div class="stat-card-label">Interfaces</div><div class="stat-card-value">' + (data.interfaces ? data.interfaces.length : 0) + '</div></div>' +
        '<div class="stat-card"><div class="stat-card-label">Data Sent</div><div class="stat-card-value">' + formatBytes(data.io ? data.io.bytes_sent : 0) + '</div></div>' +
        '<div class="stat-card"><div class="stat-card-label">Data Received</div><div class="stat-card-value">' + formatBytes(data.io ? data.io.bytes_recv : 0) + '</div></div>';

      // Interfaces
      if (data.interfaces && data.interfaces.length > 0) {
        var ifHtml = '<div class="iface-grid">';
        data.interfaces.forEach(function (iface) {
          ifHtml += '<div class="iface-card">';
          ifHtml += '<div class="iface-name">' + escapeHtml(iface.name) + '</div>';
          if (iface.addresses) {
            iface.addresses.forEach(function (addr) {
              ifHtml += '<div class="iface-addr"><span class="label">IP:</span> ' + escapeHtml(addr.ip) + '</div>';
              if (addr.netmask) {
                ifHtml += '<div class="iface-addr"><span class="label">Mask:</span> ' + escapeHtml(addr.netmask) + '</div>';
              }
            });
          }
          ifHtml += '</div>';
        });
        ifHtml += '</div>';
        ifaces.innerHTML = ifHtml;
      } else {
        ifaces.innerHTML = '<div class="select-machine-msg">No network interfaces found.</div>';
      }

      // Traffic
      if (data.io) {
        traffic.innerHTML =
          '<div class="traffic-grid">' +
          '<div class="traffic-item"><div class="traffic-label">Bytes Sent</div><div class="traffic-value">' + formatBytes(data.io.bytes_sent) + '</div></div>' +
          '<div class="traffic-item"><div class="traffic-label">Bytes Received</div><div class="traffic-value">' + formatBytes(data.io.bytes_recv) + '</div></div>' +
          '<div class="traffic-item"><div class="traffic-label">Packets Sent</div><div class="traffic-value">' + formatNumber(data.io.packets_sent) + '</div></div>' +
          '<div class="traffic-item"><div class="traffic-label">Packets Received</div><div class="traffic-value">' + formatNumber(data.io.packets_recv) + '</div></div>' +
          '</div>';
      }

    } catch (err) {
      stats.innerHTML = '<div class="stat-card"><div class="stat-card-label" style="color:var(--red)">' + escapeHtml(err.message) + '</div></div>';
    }
  }

  /* ---------------------------------------------------------------
     FILES
     --------------------------------------------------------------- */
  async function loadFiles(path) {
    var selectMsg = $("#files-select-msg");
    var content = $("#files-content");
    var drivesBar = $("#drives-bar");
    var breadcrumbs = $("#breadcrumbs");
    var body = $("#files-body");

    if (!selectedMachineId) {
      selectMsg.style.display = "";
      content.style.display = "none";
      return;
    }

    var m = selectedMachine();
    if (!m || m.status === "offline") {
      selectMsg.textContent = "Machine is offline.";
      selectMsg.style.display = "";
      content.style.display = "none";
      return;
    }

    selectMsg.style.display = "none";
    content.style.display = "";

    // Load drives
    try {
      var drivesData = await api("/api/m/" + m.id + "/drives");
      if (drivesData.drives && drivesData.drives.length > 1) {
        drivesBar.innerHTML = "";
        drivesBar.style.display = "";
        drivesData.drives.forEach(function (drive) {
          var btn = document.createElement("button");
          btn.className = "drive-btn";
          var label = escapeHtml(drive.label || drive.path);
          var usage = drive.percent != null ? " (" + Math.round(drive.percent) + "%)" : "";
          btn.innerHTML = label + '<span class="drive-usage">' + usage + '</span>';
          btn.addEventListener("click", function () {
            loadFiles(drive.path);
          });
          drivesBar.appendChild(btn);
        });
      } else {
        drivesBar.style.display = "none";
      }

      // Default path
      if (!path) {
        path = currentFilePath || m.default_path || "/";
      }
    } catch (e) {
      drivesBar.style.display = "none";
      if (!path) path = currentFilePath || m.default_path || "/";
    }

    currentFilePath = path;

    // Breadcrumbs
    buildBreadcrumbs(path, breadcrumbs);

    // Load entries
    body.innerHTML = '<tr><td colspan="3" class="loading-indicator">Loading...</td></tr>';

    try {
      var data = await api("/api/m/" + m.id + "/files?path=" + encodeURIComponent(path));

      if (data.error) {
        body.innerHTML = '<tr><td colspan="3" style="padding:20px;color:var(--red)">' + escapeHtml(data.error) + '</td></tr>';
        return;
      }

      // Update actual path from server response
      if (data.path) {
        currentFilePath = data.path;
        buildBreadcrumbs(data.path, breadcrumbs);
      }

      body.innerHTML = "";

      if (!data.entries || data.entries.length === 0) {
        body.innerHTML = '<tr><td colspan="3" style="padding:20px;text-align:center;color:var(--text-muted)">Empty directory</td></tr>';
        return;
      }

      // Parent directory link
      var sep = pathSeparator(currentFilePath);
      var parentPath = currentFilePath;
      var lastSep = parentPath.lastIndexOf(sep);
      if (lastSep > 0) {
        parentPath = parentPath.substring(0, lastSep);
      } else if (sep === "/") {
        parentPath = "/";
      }

      if (parentPath !== currentFilePath) {
        var trUp = document.createElement("tr");
        trUp.innerHTML =
          '<td><span class="file-link dir" data-path="' + escapeHtml(parentPath) + '"><span class="file-icon">..</span> (parent directory)</span></td>' +
          '<td class="col-size"></td><td class="col-modified"></td>';
        body.appendChild(trUp);
      }

      data.entries.forEach(function (entry) {
        var tr = document.createElement("tr");
        var entryPath = pathJoin(currentFilePath, entry.name);

        if (entry.is_dir) {
          tr.innerHTML =
            '<td><span class="file-link dir" data-path="' + escapeHtml(entryPath) + '"><span class="file-icon">&#128193;</span>' + escapeHtml(entry.name) + '</span></td>' +
            '<td class="col-size">--</td>' +
            '<td class="col-modified">' + formatDate(entry.modified) + '</td>';
        } else {
          tr.innerHTML =
            '<td><span class="file-link" data-file="' + escapeHtml(entryPath) + '"><span class="file-icon">&#128196;</span>' + escapeHtml(entry.name) + '</span></td>' +
            '<td class="col-size">' + (entry.size != null ? formatBytes(entry.size) : "") + '</td>' +
            '<td class="col-modified">' + formatDate(entry.modified) + '</td>';
        }
        body.appendChild(tr);
      });

      // Click handlers for dirs
      body.querySelectorAll("[data-path]").forEach(function (el) {
        el.addEventListener("click", function () {
          loadFiles(el.dataset.path);
        });
      });

      // Click handlers for files
      body.querySelectorAll("[data-file]").forEach(function (el) {
        el.addEventListener("click", function () {
          openFileEditor(el.dataset.file);
        });
      });

      // Highlight active drive
      drivesBar.querySelectorAll(".drive-btn").forEach(function (btn) {
        // Simple match: active if path starts with drive path
        btn.classList.remove("active");
      });

    } catch (err) {
      body.innerHTML = '<tr><td colspan="3" style="padding:20px;color:var(--red)">' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  function buildBreadcrumbs(path, container) {
    container.innerHTML = "";
    var sep = pathSeparator(path);
    var parts = pathParts(path);

    // Root
    var rootSpan = document.createElement("span");
    rootSpan.className = "breadcrumb-link";
    rootSpan.textContent = sep === "\\" ? parts[0] || "\\" : "/";
    rootSpan.addEventListener("click", function () {
      loadFiles(sep === "\\" ? (parts[0] || "C:\\") : "/");
    });
    container.appendChild(rootSpan);

    var accumulated = sep === "\\" ? "" : "";

    for (var i = (sep === "\\" ? 1 : 0); i < parts.length; i++) {
      var sepSpan = document.createElement("span");
      sepSpan.className = "breadcrumb-sep";
      sepSpan.textContent = " " + sep + " ";
      container.appendChild(sepSpan);

      accumulated = (i === 0 && sep === "/")
        ? "/" + parts[i]
        : (sep === "\\" ? (i === 1 ? parts[0] + parts[i] : accumulated + sep + parts[i]) : accumulated + "/" + parts[i]);

      if (sep === "\\" && i === 1) {
        accumulated = parts[0] + parts[i];
      } else if (sep === "\\" && i > 1) {
        // rebuild from parts
        accumulated = parts[0];
        for (var j = 1; j <= i; j++) {
          accumulated += parts[j];
          if (j < i) accumulated += sep;
        }
      }

      if (i === parts.length - 1) {
        var cur = document.createElement("span");
        cur.className = "breadcrumb-current";
        cur.textContent = parts[i];
        container.appendChild(cur);
      } else {
        var link = document.createElement("span");
        link.className = "breadcrumb-link";
        link.textContent = parts[i];
        (function (p) {
          link.addEventListener("click", function () { loadFiles(p); });
        })(accumulated);
        container.appendChild(link);
      }
    }
  }

  async function openFileEditor(filePath) {
    var m = selectedMachine();
    if (!m) return;

    try {
      var data = await api("/api/m/" + m.id + "/files/content?path=" + encodeURIComponent(filePath));
      if (data.error) {
        toast(data.error, "error");
        return;
      }

      fileEditorPath = filePath;
      $("#editor-title").textContent = "Edit: " + filePath;
      $("#editor-content").value = data.content;
      $("#editor-modal").classList.remove("hidden");
    } catch (err) {
      toast("Failed to open file: " + err.message, "error");
    }
  }

  /* ---------------------------------------------------------------
     TERMINAL
     --------------------------------------------------------------- */
  function initTerminal() {
    var selectMsg = $("#terminal-select-msg");
    var content = $("#terminal-content");

    if (!selectedMachineId) {
      selectMsg.style.display = "";
      content.style.display = "none";
      return;
    }

    var m = selectedMachine();
    if (!m || m.status === "offline") {
      selectMsg.textContent = "Machine is offline.";
      selectMsg.style.display = "";
      content.style.display = "none";
      return;
    }

    selectMsg.style.display = "none";
    content.style.display = "";

    if (!terminalCwd) {
      terminalCwd = m.default_path || "/";
    }

    updateTerminalPrompt();
    $("#terminal-input").focus();
  }

  function updateTerminalPrompt() {
    var m = selectedMachine();
    var name = m ? m.name : "machine";
    var cwd = terminalCwd || "~";
    // Shorten cwd for display
    var displayCwd = cwd;
    if (displayCwd.length > 30) {
      displayCwd = "..." + displayCwd.slice(-27);
    }
    $("#terminal-prompt").textContent = name + ":" + displayCwd + " $";
  }

  async function executeCommand(command) {
    var m = selectedMachine();
    if (!m) return;

    var output = $("#terminal-output");

    // Show command in output
    var promptText = $("#terminal-prompt").textContent;
    output.innerHTML += '<span class="term-prompt-line">' + escapeHtml(promptText) + '</span> <span class="term-cmd">' + escapeHtml(command) + '</span>\n';

    try {
      var result = await api("/api/m/" + m.id + "/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: command, cwd: terminalCwd }),
      });

      if (result.stdout) {
        output.innerHTML += '<span class="term-stdout">' + escapeHtml(result.stdout) + '</span>';
        if (!result.stdout.endsWith("\n")) output.innerHTML += '\n';
      }
      if (result.stderr) {
        output.innerHTML += '<span class="term-stderr">' + escapeHtml(result.stderr) + '</span>';
        if (!result.stderr.endsWith("\n")) output.innerHTML += '\n';
      }

      // Update cwd if returned
      if (result.cwd !== undefined && result.cwd !== null) {
        terminalCwd = result.cwd;
        updateTerminalPrompt();
      }

    } catch (err) {
      output.innerHTML += '<span class="term-stderr">Error: ' + escapeHtml(err.message) + '</span>\n';
    }

    output.scrollTop = output.scrollHeight;
  }

  /* ---------------------------------------------------------------
     UPDATES
     --------------------------------------------------------------- */
  function initUpdates() {
    var selectMsg = $("#updates-select-msg");
    var content = $("#updates-content");

    if (!selectedMachineId) {
      selectMsg.style.display = "";
      content.style.display = "none";
      return;
    }

    var m = selectedMachine();
    if (!m || m.status === "offline") {
      selectMsg.textContent = "Machine is offline.";
      selectMsg.style.display = "";
      content.style.display = "none";
      return;
    }

    selectMsg.style.display = "none";
    content.style.display = "";
  }

  async function checkUpdates() {
    var m = selectedMachine();
    if (!m) return;

    var output = $("#updates-output");
    var spinner = $("#updates-spinner");
    var btnCheck = $("#btn-check-updates");
    var btnInstall = $("#btn-install-updates");

    btnCheck.disabled = true;
    btnInstall.disabled = true;
    spinner.classList.remove("hidden");
    output.textContent = "Checking for updates...";

    try {
      var result = await api("/api/m/" + m.id + "/update/check", { method: "POST" });
      output.textContent = result.output || "Check completed.";
      toast(result.success ? "Update check completed" : "Update check had issues", result.success ? "success" : "error");
    } catch (err) {
      output.textContent = "Error: " + err.message;
      toast("Update check failed", "error");
    }

    btnCheck.disabled = false;
    btnInstall.disabled = false;
    spinner.classList.add("hidden");
  }

  async function installUpdates() {
    var m = selectedMachine();
    if (!m) return;

    if (!confirm("Install all available updates on " + m.name + "? This may take several minutes.")) return;

    var output = $("#updates-output");
    var spinner = $("#updates-spinner");
    var btnCheck = $("#btn-check-updates");
    var btnInstall = $("#btn-install-updates");

    btnCheck.disabled = true;
    btnInstall.disabled = true;
    spinner.classList.remove("hidden");
    output.textContent = "Installing updates... This may take a while.";

    try {
      var result = await api("/api/m/" + m.id + "/update/upgrade", { method: "POST" });
      output.textContent = result.output || "Upgrade completed.";
      toast(result.success ? "Updates installed" : "Upgrade had issues", result.success ? "success" : "error");
    } catch (err) {
      output.textContent = "Error: " + err.message;
      toast("Upgrade failed", "error");
    }

    btnCheck.disabled = false;
    btnInstall.disabled = false;
    spinner.classList.add("hidden");
  }

  /* ---------------------------------------------------------------
     LOGS
     --------------------------------------------------------------- */
  async function loadLogs() {
    var selectMsg = $("#logs-select-msg");
    var content = $("#logs-content");

    if (!selectedMachineId) {
      selectMsg.style.display = "";
      content.style.display = "none";
      return;
    }

    var m = selectedMachine();
    if (!m || m.status === "offline") {
      selectMsg.textContent = "Machine is offline.";
      selectMsg.style.display = "";
      content.style.display = "none";
      return;
    }

    selectMsg.style.display = "none";
    content.style.display = "";

    // Update service dropdown with known services
    updateLogServiceOptions();
  }

  function updateLogServiceOptions() {
    var select = $("#logs-service");
    // Keep current selection
    var current = select.value;

    // We'll add services from the service list if available
    var m = selectedMachine();
    if (!m) return;

    // Fetch services to populate log dropdown
    api("/api/m/" + m.id + "/services").then(function (services) {
      select.innerHTML = '<option value="system">system</option>';
      if (services && services.length > 0) {
        services.forEach(function (svc) {
          var opt = document.createElement("option");
          opt.value = svc.name;
          opt.textContent = svc.name;
          select.appendChild(opt);
        });
      }
      // Restore selection
      if (current) select.value = current;
    }).catch(function () { /* keep default */ });
  }

  async function refreshLogs() {
    var m = selectedMachine();
    if (!m) return;

    var service = $("#logs-service").value;
    var lines = $("#logs-lines").value;
    var output = $("#logs-output");

    output.textContent = "Loading logs...";

    try {
      var data = await api("/api/m/" + m.id + "/logs?service=" + encodeURIComponent(service) + "&lines=" + lines);
      if (data.lines && data.lines.length > 0) {
        output.textContent = data.lines.join("\n");
      } else {
        output.textContent = data.error || "No log entries found.";
      }
    } catch (err) {
      output.textContent = "Error: " + err.message;
    }

    output.scrollTop = output.scrollHeight;
  }

  /* ---------------------------------------------------------------
     Machine Management Modal
     --------------------------------------------------------------- */
  function openMachinesModal() {
    var list = $("#machines-list");
    list.innerHTML = "";

    machines.forEach(function (m) {
      var item = document.createElement("div");
      item.className = "machine-list-item";
      item.innerHTML =
        '<div class="machine-list-info">' +
        '<span class="icon">' + m.icon + '</span>' +
        '<span class="name">' + escapeHtml(m.name) + '</span>' +
        '<span class="desc">' + escapeHtml(m.description) + ' - ' + escapeHtml(m.ip) + ':' + m.agent_port + '</span>' +
        '</div>' +
        '<button class="btn btn-xs btn-danger" data-delete="' + m.id + '">Remove</button>';
      list.appendChild(item);
    });

    // Delete handlers
    list.querySelectorAll("[data-delete]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.dataset.delete;
        if (!confirm("Remove machine '" + id + "'?")) return;
        try {
          await api("/api/machines/" + id, { method: "DELETE" });
          toast("Machine removed", "success");
          await loadMachines();
          openMachinesModal(); // refresh
        } catch (err) {
          toast("Failed: " + err.message, "error");
        }
      });
    });

    $("#machines-modal").classList.remove("hidden");
  }

  async function addMachine() {
    var body = {
      id: $("#add-machine-id").value.trim(),
      name: $("#add-machine-name").value.trim(),
      description: $("#add-machine-desc").value.trim(),
      ip: $("#add-machine-ip").value.trim(),
      agent_port: parseInt($("#add-machine-port").value, 10) || 3001,
      icon: $("#add-machine-icon").value.trim() || "&#127827;",
      default_path: $("#add-machine-path").value.trim() || "/",
    };

    if (!body.id || !body.name || !body.ip) {
      toast("ID, Name, and IP are required.", "error");
      return;
    }

    try {
      await api("/api/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      toast("Machine added", "success");
      $("#add-machine-modal").classList.add("hidden");
      await loadMachines();
      openMachinesModal();
    } catch (err) {
      toast("Failed: " + err.message, "error");
    }
  }

  /* ---------------------------------------------------------------
     File Transfer
     --------------------------------------------------------------- */
  function openTransferModal() {
    if (!currentFilePath) {
      toast("No file selected for transfer", "error");
      return;
    }

    var select = $("#transfer-dest-machine");
    select.innerHTML = "";
    machines.forEach(function (m) {
      if (m.id !== selectedMachineId) {
        var opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.icon + " " + m.name;
        select.appendChild(opt);
      }
    });

    $("#transfer-source").value = currentFilePath;
    $("#transfer-modal").classList.remove("hidden");
  }

  async function executeTransfer() {
    var sourcePath = $("#transfer-source").value;
    var destMachine = $("#transfer-dest-machine").value;
    var destPath = $("#transfer-dest-path").value.trim();

    if (!destPath) {
      toast("Destination path is required", "error");
      return;
    }

    try {
      var result = await api("/api/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_machine: selectedMachineId,
          source_path: sourcePath,
          dest_machine: destMachine,
          dest_path: destPath,
        }),
      });
      toast(result.message || "Transfer completed", result.success ? "success" : "error");
      $("#transfer-modal").classList.add("hidden");
    } catch (err) {
      toast("Transfer failed: " + err.message, "error");
    }
  }

  /* ---------------------------------------------------------------
     File Upload
     --------------------------------------------------------------- */
  async function uploadFile(file) {
    var m = selectedMachine();
    if (!m || !currentFilePath) return;

    var formData = new FormData();
    formData.append("file", file);
    formData.append("path", currentFilePath);

    try {
      var resp = await fetch("/api/m/" + m.id + "/files/upload", {
        method: "POST",
        body: formData,
      });
      var data = await resp.json();
      if (data.success) {
        toast("File uploaded: " + file.name, "success");
        loadFiles(currentFilePath);
      } else {
        toast("Upload failed: " + (data.error || "Unknown error"), "error");
      }
    } catch (err) {
      toast("Upload failed: " + err.message, "error");
    }
  }

  /* ---------------------------------------------------------------
     File Editor Save
     --------------------------------------------------------------- */
  async function saveFile() {
    var m = selectedMachine();
    if (!m || !fileEditorPath) return;

    var content = $("#editor-content").value;

    try {
      var result = await api("/api/m/" + m.id + "/files/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: fileEditorPath, content: content }),
      });
      toast(result.message || "File saved", result.success ? "success" : "error");
      if (result.success) {
        $("#editor-modal").classList.add("hidden");
      }
    } catch (err) {
      toast("Save failed: " + err.message, "error");
    }
  }

  /* ---------------------------------------------------------------
     Init: Load machines, bind events
     --------------------------------------------------------------- */
  async function loadMachines() {
    try {
      machines = await api("/api/machines");
    } catch (err) {
      machines = [];
      toast("Failed to load machines: " + err.message, "error");
    }
    renderMachineSelector();
  }

  async function init() {
    await loadMachines();
    showSection("monitoring");

    // -- Navigation --
    $$(".nav-link").forEach(function (link) {
      link.addEventListener("click", function (e) {
        e.preventDefault();
        showSection(link.dataset.section);
        // Close sidebar on mobile
        $("#sidebar").classList.remove("open");
      });
    });

    // -- Hamburger --
    $("#hamburger").addEventListener("click", function () {
      $("#sidebar").classList.toggle("open");
    });

    // -- Machine management --
    $("#btn-manage-machines").addEventListener("click", openMachinesModal);
    $("#machines-modal-close").addEventListener("click", function () { $("#machines-modal").classList.add("hidden"); });
    $("#btn-add-machine").addEventListener("click", function () {
      // Clear form
      ["id", "name", "desc", "ip", "icon", "path"].forEach(function (f) {
        var el = $("#add-machine-" + f);
        if (el) el.value = "";
      });
      $("#add-machine-port").value = "3001";
      $("#add-machine-modal").classList.remove("hidden");
    });
    $("#add-machine-close").addEventListener("click", function () { $("#add-machine-modal").classList.add("hidden"); });
    $("#add-machine-cancel").addEventListener("click", function () { $("#add-machine-modal").classList.add("hidden"); });
    $("#add-machine-submit").addEventListener("click", addMachine);

    // -- Terminal --
    $("#terminal-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var cmd = this.value.trim();
        if (!cmd) return;

        // Add to history
        terminalHistory.push(cmd);
        terminalHistoryIdx = terminalHistory.length;

        this.value = "";

        // Handle clear
        if (cmd === "clear" || cmd === "cls") {
          $("#terminal-output").innerHTML = "";
          return;
        }

        executeCommand(cmd);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (terminalHistoryIdx > 0) {
          terminalHistoryIdx--;
          this.value = terminalHistory[terminalHistoryIdx];
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (terminalHistoryIdx < terminalHistory.length - 1) {
          terminalHistoryIdx++;
          this.value = terminalHistory[terminalHistoryIdx];
        } else {
          terminalHistoryIdx = terminalHistory.length;
          this.value = "";
        }
      }
    });

    // -- Updates --
    $("#btn-check-updates").addEventListener("click", checkUpdates);
    $("#btn-install-updates").addEventListener("click", installUpdates);

    // -- Logs --
    $("#btn-refresh-logs").addEventListener("click", refreshLogs);

    // -- Files --
    $("#btn-transfer").addEventListener("click", openTransferModal);
    $("#transfer-close").addEventListener("click", function () { $("#transfer-modal").classList.add("hidden"); });
    $("#transfer-cancel").addEventListener("click", function () { $("#transfer-modal").classList.add("hidden"); });
    $("#transfer-submit").addEventListener("click", executeTransfer);

    // -- Upload --
    $("#btn-upload").addEventListener("click", function () {
      $("#file-upload-input").click();
    });
    $("#file-upload-input").addEventListener("change", function () {
      if (this.files && this.files[0]) {
        uploadFile(this.files[0]);
        this.value = "";
      }
    });

    // -- File Editor --
    $("#editor-close").addEventListener("click", function () { $("#editor-modal").classList.add("hidden"); });
    $("#editor-cancel").addEventListener("click", function () { $("#editor-modal").classList.add("hidden"); });
    $("#editor-save").addEventListener("click", saveFile);

    // -- Close modals on overlay click --
    $$(".modal-overlay").forEach(function (overlay) {
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) {
          overlay.classList.add("hidden");
        }
      });
    });

    // -- Keyboard shortcut: Escape closes modals --
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        $$(".modal-overlay").forEach(function (o) { o.classList.add("hidden"); });
      }
    });
  }

  // Boot
  document.addEventListener("DOMContentLoaded", init);
})();
