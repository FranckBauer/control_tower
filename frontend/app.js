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

  function getMachine(id) {
    return machines.find(function (m) { return m.id === id; });
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
    // Reset file path to machine's default
    currentFilePath = m ? (m.default_path || "/") : null;
    // Reset terminal cwd
    terminalCwd = null;
    renderMachineSelector();
    loadSection(currentSection);
  }

  /* ---------------------------------------------------------------
     Navigation
     --------------------------------------------------------------- */
  function showSection(name) {
    currentSection = name;
    $$(".section").forEach(function (s) {
      s.classList.remove("active");
      s.classList.add("hidden");
    });
    var sec = $("#section-" + name);
    if (sec) {
      sec.classList.remove("hidden");
      sec.classList.add("active");
    }

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
  function renderMonitoringContent(content, results) {
    var html = '<div class="overview-grid">';
    results.forEach(function (r) {
      html += buildOverviewCard(r.machine, r.data);
    });
    html += '</div>';
    content.innerHTML = html;

    content.querySelectorAll(".overview-card").forEach(function (card) {
      card.addEventListener("click", function () {
        selectMachine(card.dataset.machineId);
      });
    });

    content.querySelectorAll("[data-gauge-value]").forEach(function (el) {
      el.style.setProperty("--gauge-value", el.dataset.gaugeValue);
      el.style.setProperty("--gauge-color", el.dataset.gaugeColor);
    });
  }

  function renderSingleMonitoring(content, data) {
    // Preserve the detail panel DOM node if it exists
    var detailContainer = content.querySelector("#detail-panel-container");
    var savedDetail = null;
    if (detailContainer && detailContainer.children.length > 0) {
      savedDetail = detailContainer.cloneNode(true);
    }

    // Rebuild gauges and sysinfo only
    var metricsHtml = buildSingleMachineView(data) + '<div class="detail-panel-container" id="detail-panel-container"></div>';
    content.innerHTML = metricsHtml;

    // Restore saved detail panel (don't reload it)
    if (savedDetail) {
      var newContainer = content.querySelector("#detail-panel-container");
      newContainer.innerHTML = savedDetail.innerHTML;
    }

    content.querySelectorAll("[data-gauge-value]").forEach(function (el) {
      el.style.setProperty("--gauge-value", el.dataset.gaugeValue);
      el.style.setProperty("--gauge-color", el.dataset.gaugeColor);
    });

    // Metric card click handlers
    content.querySelectorAll("[data-detail]").forEach(function (card) {
      card.addEventListener("click", function () {
        loadDetailPanel(card.dataset.detail);
      });
    });
  }

  async function loadDetailPanel(type) {
    var m = selectedMachine();
    if (!m) return;
    var container = $("#detail-panel-container");
    if (!container) return;

    // Toggle: if same panel is open, close it
    var existing = container.querySelector('.detail-panel[data-type="' + type + '"]');
    if (existing) {
      container.innerHTML = "";
      return;
    }

    container.innerHTML = '<div class="detail-panel" data-type="' + type + '"><div class="loading-indicator">Loading...</div></div>';

    try {
      if (type === "cpu" || type === "memory") {
        var sortBy = type === "cpu" ? "cpu" : "memory";
        var data = await api("/api/m/" + m.id + "/processes?sort=" + sortBy + "&limit=20");
        var procs = data.processes || [];

        var html = '<div class="detail-panel" data-type="' + type + '">';
        html += '<div class="detail-panel-header">';
        html += '<h3>Top processes by ' + (type === "cpu" ? "CPU" : "Memory") + ' usage</h3>';
        html += '<span class="detail-panel-total">' + (data.total || 0) + ' total processes</span>';
        html += '</div>';
        html += '<table><thead><tr>';
        html += '<th>PID</th><th>Name</th><th>User</th><th>CPU %</th><th>RAM %</th><th>RAM</th><th>Status</th>';
        html += '</tr></thead><tbody>';

        procs.forEach(function (p) {
          var cpuClass = p.cpu_percent > 50 ? "pill-red" : p.cpu_percent > 20 ? "pill-yellow" : "";
          var memClass = p.memory_percent > 50 ? "pill-red" : p.memory_percent > 20 ? "pill-yellow" : "";
          html += '<tr>';
          html += '<td>' + p.pid + '</td>';
          html += '<td><strong>' + escapeHtml(p.name) + '</strong></td>';
          html += '<td>' + escapeHtml(p.user) + '</td>';
          html += '<td><span class="' + cpuClass + '">' + p.cpu_percent.toFixed(1) + '%</span></td>';
          html += '<td><span class="' + memClass + '">' + p.memory_percent.toFixed(1) + '%</span></td>';
          html += '<td>' + formatBytes(p.memory_rss) + '</td>';
          html += '<td>' + escapeHtml(p.status) + '</td>';
          html += '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;

      } else if (type === "disk") {
        var data = await api("/api/m/" + m.id + "/disk/usage");
        var parts = data.partitions || [];

        var html = '<div class="detail-panel" data-type="' + type + '">';
        html += '<div class="detail-panel-header"><h3>Disk partitions</h3></div>';
        html += '<table><thead><tr>';
        html += '<th>Device</th><th>Mount</th><th>Type</th><th>Total</th><th>Used</th><th>Free</th><th>Usage</th>';
        html += '</tr></thead><tbody>';

        parts.forEach(function (p) {
          var usageClass = p.percent > 90 ? "pill-red" : p.percent > 70 ? "pill-yellow" : "pill-green";
          html += '<tr>';
          html += '<td><strong>' + escapeHtml(p.device) + '</strong></td>';
          html += '<td>' + escapeHtml(p.mountpoint) + '</td>';
          html += '<td>' + escapeHtml(p.fstype) + '</td>';
          html += '<td>' + formatBytes(p.total) + '</td>';
          html += '<td>' + formatBytes(p.used) + '</td>';
          html += '<td>' + formatBytes(p.free) + '</td>';
          html += '<td><span class="pill ' + usageClass + '">' + Math.round(p.percent) + '%</span></td>';
          html += '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;
      }
    } catch (err) {
      container.innerHTML = '<div class="detail-panel" data-type="' + type + '"><div style="padding:20px;color:var(--danger)">' + escapeHtml(err.message) + '</div></div>';
    }
  }

  async function fetchAllSystems() {
    return Promise.all(machines.map(function (m) {
      if (m.status === "online") {
        return api("/api/m/" + m.id + "/system").then(function (data) {
          monitoringCache[m.id] = data;
          return { machine: m, data: data };
        }).catch(function () {
          return { machine: m, data: null };
        });
      }
      return Promise.resolve({ machine: m, data: null });
    }));
  }

  async function loadMonitoring() {
    var content = $("#monitoring-content");
    var badge = $("#monitoring-machine-count");
    var isFirstLoad = !content.querySelector(".overview-grid") && !content.querySelector(".metric-grid");

    if (selectedMachineId === null) {
      badge.textContent = machines.length + " machines";

      if (isFirstLoad) {
        content.innerHTML = '<div class="loading-indicator">Loading machines...</div>';
      }

      var results = await fetchAllSystems();
      renderMonitoringContent(content, results);

      // Auto-refresh — only set if not already set
      if (!refreshTimer) {
        refreshTimer = setInterval(function () {
          if (currentSection === "monitoring" && selectedMachineId === null) {
            fetchAllSystems().then(function (results) {
              renderMonitoringContent(content, results);
            });
          }
        }, 15000);
      }

    } else {
      var m = selectedMachine();
      badge.textContent = m ? m.name : "";

      if (!m || m.status === "offline") {
        content.innerHTML = '<div class="select-machine-msg">Machine is offline.</div>';
        return;
      }

      if (isFirstLoad) {
        content.innerHTML = '<div class="loading-indicator">Loading system data...</div>';
      }

      try {
        var data = await api("/api/m/" + m.id + "/system");
        monitoringCache[m.id] = data;
        renderSingleMonitoring(content, data);

        if (!refreshTimer) {
          var machineId = m.id;
          refreshTimer = setInterval(function () {
            if (currentSection === "monitoring" && selectedMachineId === machineId) {
              api("/api/m/" + machineId + "/system").then(function (fresh) {
                monitoringCache[machineId] = fresh;
                renderSingleMonitoring(content, fresh);
              }).catch(function () {});
            }
          }, 10000);
        }

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

    // Temp Card (only if available)
    if (temp != null) {
      html += buildMetricCard(Math.round(temp), "\u00B0C", "Temperature", tempColor(temp), "CPU thermal zone");
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
    var sortKey = label === "CPU" ? "cpu" : label === "Memory" ? "memory" : label === "Disk" ? "disk" : "";
    var clickAttr = sortKey ? ' data-detail="' + sortKey + '" style="cursor:pointer" title="Click for details"' : '';
    return '<div class="metric-card"' + clickAttr + '>' +
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
    body.innerHTML = '<tr><td colspan="6" class="loading-indicator">Loading services...</td></tr>';

    try {
      var services = await api("/api/m/" + m.id + "/services");
      body.innerHTML = "";

      if (!services || services.length === 0) {
        body.innerHTML = '<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text-muted)">No services found.</td></tr>';
        return;
      }

      // Build search bar
      var existingFilter = card.querySelector(".services-filter");
      if (existingFilter) existingFilter.remove();

      var filterDiv = document.createElement("div");
      filterDiv.className = "services-filter";
      filterDiv.innerHTML =
        '<div style="display:flex;gap:10px;align-items:center">' +
          '<input type="text" id="services-search" placeholder="Search..." style="flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:var(--radius);font-size:0.85rem">' +
          '<span id="services-count" style="font-size:0.8rem;color:var(--text-muted);white-space:nowrap">' + services.length + ' / ' + services.length + '</span>' +
        '</div>';
      card.querySelector(".table-wrap").insertBefore(filterDiv, card.querySelector("table"));

      // Column filter state
      var activeFilters = { type: null, status: null, boot: null };

      // Collect values per column
      var colValues = { type: {}, status: {}, boot: {} };
      services.forEach(function (s) {
        var t = s.category || "system"; colValues.type[t] = (colValues.type[t] || 0) + 1;
        var st = s.active === "active" ? "running" : s.active === "inactive" ? "stopped" : s.active; colValues.status[st] = (colValues.status[st] || 0) + 1;
        var b = s.enabled || "-"; colValues.boot[b] = (colValues.boot[b] || 0) + 1;
      });

      // Display labels for filter values
      var filterLabels = {
        "third-party": "tiers",
        "system": "system",
        "running": "running",
        "stopped": "stopped",
        "enabled": "enabled",
        "manual": "manual",
        "disabled": "disabled",
        "static": "static",
      };

      // Build dropdown content for each filterable column header
      ["type", "status", "boot"].forEach(function (col) {
        var dropdown = document.getElementById("filter-" + col);
        if (!dropdown) return;
        var vals = colValues[col];
        var html = '';
        Object.keys(vals).sort().forEach(function (val) {
          var label = filterLabels[val] || val;
          html += '<div class="col-filter-item" data-val="' + escapeHtml(val) + '"><span class="check"></span><span>' + escapeHtml(label) + '</span><span class="count">' + vals[val] + '</span></div>';
        });
        html += '<div class="col-filter-clear">Clear filter</div>';
        dropdown.innerHTML = html;
      });

      function applyFilters() {
        var query = (document.getElementById("services-search").value || "").toLowerCase();
        var visible = 0;

        // Count visible values per column (excluding the column's own filter)
        var visibleCounts = { type: {}, status: {}, boot: {} };

        body.querySelectorAll("tr").forEach(function (row) {
          var text = row.textContent.toLowerCase();
          var rowType = row.dataset.type || "";
          var rowStatus = row.dataset.status || "";
          var rowBoot = row.dataset.boot || "";
          var matchText = !query || text.includes(query);
          var matchType = !activeFilters.type || rowType === activeFilters.type;
          var matchStatus = !activeFilters.status || rowStatus === activeFilters.status;
          var matchBoot = !activeFilters.boot || rowBoot === activeFilters.boot;
          var show = matchText && matchType && matchStatus && matchBoot;
          row.style.display = show ? "" : "none";
          if (show) visible++;

          // For each column dropdown, count rows matching ALL OTHER filters (not this column's)
          if (matchText && matchStatus && matchBoot) visibleCounts.type[rowType] = (visibleCounts.type[rowType] || 0) + 1;
          if (matchText && matchType && matchBoot) visibleCounts.status[rowStatus] = (visibleCounts.status[rowStatus] || 0) + 1;
          if (matchText && matchType && matchStatus) visibleCounts.boot[rowBoot] = (visibleCounts.boot[rowBoot] || 0) + 1;
        });

        document.getElementById("services-count").textContent = visible + " / " + services.length;

        // Update counts in dropdowns
        ["type", "status", "boot"].forEach(function (col) {
          var dropdown = document.getElementById("filter-" + col);
          if (!dropdown) return;
          dropdown.querySelectorAll(".col-filter-item").forEach(function (item) {
            var val = item.dataset.val;
            var count = visibleCounts[col][val] || 0;
            var countSpan = item.querySelector(".count");
            if (countSpan) countSpan.textContent = count;
          });
        });
      }

      filterDiv.querySelector("#services-search").addEventListener("input", applyFilters);

      // Reset filter visual state on headers
      card.querySelectorAll(".th-filterable").forEach(function (th) { th.classList.remove("filtered"); });

      // Use event delegation on card for all filter interactions (only bind once)
      if (!card._filterBound) {
        card._filterBound = true;

        card.addEventListener("click", function (e) {
          // Header click → toggle dropdown
          var th = e.target.closest(".th-filterable");
          if (th && !e.target.closest(".col-filter-dropdown")) {
            e.stopPropagation();
            var col = th.dataset.col;
            var dropdown = document.getElementById("filter-" + col);
            card.querySelectorAll(".col-filter-dropdown").forEach(function (d) {
              if (d !== dropdown) d.classList.add("hidden");
            });
            dropdown.classList.toggle("hidden");
            return;
          }

          // Filter item click
          var item = e.target.closest(".col-filter-item");
          if (item) {
            e.stopPropagation();
            var dropdown = item.closest(".col-filter-dropdown");
            var thParent = item.closest(".th-filterable");
            var col = thParent.dataset.col;
            var val = item.dataset.val;

            if (activeFilters[col] === val) {
              activeFilters[col] = null;
            } else {
              activeFilters[col] = val;
            }

            dropdown.querySelectorAll(".col-filter-item").forEach(function (i) {
              var selected = i.dataset.val === activeFilters[col];
              i.classList.toggle("selected", selected);
              i.querySelector(".check").textContent = selected ? "✓" : "";
            });
            thParent.classList.toggle("filtered", !!activeFilters[col]);
            applyFilters();
            return;
          }

          // Clear filter click
          var clearBtn = e.target.closest(".col-filter-clear");
          if (clearBtn) {
            e.stopPropagation();
            var thParent = clearBtn.closest(".th-filterable");
            var col = thParent.dataset.col;
            var dropdown = clearBtn.closest(".col-filter-dropdown");
            activeFilters[col] = null;
            dropdown.querySelectorAll(".col-filter-item").forEach(function (i) {
              i.classList.remove("selected");
              i.querySelector(".check").textContent = "";
            });
            thParent.classList.remove("filtered");
            dropdown.classList.add("hidden");
            applyFilters();
            return;
          }
        });

        // Close dropdowns on outside click (once)
        document.addEventListener("click", function () {
          card.querySelectorAll(".col-filter-dropdown").forEach(function (d) { d.classList.add("hidden"); });
        });
      }

      services.forEach(function (svc) {
        var tr = document.createElement("tr");
        var isThirdParty = svc.category === "third-party";
        var statusLabel = svc.active === "active" ? "running" : svc.active === "inactive" ? "stopped" : svc.active;
        tr.dataset.type = svc.category || "system";
        tr.dataset.status = statusLabel;
        tr.dataset.boot = svc.enabled || "-";

        // Name
        var tdName = document.createElement("td");
        tdName.innerHTML = '<span style="font-family:var(--font-mono);font-weight:500">' + escapeHtml(svc.name) + '</span>';
        tr.appendChild(tdName);

        // Description
        var tdDesc = document.createElement("td");
        tdDesc.style.cssText = "font-size:0.8rem;color:var(--text-muted);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        tdDesc.textContent = svc.display_name || "";
        tdDesc.title = svc.display_name || "";
        tr.appendChild(tdDesc);

        // Type (system vs third-party)
        var tdType = document.createElement("td");
        if (isThirdParty) {
          tdType.innerHTML = '<span class="pill pill-yellow">tiers</span>';
        } else {
          tdType.innerHTML = '<span class="pill pill-blue">system</span>';
        }
        tr.appendChild(tdType);

        // Running status
        var tdStatus = document.createElement("td");
        var pillClass = svc.active === "active" ? "pill-green" : svc.active === "inactive" ? "pill-red" : svc.active === "failed" ? "pill-red" : "pill-gray";
        var statusLabel = svc.active === "active" ? "running" : svc.active === "inactive" ? "stopped" : svc.active;
        tdStatus.innerHTML = '<span class="pill ' + pillClass + '">' + escapeHtml(statusLabel) + '</span>';
        tr.appendChild(tdStatus);

        // Boot (enabled/disabled/manual/static)
        var tdEnabled = document.createElement("td");
        var enPillClass = svc.enabled === "enabled" ? "pill-blue" : svc.enabled === "disabled" ? "pill-gray" : svc.enabled === "manual" ? "pill-yellow" : svc.enabled === "static" ? "pill-blue" : "pill-gray";
        tdEnabled.innerHTML = '<span class="pill ' + enPillClass + '">' + escapeHtml(svc.enabled || "-") + '</span>';
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
  var networkData = null; // cached for detail panels

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
      networkData = data;

      // Stat cards — clickable
      stats.innerHTML =
        '<div class="stat-card clickable" data-net-detail="connections">' +
          '<div class="stat-card-label">Active connections</div>' +
          '<div class="stat-card-value">' + formatNumber(data.connections) + '</div>' +
          '<div class="stat-card-desc">TCP/UDP connections currently open</div>' +
        '</div>' +
        '<div class="stat-card clickable" data-net-detail="interfaces">' +
          '<div class="stat-card-label">Network interfaces</div>' +
          '<div class="stat-card-value">' + (data.interfaces ? data.interfaces.length : 0) + '</div>' +
          '<div class="stat-card-desc">Physical and virtual adapters</div>' +
        '</div>' +
        '<div class="stat-card">' +
          '<div class="stat-card-label">Total sent</div>' +
          '<div class="stat-card-value">' + formatBytes(data.io ? data.io.bytes_sent : 0) + '</div>' +
          '<div class="stat-card-desc">Cumulative since boot</div>' +
        '</div>' +
        '<div class="stat-card">' +
          '<div class="stat-card-label">Total received</div>' +
          '<div class="stat-card-value">' + formatBytes(data.io ? data.io.bytes_recv : 0) + '</div>' +
          '<div class="stat-card-desc">Cumulative since boot</div>' +
        '</div>';

      // Interfaces — enriched with stats
      if (data.interfaces && data.interfaces.length > 0) {
        var ifHtml = '<div class="iface-grid">';
        data.interfaces.forEach(function (iface) {
          var statusClass = iface.is_up ? "pill-green" : "pill-red";
          var statusText = iface.is_up ? "UP" : "DOWN";
          ifHtml += '<div class="iface-card">';
          ifHtml += '<div class="iface-header"><span class="iface-name">' + escapeHtml(iface.name) + '</span><span class="pill ' + statusClass + '">' + statusText + '</span></div>';
          if (iface.addresses) {
            iface.addresses.forEach(function (addr) {
              ifHtml += '<div class="iface-addr"><span class="label">IP</span><span class="value">' + escapeHtml(addr.ip) + '</span></div>';
              if (addr.netmask) {
                ifHtml += '<div class="iface-addr"><span class="label">Mask</span><span class="value">' + escapeHtml(addr.netmask) + '</span></div>';
              }
            });
          }
          if (iface.speed) ifHtml += '<div class="iface-addr"><span class="label">Speed</span><span class="value">' + iface.speed + ' Mbps</span></div>';
          if (iface.mtu) ifHtml += '<div class="iface-addr"><span class="label">MTU</span><span class="value">' + iface.mtu + '</span></div>';
          if (iface.io) {
            ifHtml += '<div class="iface-io">';
            ifHtml += '<span title="Sent">&uarr; ' + formatBytes(iface.io.bytes_sent) + '</span>';
            ifHtml += '<span title="Received">&darr; ' + formatBytes(iface.io.bytes_recv) + '</span>';
            ifHtml += '</div>';
          }
          ifHtml += '</div>';
        });
        ifHtml += '</div>';
        ifaces.innerHTML = ifHtml;
      }

      // Traffic summary
      if (data.io) {
        traffic.innerHTML =
          '' +
          '<div class="traffic-grid">' +
          '<div class="traffic-item"><div class="traffic-label">Bytes sent</div><div class="traffic-value">' + formatBytes(data.io.bytes_sent) + '</div></div>' +
          '<div class="traffic-item"><div class="traffic-label">Bytes received</div><div class="traffic-value">' + formatBytes(data.io.bytes_recv) + '</div></div>' +
          '<div class="traffic-item"><div class="traffic-label">Packets sent</div><div class="traffic-value">' + formatNumber(data.io.packets_sent) + '</div></div>' +
          '<div class="traffic-item"><div class="traffic-label">Packets received</div><div class="traffic-value">' + formatNumber(data.io.packets_recv) + '</div></div>' +
          '</div>';
      }

      // Detail panel container
      if (!content.querySelector("#net-detail-container")) {
        var detailDiv = document.createElement("div");
        detailDiv.id = "net-detail-container";
        content.appendChild(detailDiv);
      }

      // Stat card click handlers via delegation
      if (!content._netClickBound) {
        content._netClickBound = true;
        content.addEventListener("click", function (e) {
          var card = e.target.closest("[data-net-detail]");
          if (!card) return;
          loadNetworkDetail(card.dataset.netDetail);
        });
      }

    } catch (err) {
      stats.innerHTML = '<div class="stat-card"><div class="stat-card-label" style="color:var(--red)">' + escapeHtml(err.message) + '</div></div>';
    }
  }

  async function loadNetworkDetail(type) {
    var m = selectedMachine();
    if (!m) return;
    var container = $("#net-detail-container");
    if (!container) return;

    // Toggle
    var existing = container.querySelector('.detail-panel[data-type="' + type + '"]');
    if (existing) { container.innerHTML = ""; return; }

    container.innerHTML = '<div class="detail-panel" data-type="' + type + '"><div class="loading-indicator">Loading...</div></div>';

    try {
      if (type === "connections") {
        var data = await api("/api/m/" + m.id + "/connections?limit=100");
        var conns = data.connections || [];
        var html = '<div class="detail-panel" data-type="connections">';
        html += '<div class="detail-panel-header"><h3>Active connections</h3><span class="detail-panel-total">' + (data.total || 0) + ' total</span></div>';
        html += '<table><thead><tr><th>Type</th><th>Local address</th><th>Remote address</th><th>Status</th><th>PID</th></tr></thead><tbody>';
        conns.forEach(function (c) {
          var statusClass = c.status === "ESTABLISHED" ? "pill-green" : c.status === "LISTEN" ? "pill-blue" : c.status === "TIME_WAIT" ? "pill-yellow" : "pill-gray";
          html += '<tr>';
          html += '<td>' + escapeHtml(c.type) + '</td>';
          html += '<td style="font-family:var(--font-mono);font-size:0.8rem">' + escapeHtml(c.local) + '</td>';
          html += '<td style="font-family:var(--font-mono);font-size:0.8rem">' + escapeHtml(c.remote || "-") + '</td>';
          html += '<td><span class="pill ' + statusClass + '">' + escapeHtml(c.status) + '</span></td>';
          html += '<td>' + (c.pid || "-") + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table></div>';
        container.innerHTML = html;

      } else if (type === "interfaces" && networkData) {
        var ifaces = networkData.interfaces || [];
        var html = '<div class="detail-panel" data-type="interfaces">';
        html += '<div class="detail-panel-header"><h3>Interface details</h3><span class="detail-panel-total">' + ifaces.length + ' interfaces</span></div>';
        html += '<table><thead><tr><th>Name</th><th>Status</th><th>IP</th><th>Netmask</th><th>Speed</th><th>MTU</th><th>Sent</th><th>Received</th></tr></thead><tbody>';
        ifaces.forEach(function (iface) {
          var ip = iface.addresses && iface.addresses[0] ? iface.addresses[0].ip : "-";
          var mask = iface.addresses && iface.addresses[0] ? iface.addresses[0].netmask : "-";
          var statusClass = iface.is_up ? "pill-green" : "pill-red";
          html += '<tr>';
          html += '<td><strong>' + escapeHtml(iface.name) + '</strong></td>';
          html += '<td><span class="pill ' + statusClass + '">' + (iface.is_up ? "UP" : "DOWN") + '</span></td>';
          html += '<td style="font-family:var(--font-mono);font-size:0.8rem">' + escapeHtml(ip) + '</td>';
          html += '<td style="font-family:var(--font-mono);font-size:0.8rem">' + escapeHtml(mask) + '</td>';
          html += '<td>' + (iface.speed ? iface.speed + " Mbps" : "-") + '</td>';
          html += '<td>' + (iface.mtu || "-") + '</td>';
          html += '<td>' + (iface.io ? formatBytes(iface.io.bytes_sent) : "-") + '</td>';
          html += '<td>' + (iface.io ? formatBytes(iface.io.bytes_recv) : "-") + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table></div>';
        container.innerHTML = html;
      }
    } catch (err) {
      container.innerHTML = '<div class="detail-panel" data-type="' + type + '"><div style="padding:20px;color:var(--danger)">' + escapeHtml(err.message) + '</div></div>';
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
            '<td class="col-modified">' + formatDate(entry.modified) + '</td>' +
            '<td class="col-actions"></td>';
        } else {
          tr.innerHTML =
            '<td><span class="file-link" data-file="' + escapeHtml(entryPath) + '"><span class="file-icon">&#128196;</span>' + escapeHtml(entry.name) + '</span></td>' +
            '<td class="col-size">' + (entry.size != null ? formatBytes(entry.size) : "") + '</td>' +
            '<td class="col-modified">' + formatDate(entry.modified) + '</td>' +
            '<td class="col-actions">' +
              '<div class="btn-group">' +
              '<button class="btn btn-xs" data-edit-file="' + escapeHtml(entryPath) + '" title="Edit">Edit</button>' +
              '<button class="btn btn-xs" data-download-file="' + escapeHtml(entryPath) + '" title="Download">&#8595;</button>' +
              '<button class="btn btn-xs" data-transfer-file="' + escapeHtml(entryPath) + '" title="Transfer to another machine">&#8594;</button>' +
              '</div>' +
            '</td>';
        }
        body.appendChild(tr);
      });

      // Click handlers for dirs
      body.querySelectorAll("[data-path]").forEach(function (el) {
        el.addEventListener("click", function () {
          loadFiles(el.dataset.path);
        });
      });

      // Click handlers for file names (open editor)
      body.querySelectorAll("[data-file]").forEach(function (el) {
        el.addEventListener("click", function () {
          openFileEditor(el.dataset.file);
        });
      });

      // Edit buttons
      body.querySelectorAll("[data-edit-file]").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          openFileEditor(btn.dataset.editFile);
        });
      });

      // Download buttons
      body.querySelectorAll("[data-download-file]").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          var filePath = btn.dataset.downloadFile;
          var m = selectedMachine();
          if (!m) return;
          // Open download in new tab
          window.open("/api/m/" + m.id + "/files/download?path=" + encodeURIComponent(filePath), "_blank");
        });
      });

      // Transfer buttons (per file)
      body.querySelectorAll("[data-transfer-file]").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          openTransferModal(btn.dataset.transferFile);
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

    // Auto-load logs
    setTimeout(refreshLogs, 200);
  }

  function updateLogServiceOptions() {
    var select = $("#logs-service");
    var current = select.value;
    var m = selectedMachine();
    if (!m) return;

    // Load services list for dropdown
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
      if (current) select.value = current;
    }).catch(function () {
      select.innerHTML = '<option value="system">system</option>';
    });
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
  var transferBrowserPath = null;

  function openTransferModal(filePath) {
    var sourcePath = filePath || currentFilePath;
    if (!sourcePath) {
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

    $("#transfer-source").value = sourcePath;
    $("#transfer-dest-path").value = "";
    $("#transfer-modal").classList.remove("hidden");

    // Load dest browser for default machine
    var destId = select.value;
    if (destId) {
      var destM = getMachine(destId);
      var startPath = destM ? (destM.default_path || "/") : "/";
      loadTransferBrowser(destId, startPath);
    }

    // On machine change, reload browser
    if (!select._transferBound) {
      select._transferBound = true;
      select.addEventListener("change", function () {
        var dm = getMachine(this.value);
        var sp = dm ? (dm.default_path || "/") : "/";
        loadTransferBrowser(this.value, sp);
      });
    }
  }

  async function loadTransferBrowser(machineId, path) {
    var list = $("#transfer-browser-list");
    var breadcrumbs = $("#transfer-browser-breadcrumbs");
    transferBrowserPath = path;
    $("#transfer-dest-path").value = path;

    list.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:0.8rem">Loading...</div>';

    // Breadcrumbs
    var sep = pathSeparator(path);
    var parts = pathParts(path);
    var bcHtml = '';
    if (sep === "\\") {
      bcHtml += '<span class="bc-link" data-tbpath="' + escapeHtml(parts[0] || "C:\\") + '">' + escapeHtml(parts[0] || "C:\\") + '</span>';
      var acc = parts[0] || "C:\\";
      for (var i = 1; i < parts.length; i++) {
        acc += parts[i] + (i < parts.length - 1 ? sep : "");
        bcHtml += '<span class="bc-sep"> \\ </span><span class="bc-link" data-tbpath="' + escapeHtml(acc) + '">' + escapeHtml(parts[i]) + '</span>';
      }
    } else {
      bcHtml += '<span class="bc-link" data-tbpath="/">/</span>';
      var acc = "";
      for (var i = 0; i < parts.length; i++) {
        acc += "/" + parts[i];
        bcHtml += '<span class="bc-sep"> &rsaquo; </span><span class="bc-link" data-tbpath="' + escapeHtml(acc) + '">' + escapeHtml(parts[i]) + '</span>';
      }
    }
    breadcrumbs.innerHTML = bcHtml;

    // Breadcrumb clicks
    breadcrumbs.querySelectorAll(".bc-link").forEach(function (link) {
      link.addEventListener("click", function () {
        loadTransferBrowser(machineId, link.dataset.tbpath);
      });
    });

    try {
      var data = await api("/api/m/" + machineId + "/files?path=" + encodeURIComponent(path));
      var entries = data.entries || [];
      var dirs = entries.filter(function (e) { return e.is_dir; });

      if (dirs.length === 0) {
        list.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:0.8rem">No subdirectories</div>';
        return;
      }

      list.innerHTML = "";
      dirs.forEach(function (dir) {
        var dirPath = pathJoin(path, dir.name);
        var item = document.createElement("div");
        item.className = "transfer-browser-item";
        item.innerHTML = '<span class="folder-icon">&#128193;</span><span>' + escapeHtml(dir.name) + '</span>';
        item.addEventListener("click", function () {
          loadTransferBrowser(machineId, dirPath);
        });
        list.appendChild(item);
      });
    } catch (err) {
      list.innerHTML = '<div style="padding:10px;color:var(--danger);font-size:0.8rem">' + escapeHtml(err.message) + '</div>';
    }
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
    try {
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
    $("#btn-transfer").addEventListener("click", function () { openTransferModal(); });
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

    } catch (err) {
      console.error("[Control Tower] init failed:", err);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
