/* ========================================
   Pi Dashboard — Multi-Machine Frontend
   ======================================== */

(function () {
  "use strict";

  // --- Global State ---
  let machines = [];
  let currentMachine = "all";
  let currentSection = "monitoring";
  let commandHistory = [];
  let historyIndex = -1;
  let monitoringTimer = null;
  let statusTimer = null;
  let currentFilePath = "";
  let editorFilePath = "";
  let servicesList = [];
  let terminalCwd = {};  // per-machine cwd: { machineId: "/path" }

  // --- DOM helpers ---
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // =============================================
  //  HELPER FUNCTIONS
  // =============================================

  function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return "-";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(1).replace(/\.0$/, "") + " " + units[i];
  }

  function formatUptime(seconds) {
    if (!seconds && seconds !== 0) return "-";
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (d) parts.push(d + "j");
    if (h) parts.push(h + "h");
    parts.push(m + "m");
    return parts.join(" ");
  }

  function formatDate(isoString) {
    if (!isoString) return "-";
    try {
      const date = new Date(isoString);
      if (isNaN(date.getTime())) return isoString;
      const months = ["janv.", "fevr.", "mars", "avr.", "mai", "juin", "juil.", "aout", "sept.", "oct.", "nov.", "dec."];
      const day = date.getDate();
      const month = months[date.getMonth()];
      const year = date.getFullYear();
      const hours = String(date.getHours()).padStart(2, "0");
      const minutes = String(date.getMinutes()).padStart(2, "0");
      return day + " " + month + " " + year + " " + hours + ":" + minutes;
    } catch (e) {
      return isoString;
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(str || ""));
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // =============================================
  //  TOAST SYSTEM
  // =============================================

  function showToast(message, type) {
    type = type || "info";
    const container = $("#toast-container");
    const toast = document.createElement("div");
    toast.className = "toast toast-" + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(40px)";
      toast.style.transition = "all 0.3s ease";
      setTimeout(function () { toast.remove(); }, 300);
    }, 4000);
  }

  // =============================================
  //  API FETCH WRAPPER
  // =============================================

  function apiFetch(url, options) {
    options = options || {};
    return fetch(url, options)
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            throw new Error(t || "Error " + res.status);
          });
        }
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) return res.json();
        return res.text();
      })
      .catch(function (err) {
        showToast(err.message, "error");
        throw err;
      });
  }

  /** Build the API base URL for a given machine */
  function machineApiBase(machineId) {
    return "/api/m/" + encodeURIComponent(machineId);
  }

  /** Get machine object by id */
  function getMachine(id) {
    return machines.find(function (m) { return m.id === id; });
  }

  /** Get current machine object (or null if "all") */
  function getCurrentMachine() {
    if (currentMachine === "all") return null;
    return getMachine(currentMachine);
  }

  /** Get online machines */
  function getOnlineMachines() {
    return machines.filter(function (m) { return m.status === "online"; });
  }

  // =============================================
  //  MACHINE MANAGEMENT
  // =============================================

  function loadMachines() {
    return apiFetch("/api/machines")
      .then(function (data) {
        machines = data.machines || data || [];
        renderMachineSelector();
        updateHeaderMachineName();
        return machines;
      })
      .catch(function () {
        machines = [];
        renderMachineSelector();
      });
  }

  function refreshMachineStatuses() {
    apiFetch("/api/machines")
      .then(function (data) {
        machines = data.machines || data || [];
        renderMachineSelector();
        updateHeaderMachineName();
      })
      .catch(function () {});
  }

  function renderMachineSelector() {
    const container = $("#machine-selector");
    // Keep the "All" pill, clear the rest
    container.innerHTML = "";

    // All pill
    const allPill = document.createElement("div");
    allPill.className = "machine-pill" + (currentMachine === "all" ? " selected" : "");
    allPill.setAttribute("data-machine", "all");
    allPill.innerHTML =
      '<span class="machine-pill-icon">&#127760;</span>' +
      '<span class="machine-pill-name">All</span>';
    container.appendChild(allPill);

    machines.forEach(function (m) {
      const pill = document.createElement("div");
      pill.className = "machine-pill" + (currentMachine === m.id ? " selected" : "");
      pill.setAttribute("data-machine", m.id);
      const isOnline = m.status === "online";
      pill.innerHTML =
        '<span class="machine-pill-icon">' + (m.icon || "&#127827;") + '</span>' +
        '<span class="machine-pill-name">' + escapeHtml(m.name) + '</span>' +
        '<span class="status-dot ' + (isOnline ? "online" : "offline") + '"></span>';
      container.appendChild(pill);
    });
  }

  function updateHeaderMachineName() {
    const el = $("#current-machine-name");
    if (currentMachine === "all") {
      el.textContent = "All machines";
    } else {
      const m = getCurrentMachine();
      el.textContent = m ? m.name : "Unknown";
    }
  }

  function selectMachine(machineId) {
    currentMachine = machineId;
    renderMachineSelector();
    updateHeaderMachineName();
    // Reset file path when switching machines
    const m = getCurrentMachine();
    currentFilePath = m && m.default_path ? m.default_path : "/etc";
    // Reload current section
    switchSection(currentSection);
  }

  // =============================================
  //  MACHINE MANAGEMENT MODAL
  // =============================================

  function openMachinesModal() {
    renderMachinesList();
    $("#machines-modal").classList.remove("hidden");
  }

  function closeMachinesModal() {
    $("#machines-modal").classList.add("hidden");
  }

  function renderMachinesList() {
    const container = $("#machines-list");
    container.innerHTML = "";

    if (machines.length === 0) {
      container.innerHTML = '<div class="select-machine-msg">No machines configured. Add one to get started.</div>';
      return;
    }

    machines.forEach(function (m) {
      const row = document.createElement("div");
      row.className = "machine-row";
      const isOnline = m.status === "online";
      row.innerHTML =
        '<span class="machine-row-icon">' + (m.icon || "&#127827;") + '</span>' +
        '<div class="machine-row-info">' +
          '<div class="machine-row-name">' + escapeHtml(m.name) + '</div>' +
          '<div class="machine-row-detail">' + escapeHtml(m.description || "") + ' &mdash; ' + escapeHtml(m.tailscale_ip || m.ip || "") + '</div>' +
        '</div>' +
        '<span class="machine-row-status"><span class="status-dot ' + (isOnline ? "online" : "offline") + '"></span></span>' +
        '<div class="machine-row-actions">' +
          '<button class="btn btn-sm btn-danger" data-delete-machine="' + escapeAttr(m.id) + '">Delete</button>' +
        '</div>';
      container.appendChild(row);
    });
  }

  function deleteMachine(machineId) {
    const m = getMachine(machineId);
    const name = m ? m.name : machineId;
    if (!confirm("Delete machine \"" + name + "\"? This cannot be undone.")) return;

    apiFetch("/api/machines/" + encodeURIComponent(machineId), { method: "DELETE" })
      .then(function () {
        showToast("Machine deleted", "success");
        if (currentMachine === machineId) {
          currentMachine = "all";
        }
        loadMachines().then(function () {
          renderMachinesList();
          switchSection(currentSection);
        });
      })
      .catch(function () {});
  }

  function openAddMachineModal() {
    $("#add-machine-name").value = "";
    $("#add-machine-desc").value = "";
    $("#add-machine-ip").value = "";
    $("#add-machine-port").value = "3001";
    $("#add-machine-icon").value = "";
    $("#add-machine-modal").classList.remove("hidden");
  }

  function closeAddMachineModal() {
    $("#add-machine-modal").classList.add("hidden");
  }

  function submitAddMachine() {
    const name = $("#add-machine-name").value.trim();
    const description = $("#add-machine-desc").value.trim();
    const ip = $("#add-machine-ip").value.trim();
    const port = parseInt($("#add-machine-port").value, 10) || 3001;
    const icon = $("#add-machine-icon").value.trim();

    if (!name || !ip) {
      showToast("Name and Tailscale IP are required", "error");
      return;
    }

    apiFetch("/api/machines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: name.toLowerCase().replace(/\s+/g, "-"), name: name, description: description, ip: ip, agent_port: port, icon: icon })
    })
      .then(function () {
        showToast("Machine added", "success");
        closeAddMachineModal();
        loadMachines().then(function () {
          renderMachinesList();
        });
      })
      .catch(function () {});
  }

  // =============================================
  //  SECTION SWITCHING
  // =============================================

  function switchSection(name) {
    currentSection = name;
    $$(".section").forEach(function (el) { el.classList.add("hidden"); });
    const target = $("#section-" + name);
    if (target) target.classList.remove("hidden");

    $$(".nav-link").forEach(function (el) { el.classList.remove("active"); });
    const link = document.querySelector('.nav-link[data-section="' + name + '"]');
    if (link) link.classList.add("active");

    // Close sidebar on mobile
    $("#sidebar").classList.remove("open");

    // Stop monitoring timer
    clearInterval(monitoringTimer);
    monitoringTimer = null;

    // Load section data
    switch (name) {
      case "monitoring":
        loadMonitoring();
        monitoringTimer = setInterval(loadMonitoring, 5000);
        break;
      case "services":
        loadServices();
        break;
      case "network":
        loadNetwork();
        break;
      case "files": {
        if (!currentFilePath) {
          const fm = getCurrentMachine();
          currentFilePath = fm && fm.default_path ? fm.default_path : "/";
        }
        loadFiles(currentFilePath);
        break;
      }
      case "terminal":
        loadTerminal();
        break;
      case "updates":
        loadUpdatesSection();
        break;
      case "logs":
        loadLogsSection();
        break;
    }
  }

  // =============================================
  //  SECTION: MONITORING
  // =============================================

  function loadMonitoring() {
    const container = $("#monitoring-content");

    if (currentMachine === "all") {
      loadMonitoringAll(container);
    } else {
      loadMonitoringSingle(container);
    }
  }

  function loadMonitoringAll(container) {
    if (machines.length === 0) {
      container.innerHTML = '<div class="loading-indicator">No machines configured.</div>';
      return;
    }

    // Fetch system data for each machine in parallel
    const promises = machines.map(function (m) {
      if (m.status !== "online") {
        return Promise.resolve({ machine: m, data: null, offline: true });
      }
      return apiFetch(machineApiBase(m.id) + "/system")
        .then(function (data) { return { machine: m, data: data, offline: false }; })
        .catch(function () { return { machine: m, data: null, offline: true }; });
    });

    Promise.all(promises).then(function (results) {
      let html = '<div class="overview-grid">';

      results.forEach(function (r) {
        const m = r.machine;
        const d = r.data;

        if (r.offline || !d) {
          html +=
            '<div class="overview-card offline-card">' +
              '<div class="overview-card-header">' +
                '<span class="overview-card-icon">' + (m.icon || "&#127827;") + '</span>' +
                '<span class="overview-card-name">' + escapeHtml(m.name) + '</span>' +
                '<span class="status-dot offline" style="margin-left: auto;"></span>' +
              '</div>' +
              '<div class="offline-banner">Machine offline</div>' +
            '</div>';
          return;
        }

        const cpu = d.cpu_percent || 0;
        const ram = d.memory && d.memory.percent != null ? d.memory.percent : 0;
        const disk = d.disk && d.disk.percent != null ? d.disk.percent : 0;
        const temp = d.temperature || 0;

        html +=
          '<div class="overview-card" data-select-machine="' + escapeAttr(m.id) + '">' +
            '<div class="overview-card-header">' +
              '<span class="overview-card-icon">' + (m.icon || "&#127827;") + '</span>' +
              '<span class="overview-card-name">' + escapeHtml(m.name) + '</span>' +
              '<span class="status-dot online" style="margin-left: auto;"></span>' +
            '</div>' +
            '<div class="overview-card-metrics">' +
              buildMiniMetric("CPU", cpu, "%", "var(--accent-light)") +
              buildMiniMetric("RAM", ram, "%", "var(--warning)") +
              buildMiniMetric("Disk", disk, "%", "var(--success)") +
              buildMiniMetric("Temp", temp, "\u00B0C", "var(--danger)", true) +
            '</div>' +
            '<div class="overview-card-footer">Uptime: ' + formatUptime(d.uptime_seconds) + '</div>' +
          '</div>';
      });

      html += '</div>';
      container.innerHTML = html;
    });
  }

  function buildMiniMetric(label, value, suffix, color, isTemp) {
    let progress;
    if (isTemp) {
      progress = Math.min((value / 85) * 100, 100);
    } else {
      progress = Math.max(0, Math.min(100, value));
    }
    const display = isTemp ? value.toFixed(1) + suffix : Math.round(value) + suffix;

    return '<div class="overview-metric">' +
      '<div class="progress-ring-mini" style="--progress: ' + progress + '; --ring-color: ' + color + ';">' +
        '<span class="progress-value">' + display + '</span>' +
      '</div>' +
      '<span class="overview-metric-label">' + label + '</span>' +
    '</div>';
  }

  function loadMonitoringSingle(container) {
    const m = getCurrentMachine();
    if (!m) {
      container.innerHTML = '<div class="loading-indicator">Machine not found.</div>';
      return;
    }
    if (m.status !== "online") {
      container.innerHTML =
        '<div class="offline-banner">' +
          '<span class="offline-banner-icon">&#128268;</span>' +
          'Machine "' + escapeHtml(m.name) + '" is offline.' +
        '</div>';
      return;
    }

    apiFetch(machineApiBase(m.id) + "/system")
      .then(function (data) {
        const cpu = data.cpu_percent || 0;
        const ram = data.memory && data.memory.percent != null ? data.memory.percent : 0;
        const disk = data.disk && data.disk.percent != null ? data.disk.percent : 0;
        const temp = data.temperature || 0;
        const tempProgress = Math.min((temp / 85) * 100, 100);
        const swapPercent = data.swap && data.swap.percent != null ? data.swap.percent : null;

        let html =
          '<div class="cards-grid">' +
            buildFullMetric("cpu", cpu, Math.round(cpu) + "%", "var(--accent-light)") +
            buildFullMetric("ram", ram, Math.round(ram) + "%", "var(--warning)") +
            buildFullMetric("disk", disk, Math.round(disk) + "%", "var(--success)") +
            buildFullMetric("temp", tempProgress, temp.toFixed(1) + "\u00B0C", "var(--danger)") +
          '</div>';

        html += '<div class="card info-card"><h3>System Info</h3><div class="info-grid">';

        const infoItems = [
          ["Hostname", data.hostname || "-"],
          ["Platform", data.platform || "-"],
          ["Architecture", data.architecture || "-"],
          ["Kernel", data.platform_release || "-"],
          ["Uptime", formatUptime(data.uptime_seconds)],
          ["Load Average", data.load_average ? data.load_average.map(function (v) { return v.toFixed(2); }).join(", ") : "-"],
          ["CPU Freq", data.cpu_freq ? Math.round(data.cpu_freq) + " MHz" : "-"],
          ["Swap Usage", swapPercent != null ? Math.round(swapPercent) + "%" : "-"]
        ];

        infoItems.forEach(function (item) {
          html += '<div class="info-item"><span class="info-label">' + item[0] + '</span><span class="info-value">' + escapeHtml(String(item[1])) + '</span></div>';
        });

        html += '</div></div>';
        container.innerHTML = html;
      })
      .catch(function () {
        container.innerHTML = '<div class="loading-indicator">Failed to load monitoring data.</div>';
      });
  }

  function buildFullMetric(id, progress, display, color) {
    const clamped = Math.max(0, Math.min(100, progress));
    return '<div class="card metric-card">' +
      '<div class="progress-ring" style="--progress: ' + clamped + '; --ring-color: ' + color + ';">' +
        '<span class="progress-value">' + display + '</span>' +
      '</div>' +
      '<div class="metric-label">' + id.toUpperCase() + '</div>' +
    '</div>';
  }

  // =============================================
  //  SECTION: SERVICES
  // =============================================

  function loadServices() {
    const selectMsg = $("#services-select-msg");
    const card = $("#services-card");

    if (currentMachine === "all") {
      selectMsg.classList.remove("hidden");
      card.classList.add("hidden");
      return;
    }

    selectMsg.classList.add("hidden");
    card.classList.remove("hidden");

    const m = getCurrentMachine();
    if (!m || m.status !== "online") {
      $("#services-body").innerHTML = '<tr><td colspan="4" class="offline-banner">Machine offline</td></tr>';
      return;
    }

    const tbody = $("#services-body");
    tbody.innerHTML = '<tr><td colspan="4" class="loading-indicator">Loading...</td></tr>';

    apiFetch(machineApiBase(m.id) + "/services")
      .then(function (data) {
        servicesList = data.services || data || [];
        tbody.innerHTML = "";
        servicesList.forEach(function (svc) {
          const tr = document.createElement("tr");

          let statusBadge = "badge-unknown";
          const activeStatus = svc.active || svc.status || "unknown";
          if (activeStatus === "active") statusBadge = "badge-active";
          else if (activeStatus === "inactive") statusBadge = "badge-inactive";
          else if (activeStatus === "failed") statusBadge = "badge-failed";

          let enabledBadge = "badge-unknown";
          if (svc.enabled === "enabled" || svc.enabled === true) enabledBadge = "badge-enabled";
          else if (svc.enabled === "disabled" || svc.enabled === false) enabledBadge = "badge-disabled";

          tr.innerHTML =
            '<td>' + escapeHtml(svc.name) + '</td>' +
            '<td><span class="badge ' + statusBadge + '">' + escapeHtml(activeStatus) + '</span></td>' +
            '<td><span class="badge ' + enabledBadge + '">' + escapeHtml(String(svc.enabled || "unknown")) + '</span></td>' +
            '<td class="btn-group">' +
              '<button class="btn btn-sm btn-primary" data-svc="' + escapeAttr(svc.name) + '" data-action="start">Start</button>' +
              '<button class="btn btn-sm btn-danger" data-svc="' + escapeAttr(svc.name) + '" data-action="stop">Stop</button>' +
              '<button class="btn btn-sm" data-svc="' + escapeAttr(svc.name) + '" data-action="restart">Restart</button>' +
            '</td>';
          tbody.appendChild(tr);
        });
      })
      .catch(function () {
        tbody.innerHTML = '<tr><td colspan="4" class="loading-indicator">Failed to load services.</td></tr>';
      });
  }

  function serviceAction(name, action) {
    if (!confirm("Confirm " + action + " for \"" + name + "\"?")) return;

    const m = getCurrentMachine();
    if (!m) return;

    apiFetch(machineApiBase(m.id) + "/services/" + encodeURIComponent(name) + "/" + action, { method: "POST" })
      .then(function () {
        showToast(name + " " + action + " OK", "success");
        loadServices();
      })
      .catch(function () {});
  }

  // =============================================
  //  SECTION: NETWORK
  // =============================================

  function loadNetwork() {
    const container = $("#network-cards");

    if (currentMachine === "all") {
      loadNetworkAll(container);
    } else {
      loadNetworkSingle(container);
    }
  }

  function loadNetworkSingle(container) {
    const m = getCurrentMachine();
    if (!m || m.status !== "online") {
      container.innerHTML = '<div class="offline-banner"><span class="offline-banner-icon">&#128268;</span>Machine offline</div>';
      return;
    }

    container.innerHTML = '<div class="loading-indicator">Loading...</div>';

    apiFetch(machineApiBase(m.id) + "/network")
      .then(function (data) {
        container.innerHTML = "";

        // Interfaces
        const ifaces = data.interfaces || [];
        ifaces.forEach(function (iface) {
          const card = document.createElement("div");
          card.className = "card";
          card.innerHTML =
            '<div class="net-card-title">' + escapeHtml(iface.name) + '</div>' +
            (iface.addresses || []).map(function (a) {
              return '<div class="net-stat"><span class="net-stat-label">IP</span><span>' + escapeHtml(a.ip || String(a)) + '</span></div>' +
                     '<div class="net-stat"><span class="net-stat-label">Netmask</span><span>' + escapeHtml(a.netmask || "-") + '</span></div>';
            }).join("");
          container.appendChild(card);
        });

        // Stats card
        const io = data.io || {};
        const stats = document.createElement("div");
        stats.className = "card";
        stats.innerHTML =
          '<div class="net-card-title">Statistics</div>' +
          '<div class="net-stat"><span class="net-stat-label">Connections</span><span>' + (data.connections || 0) + '</span></div>' +
          '<div class="net-stat"><span class="net-stat-label">Bytes Sent</span><span>' + formatBytes(io.bytes_sent) + '</span></div>' +
          '<div class="net-stat"><span class="net-stat-label">Bytes Recv</span><span>' + formatBytes(io.bytes_recv) + '</span></div>' +
          '<div class="net-stat"><span class="net-stat-label">Packets Sent</span><span>' + (io.packets_sent != null ? io.packets_sent.toLocaleString() : "-") + '</span></div>' +
          '<div class="net-stat"><span class="net-stat-label">Packets Recv</span><span>' + (io.packets_recv != null ? io.packets_recv.toLocaleString() : "-") + '</span></div>';
        container.appendChild(stats);
      })
      .catch(function () {
        container.innerHTML = '<div class="loading-indicator">Failed to load network data.</div>';
      });
  }

  function loadNetworkAll(container) {
    if (machines.length === 0) {
      container.innerHTML = '<div class="loading-indicator">No machines configured.</div>';
      return;
    }

    container.innerHTML = '<div class="loading-indicator">Loading...</div>';

    const promises = machines.map(function (m) {
      if (m.status !== "online") {
        return Promise.resolve({ machine: m, data: null, offline: true });
      }
      return apiFetch(machineApiBase(m.id) + "/network")
        .then(function (data) { return { machine: m, data: data, offline: false }; })
        .catch(function () { return { machine: m, data: null, offline: true }; });
    });

    Promise.all(promises).then(function (results) {
      container.innerHTML = "";

      results.forEach(function (r) {
        const m = r.machine;
        const card = document.createElement("div");
        card.className = "card";

        if (r.offline || !r.data) {
          card.innerHTML =
            '<div class="net-card-title">' + (m.icon || "&#127827;") + ' ' + escapeHtml(m.name) + ' <span class="status-dot offline"></span></div>' +
            '<div style="color: var(--text-muted); font-size: 0.85rem;">Offline</div>';
        } else {
          const d = r.data;
          const dio = d.io || {};
          // Find main IP from interfaces
          const ifaces = d.interfaces || [];
          let mainIp = "-";
          if (ifaces.length > 0 && ifaces[0].addresses && ifaces[0].addresses.length > 0) {
            mainIp = ifaces[0].addresses[0].ip || "-";
          }

          card.innerHTML =
            '<div class="net-card-title">' + (m.icon || "&#127827;") + ' ' + escapeHtml(m.name) + ' <span class="status-dot online"></span></div>' +
            '<div class="net-stat"><span class="net-stat-label">Main IP</span><span>' + escapeHtml(String(mainIp)) + '</span></div>' +
            '<div class="net-stat"><span class="net-stat-label">Bytes Sent</span><span>' + formatBytes(dio.bytes_sent) + '</span></div>' +
            '<div class="net-stat"><span class="net-stat-label">Bytes Recv</span><span>' + formatBytes(dio.bytes_recv) + '</span></div>' +
            '<div class="net-stat"><span class="net-stat-label">Connections</span><span>' + (d.connections || 0) + '</span></div>';
        }
        container.appendChild(card);
      });
    });
  }

  // =============================================
  //  SECTION: FILES
  // =============================================

  function loadFiles(path) {
    const selectMsg = $("#files-select-msg");
    const card = $("#files-card");

    if (currentMachine === "all") {
      selectMsg.classList.remove("hidden");
      card.classList.add("hidden");
      return;
    }

    selectMsg.classList.add("hidden");
    card.classList.remove("hidden");

    const m = getCurrentMachine();
    if (!m || m.status !== "online") {
      $("#files-body").innerHTML = '<tr><td colspan="3" class="offline-banner">Machine offline</td></tr>';
      return;
    }

    currentFilePath = path;
    const tbody = $("#files-body");
    tbody.innerHTML = '<tr><td colspan="3" class="loading-indicator">Loading...</td></tr>';

    // Load drives selector
    loadDrives(m);

    apiFetch(machineApiBase(m.id) + "/files?path=" + encodeURIComponent(path))
      .then(function (data) {
        // Breadcrumbs
        renderBreadcrumbs(path);

        // Files table
        tbody.innerHTML = "";
        const files = data.entries || data.files || data || [];
        files.forEach(function (f) {
          const tr = document.createElement("tr");
          const isDir = f.is_dir || f.type === "directory";
          const isWinPath = path.match(/^[A-Za-z]:\\/);
          const sep = isWinPath ? "\\" : "/";
          const base = (path === "/" || path.match(/^[A-Za-z]:\\$/)) ? path : path + sep;
          const fullPath = base + f.name;

          if (isDir) {
            tr.innerHTML =
              '<td><span class="dir-icon"></span><a href="#" class="file-link" data-dir="' + escapeAttr(fullPath) + '">' + escapeHtml(f.name) + '</a></td>' +
              '<td>-</td>' +
              '<td>' + formatDate(f.modified) + '</td>';
          } else {
            tr.innerHTML =
              '<td><span class="file-icon"></span><a href="#" class="file-link" data-file="' + escapeAttr(fullPath) + '">' + escapeHtml(f.name) + '</a></td>' +
              '<td>' + formatBytes(f.size) + '</td>' +
              '<td>' + formatDate(f.modified) + '</td>';
          }
          tbody.appendChild(tr);
        });
      })
      .catch(function () {
        tbody.innerHTML = '<tr><td colspan="3" class="loading-indicator">Failed to load files.</td></tr>';
      });
  }

  function loadDrives(m) {
    const container = $("#drives-bar");
    if (!container) return;
    apiFetch(machineApiBase(m.id) + "/drives")
      .then(function (data) {
        const drives = data.drives || [];
        if (drives.length <= 1) {
          container.classList.add("hidden");
          return;
        }
        container.classList.remove("hidden");
        container.innerHTML = "";
        drives.forEach(function (d) {
          const btn = document.createElement("button");
          btn.className = "btn btn-sm drive-btn";
          if (currentFilePath && currentFilePath.toLowerCase().startsWith(d.path.toLowerCase())) {
            btn.classList.add("drive-active");
          }
          let label = d.label || d.path;
          if (d.percent != null) {
            label += " (" + Math.round(d.percent) + "%)";
          }
          btn.textContent = label;
          btn.addEventListener("click", function () { loadFiles(d.path); });
          container.appendChild(btn);
        });
      })
      .catch(function () { container.classList.add("hidden"); });
  }

  function renderBreadcrumbs(path) {
    const bc = $("#breadcrumbs");
    bc.innerHTML = "";

    // Detect Windows path (e.g. C:\Users\...)
    const isWinPath = path.match(/^[A-Za-z]:\\/);
    let parts, accumulated;

    if (isWinPath) {
      const drive = path.substring(0, 3); // "C:\"
      parts = path.substring(3).split("\\").filter(Boolean);
      accumulated = drive;

      const rootLink = document.createElement("span");
      rootLink.className = "breadcrumb-link";
      rootLink.textContent = drive;
      rootLink.setAttribute("data-path", drive);
      bc.appendChild(rootLink);
    } else {
      parts = path.split("/").filter(Boolean);
      accumulated = "";

      const rootLink = document.createElement("span");
      rootLink.className = "breadcrumb-link";
      rootLink.textContent = "/";
      rootLink.setAttribute("data-path", "/");
      bc.appendChild(rootLink);
    }

    parts.forEach(function (p, i) {
      accumulated += (isWinPath ? (accumulated.endsWith("\\") ? "" : "\\") : "/") + p;
      const sep = document.createElement("span");
      sep.className = "breadcrumb-sep";
      sep.textContent = " / ";
      bc.appendChild(sep);

      if (i < parts.length - 1) {
        const link = document.createElement("span");
        link.className = "breadcrumb-link";
        link.textContent = p;
        link.setAttribute("data-path", accumulated);
        bc.appendChild(link);
      } else {
        const span = document.createElement("span");
        span.textContent = p;
        bc.appendChild(span);
      }
    });
  }

  function loadFileContent(path) {
    const m = getCurrentMachine();
    if (!m) return;

    editorFilePath = path;
    apiFetch(machineApiBase(m.id) + "/files/content?path=" + encodeURIComponent(path))
      .then(function (data) {
        const content = typeof data === "string" ? data : (data.content || "");
        $("#editor-title").textContent = path;
        $("#editor-content").value = content;
        $("#editor-modal").classList.remove("hidden");
      })
      .catch(function () {});
  }

  function saveFile(path, content) {
    const m = getCurrentMachine();
    if (!m) return;

    apiFetch(machineApiBase(m.id) + "/files/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path, content: content })
    })
      .then(function () {
        showToast("File saved", "success");
        $("#editor-modal").classList.add("hidden");
      })
      .catch(function () {});
  }

  // --- Transfer ---

  function openTransferModal() {
    if (currentMachine === "all") {
      showToast("Select a machine first", "error");
      return;
    }
    // Populate source
    $("#transfer-source").value = editorFilePath || currentFilePath;

    // Populate destination machines (exclude current)
    const select = $("#transfer-dest-machine");
    select.innerHTML = "";
    machines.forEach(function (m) {
      if (m.id === currentMachine) return;
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name + (m.status !== "online" ? " (offline)" : "");
      select.appendChild(opt);
    });

    $("#transfer-dest-path").value = "";
    $("#transfer-modal").classList.remove("hidden");
  }

  function submitTransfer() {
    const source = $("#transfer-source").value;
    const destMachineId = $("#transfer-dest-machine").value;
    const destPath = $("#transfer-dest-path").value.trim();

    if (!destMachineId || !destPath) {
      showToast("Please fill all fields", "error");
      return;
    }

    apiFetch("/api/transfer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_machine: currentMachine,
        source_path: source,
        dest_machine: destMachineId,
        dest_path: destPath
      })
    })
      .then(function () {
        showToast("File transferred", "success");
        $("#transfer-modal").classList.add("hidden");
      })
      .catch(function () {});
  }

  // =============================================
  //  SECTION: TERMINAL
  // =============================================

  function loadTerminal() {
    const selectMsg = $("#terminal-select-msg");
    const warning = $("#terminal-warning");
    const card = $("#terminal-card");

    if (currentMachine === "all") {
      selectMsg.classList.remove("hidden");
      warning.classList.add("hidden");
      card.classList.add("hidden");
      return;
    }

    selectMsg.classList.add("hidden");
    warning.classList.remove("hidden");
    card.classList.remove("hidden");

    // Update prompt
    const m = getCurrentMachine();
    updateTerminalPrompt(m);

    setTimeout(function () { $("#terminal-input").focus(); }, 100);
  }

  function getTerminalCwd(machineId) {
    return terminalCwd[machineId] || null;
  }

  function updateTerminalPrompt(m) {
    if (!m) { $("#terminal-prompt").textContent = "$"; return; }
    const cwd = getTerminalCwd(m.id);
    const cwdDisplay = cwd ? " " + cwd : "";
    $("#terminal-prompt").textContent = m.name + cwdDisplay + " $";
  }

  function runCommand(cmd) {
    if (!cmd.trim()) return;

    const m = getCurrentMachine();
    if (!m) {
      showToast("Select a machine first", "error");
      return;
    }

    if (m.status !== "online") {
      showToast("Machine is offline", "error");
      return;
    }

    // Add to history
    commandHistory.push(cmd);
    historyIndex = commandHistory.length;

    // Show command in output
    const output = $("#terminal-output");
    const cwd = getTerminalCwd(m.id);
    const cmdDiv = document.createElement("div");
    cmdDiv.className = "cmd-line";
    cmdDiv.textContent = m.name + (cwd ? " " + cwd : "") + " $ " + cmd;
    output.appendChild(cmdDiv);

    apiFetch(machineApiBase(m.id) + "/terminal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: cmd, cwd: cwd })
    })
      .then(function (data) {
        // Update cwd if returned
        if (data.cwd) {
          terminalCwd[m.id] = data.cwd;
          updateTerminalPrompt(m);
        }
        const text = typeof data === "string" ? data : (data.stdout || "");
        if (text) {
          const outDiv = document.createElement("div");
          outDiv.className = "cmd-output";
          outDiv.textContent = text;
          output.appendChild(outDiv);
        }
        const err = data.stderr || data.error || "";
        if (err) {
          const errDiv = document.createElement("div");
          errDiv.className = "cmd-error";
          errDiv.textContent = err;
          output.appendChild(errDiv);
        }
        output.scrollTop = output.scrollHeight;
      })
      .catch(function (err) {
        const errDiv = document.createElement("div");
        errDiv.className = "cmd-error";
        errDiv.textContent = err.message;
        output.appendChild(errDiv);
        output.scrollTop = output.scrollHeight;
      });
  }

  // =============================================
  //  SECTION: UPDATES
  // =============================================

  function loadUpdatesSection() {
    const selectMsg = $("#updates-select-msg");
    const card = $("#updates-card");

    if (currentMachine === "all") {
      selectMsg.classList.remove("hidden");
      card.classList.add("hidden");
      return;
    }

    selectMsg.classList.add("hidden");
    card.classList.remove("hidden");
    $("#updates-output").textContent = "";
  }

  function checkUpdates() {
    const m = getCurrentMachine();
    if (!m) { showToast("Select a machine first", "error"); return; }
    if (m.status !== "online") { showToast("Machine is offline", "error"); return; }

    const spinner = $("#updates-spinner");
    const output = $("#updates-output");
    spinner.classList.remove("hidden");
    output.textContent = "Checking for updates...\n";

    apiFetch(machineApiBase(m.id) + "/update/check", { method: "POST" })
      .then(function (data) {
        spinner.classList.add("hidden");
        output.textContent = typeof data === "string" ? data : (data.output || JSON.stringify(data, null, 2));
      })
      .catch(function () {
        spinner.classList.add("hidden");
      });
  }

  function installUpdates() {
    const m = getCurrentMachine();
    if (!m) { showToast("Select a machine first", "error"); return; }
    if (m.status !== "online") { showToast("Machine is offline", "error"); return; }
    if (!confirm("Install all available updates on \"" + m.name + "\"? This may take a while.")) return;

    const spinner = $("#updates-spinner");
    const output = $("#updates-output");
    spinner.classList.remove("hidden");
    output.textContent = "Installing updates...\n";

    apiFetch(machineApiBase(m.id) + "/update/upgrade", { method: "POST" })
      .then(function (data) {
        spinner.classList.add("hidden");
        output.textContent = typeof data === "string" ? data : (data.output || JSON.stringify(data, null, 2));
        showToast("Update complete", "success");
      })
      .catch(function () {
        spinner.classList.add("hidden");
      });
  }

  // =============================================
  //  SECTION: LOGS
  // =============================================

  function loadLogsSection() {
    const selectMsg = $("#logs-select-msg");
    const card = $("#logs-card");

    if (currentMachine === "all") {
      selectMsg.classList.remove("hidden");
      card.classList.add("hidden");
      return;
    }

    selectMsg.classList.add("hidden");
    card.classList.remove("hidden");

    populateLogsDropdown();
    loadLogs($("#logs-service").value);
  }

  function populateLogsDropdown() {
    const select = $("#logs-service");
    const current = select.value;
    let options = '<option value="system">system</option>';
    servicesList.forEach(function (svc) {
      options += '<option value="' + escapeAttr(svc.name) + '">' + escapeHtml(svc.name) + '</option>';
    });
    select.innerHTML = options;
    if (current && select.querySelector('option[value="' + CSS.escape(current) + '"]')) {
      select.value = current;
    }
  }

  function loadLogs(service) {
    const m = getCurrentMachine();
    if (!m) return;
    if (m.status !== "online") {
      $("#logs-output").textContent = "Machine is offline.";
      return;
    }

    const output = $("#logs-output");
    output.textContent = "Loading logs...";
    const lines = $("#logs-lines").value || 100;

    apiFetch(machineApiBase(m.id) + "/logs?service=" + encodeURIComponent(service || "system") + "&lines=" + lines)
      .then(function (data) {
        output.textContent = data.lines ? data.lines.join("\n") : (typeof data === "string" ? data : JSON.stringify(data, null, 2));
        output.scrollTop = output.scrollHeight;
      })
      .catch(function () {
        output.textContent = "Failed to load logs.";
      });
  }

  // =============================================
  //  EVENT LISTENERS
  // =============================================

  function init() {
    // --- Navigation ---
    $$(".nav-link").forEach(function (link) {
      link.addEventListener("click", function (e) {
        e.preventDefault();
        switchSection(this.getAttribute("data-section"));
      });
    });

    // --- Hamburger ---
    $("#hamburger").addEventListener("click", function () {
      $("#sidebar").classList.toggle("open");
    });

    // Close sidebar on click outside (mobile)
    document.addEventListener("click", function (e) {
      const sidebar = $("#sidebar");
      const hamburger = $("#hamburger");
      if (sidebar.classList.contains("open") && !sidebar.contains(e.target) && e.target !== hamburger) {
        sidebar.classList.remove("open");
      }
    });

    // --- Machine Selector ---
    $("#machine-selector").addEventListener("click", function (e) {
      const pill = e.target.closest(".machine-pill");
      if (!pill) return;
      const machineId = pill.getAttribute("data-machine");
      selectMachine(machineId);
    });

    // --- Machine Selector: click on overview card ---
    document.addEventListener("click", function (e) {
      const card = e.target.closest("[data-select-machine]");
      if (!card) return;
      selectMachine(card.getAttribute("data-select-machine"));
    });

    // --- Machine Management ---
    $("#btn-manage-machines").addEventListener("click", function () {
      openMachinesModal();
    });

    $("#machines-modal-close").addEventListener("click", closeMachinesModal);
    $("#machines-modal").addEventListener("click", function (e) {
      if (e.target === this) closeMachinesModal();
    });

    // Delete machine from management list
    $("#machines-list").addEventListener("click", function (e) {
      const btn = e.target.closest("[data-delete-machine]");
      if (!btn) return;
      deleteMachine(btn.getAttribute("data-delete-machine"));
    });

    // Add machine
    $("#btn-add-machine").addEventListener("click", openAddMachineModal);
    $("#add-machine-close").addEventListener("click", closeAddMachineModal);
    $("#add-machine-cancel").addEventListener("click", closeAddMachineModal);
    $("#add-machine-modal").addEventListener("click", function (e) {
      if (e.target === this) closeAddMachineModal();
    });
    $("#add-machine-submit").addEventListener("click", submitAddMachine);

    // --- Services ---
    $("#services-body").addEventListener("click", function (e) {
      const btn = e.target.closest("button[data-svc]");
      if (!btn) return;
      serviceAction(btn.getAttribute("data-svc"), btn.getAttribute("data-action"));
    });

    // --- Files: Breadcrumb clicks ---
    $("#breadcrumbs").addEventListener("click", function (e) {
      const link = e.target.closest(".breadcrumb-link");
      if (!link) return;
      loadFiles(link.getAttribute("data-path"));
    });

    // --- Files: File/dir clicks ---
    $("#files-body").addEventListener("click", function (e) {
      e.preventDefault();
      let link = e.target.closest("[data-dir]");
      if (link) {
        loadFiles(link.getAttribute("data-dir"));
        return;
      }
      link = e.target.closest("[data-file]");
      if (link) {
        loadFileContent(link.getAttribute("data-file"));
      }
    });

    // --- Files: Transfer ---
    $("#btn-transfer").addEventListener("click", openTransferModal);
    $("#transfer-close").addEventListener("click", function () { $("#transfer-modal").classList.add("hidden"); });
    $("#transfer-cancel").addEventListener("click", function () { $("#transfer-modal").classList.add("hidden"); });
    $("#transfer-modal").addEventListener("click", function (e) {
      if (e.target === this) this.classList.add("hidden");
    });
    $("#transfer-submit").addEventListener("click", submitTransfer);

    // --- Editor modal ---
    $("#editor-save").addEventListener("click", function () {
      saveFile(editorFilePath, $("#editor-content").value);
    });
    $("#editor-cancel").addEventListener("click", function () {
      $("#editor-modal").classList.add("hidden");
    });
    $("#editor-close").addEventListener("click", function () {
      $("#editor-modal").classList.add("hidden");
    });
    $("#editor-modal").addEventListener("click", function (e) {
      if (e.target === this) this.classList.add("hidden");
    });

    // --- Terminal ---
    const termInput = $("#terminal-input");
    termInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        const cmd = this.value;
        this.value = "";
        runCommand(cmd);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (historyIndex > 0) {
          historyIndex--;
          this.value = commandHistory[historyIndex];
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (historyIndex < commandHistory.length - 1) {
          historyIndex++;
          this.value = commandHistory[historyIndex];
        } else {
          historyIndex = commandHistory.length;
          this.value = "";
        }
      }
    });

    // --- Updates ---
    $("#btn-check-updates").addEventListener("click", checkUpdates);
    $("#btn-install-updates").addEventListener("click", installUpdates);

    // --- Logs ---
    $("#btn-refresh-logs").addEventListener("click", function () {
      loadLogs($("#logs-service").value);
    });
    $("#logs-service").addEventListener("change", function () {
      loadLogs(this.value);
    });
    $("#logs-lines").addEventListener("change", function () {
      loadLogs($("#logs-service").value);
    });

    // --- Keyboard: Escape closes modals ---
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        $("#editor-modal").classList.add("hidden");
        $("#transfer-modal").classList.add("hidden");
        $("#machines-modal").classList.add("hidden");
        $("#add-machine-modal").classList.add("hidden");
      }
    });

    // --- Initialization ---
    loadMachines().then(function () {
      switchSection("monitoring");
    });

    // Refresh machine statuses every 30 seconds
    statusTimer = setInterval(refreshMachineStatuses, 30000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
