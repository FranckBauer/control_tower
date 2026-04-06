/* ============================================
   Pi Dashboard - Control Center
   ============================================ */
(function() {
  "use strict";

  // ==========================================
  //  STATE
  // ==========================================
  var machines = [];
  var currentMachine = "all";
  var currentSection = "monitoring";
  var commandHistory = [];
  var historyIndex = -1;
  var monitoringTimer = null;
  var statusTimer = null;
  var currentFilePath = "";
  var editorFilePath = "";
  var servicesList = [];
  var terminalCwd = {};

  // ==========================================
  //  DOM HELPERS
  // ==========================================
  var $ = function(sel) { return document.querySelector(sel); };
  var $$ = function(sel) { return document.querySelectorAll(sel); };

  // ==========================================
  //  UTILITIES
  // ==========================================

  function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return "-";
    if (bytes === 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
  }

  function formatUptime(seconds) {
    if (seconds == null) return "-";
    var d = Math.floor(seconds / 86400);
    var h = Math.floor((seconds % 86400) / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var parts = [];
    if (d) parts.push(d + "j");
    if (h) parts.push(h + "h");
    parts.push(m + "m");
    return parts.join(" ");
  }

  function formatDate(isoString) {
    if (!isoString) return "-";
    try {
      var date = new Date(isoString);
      if (isNaN(date.getTime())) return isoString;
      var months = ["janv.", "f\u00e9vr.", "mars", "avr.", "mai", "juin",
                     "juil.", "ao\u00fbt", "sept.", "oct.", "nov.", "d\u00e9c."];
      var day = date.getDate();
      var month = months[date.getMonth()];
      var year = date.getFullYear();
      var hours = String(date.getHours()).padStart(2, "0");
      var minutes = String(date.getMinutes()).padStart(2, "0");
      return day + " " + month + " " + year + " " + hours + ":" + minutes;
    } catch (e) {
      return isoString;
    }
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str || ""));
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return (str || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ==========================================
  //  TOAST SYSTEM
  // ==========================================

  function showToast(message, type) {
    type = type || "info";
    var container = $("#toast-container");
    var toast = document.createElement("div");
    toast.className = "toast toast-" + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function() {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(40px)";
      toast.style.transition = "all 0.3s ease";
      setTimeout(function() { toast.remove(); }, 300);
    }, 4000);
  }

  // ==========================================
  //  API
  // ==========================================

  function apiFetch(url, options) {
    options = options || {};
    return fetch(url, options)
      .then(function(res) {
        if (!res.ok) {
          return res.text().then(function(t) {
            throw new Error(t || "Error " + res.status);
          });
        }
        var ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) return res.json();
        return res.text();
      })
      .catch(function(err) {
        showToast(err.message, "error");
        throw err;
      });
  }

  function apiFetchSilent(url, options) {
    options = options || {};
    return fetch(url, options)
      .then(function(res) {
        if (!res.ok) {
          return res.text().then(function(t) {
            throw new Error(t || "Error " + res.status);
          });
        }
        var ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) return res.json();
        return res.text();
      });
  }

  function machineUrl(machineId) {
    return "/api/m/" + encodeURIComponent(machineId);
  }

  function getMachine(id) {
    return machines.find(function(m) { return m.id === id; });
  }

  function getCurrentMachine() {
    if (currentMachine === "all") return null;
    return getMachine(currentMachine);
  }

  function getOnlineMachines() {
    return machines.filter(function(m) { return m.status === "online"; });
  }

  // ==========================================
  //  MACHINES
  // ==========================================

  function loadMachines() {
    return apiFetch("/api/machines")
      .then(function(data) {
        machines = Array.isArray(data) ? data : (data.machines || []);
        renderMachineSelector();
        updateHeaderMachineName();
        return machines;
      })
      .catch(function() {
        machines = [];
        renderMachineSelector();
      });
  }

  function refreshMachineStatuses() {
    return apiFetchSilent("/api/machines")
      .then(function(data) {
        machines = Array.isArray(data) ? data : (data.machines || []);
        renderMachineSelector();
        updateHeaderMachineName();
      })
      .catch(function() {});
  }

  function renderMachineSelector() {
    var container = $("#machine-selector");
    container.innerHTML = "";

    var allPill = document.createElement("div");
    allPill.className = "machine-pill" + (currentMachine === "all" ? " selected" : "");
    allPill.setAttribute("data-machine", "all");
    allPill.innerHTML =
      '<span class="machine-pill-icon">&#127760;</span>' +
      '<span class="machine-pill-name">All</span>';
    container.appendChild(allPill);

    machines.forEach(function(m) {
      var pill = document.createElement("div");
      pill.className = "machine-pill" + (currentMachine === m.id ? " selected" : "");
      pill.setAttribute("data-machine", m.id);
      var isOnline = m.status === "online";
      pill.innerHTML =
        '<span class="machine-pill-icon">' + (m.icon || "&#127827;") + '</span>' +
        '<span class="machine-pill-name">' + escapeHtml(m.name) + '</span>' +
        '<span class="status-dot ' + (isOnline ? "online" : "offline") + '"></span>';
      container.appendChild(pill);
    });
  }

  function updateHeaderMachineName() {
    var el = $("#current-machine-name");
    if (currentMachine === "all") {
      el.textContent = "All machines";
    } else {
      var m = getCurrentMachine();
      el.textContent = m ? m.name : "Unknown";
    }
  }

  function selectMachine(machineId) {
    currentMachine = machineId;
    var m = getCurrentMachine();
    if (m && m.default_path) {
      currentFilePath = m.default_path;
    } else {
      currentFilePath = "/";
    }
    renderMachineSelector();
    updateHeaderMachineName();
    switchSection(currentSection);
  }

  // ==========================================
  //  MACHINE MANAGEMENT MODALS
  // ==========================================

  function openMachinesModal() {
    $("#machines-modal").classList.remove("hidden");
    renderMachinesList();
  }

  function closeMachinesModal() {
    $("#machines-modal").classList.add("hidden");
  }

  function renderMachinesList() {
    var container = $("#machines-list");
    if (machines.length === 0) {
      container.innerHTML = '<p style="color:var(--text-secondary);">No machines configured.</p>';
      return;
    }
    var html = "";
    machines.forEach(function(m) {
      html +=
        '<div class="machine-row">' +
          '<div class="machine-row-info">' +
            '<span class="machine-row-icon">' + (m.icon || "&#127827;") + '</span>' +
            '<div>' +
              '<div class="machine-row-name">' + escapeHtml(m.name) + '</div>' +
              '<div class="machine-row-details">' + escapeHtml(m.ip) + ':' + m.agent_port +
              ' &mdash; <span class="status-dot ' + (m.status === "online" ? "online" : "offline") + '"></span> ' +
              m.status + '</div>' +
            '</div>' +
          '</div>' +
          '<button class="btn btn-sm btn-danger" data-delete-machine="' + escapeAttr(m.id) + '">Delete</button>' +
        '</div>';
    });
    container.innerHTML = html;
  }

  function deleteMachine(machineId) {
    var m = getMachine(machineId);
    var name = m ? m.name : machineId;
    if (!confirm("Delete machine \"" + name + "\"?")) return;
    apiFetch("/api/machines/" + encodeURIComponent(machineId), { method: "DELETE" })
      .then(function() {
        showToast("Machine deleted", "success");
        if (currentMachine === machineId) {
          currentMachine = "all";
        }
        return loadMachines();
      })
      .then(function() {
        renderMachinesList();
        switchSection(currentSection);
      })
      .catch(function() {});
  }

  function openAddMachineModal() {
    $("#add-machine-id").value = "";
    $("#add-machine-name").value = "";
    $("#add-machine-desc").value = "";
    $("#add-machine-ip").value = "";
    $("#add-machine-port").value = "3001";
    $("#add-machine-icon").value = "";
    $("#add-machine-path").value = "/";
    $("#add-machine-modal").classList.remove("hidden");
  }

  function closeAddMachineModal() {
    $("#add-machine-modal").classList.add("hidden");
  }

  function submitAddMachine() {
    var id = $("#add-machine-id").value.trim();
    var name = $("#add-machine-name").value.trim();
    var ip = $("#add-machine-ip").value.trim();

    if (!id || !name || !ip) {
      showToast("ID, Name and IP are required", "error");
      return;
    }

    var body = {
      id: id,
      name: name,
      description: $("#add-machine-desc").value.trim(),
      ip: ip,
      agent_port: parseInt($("#add-machine-port").value, 10) || 3001,
      icon: $("#add-machine-icon").value.trim() || "\uD83C\uDF53",
      default_path: $("#add-machine-path").value.trim() || "/"
    };

    apiFetch("/api/machines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function() {
        showToast("Machine added", "success");
        closeAddMachineModal();
        return loadMachines();
      })
      .then(function() {
        renderMachinesList();
      })
      .catch(function() {});
  }

  // ==========================================
  //  SECTION SWITCHING
  // ==========================================

  function switchSection(name) {
    currentSection = name;

    $$(".section").forEach(function(el) { el.classList.add("hidden"); });
    var target = $("#section-" + name);
    if (target) target.classList.remove("hidden");

    $$(".nav-link").forEach(function(link) {
      if (link.dataset.section === name) {
        link.classList.add("active");
      } else {
        link.classList.remove("active");
      }
    });

    if (monitoringTimer) {
      clearInterval(monitoringTimer);
      monitoringTimer = null;
    }

    switch (name) {
      case "monitoring":
        loadMonitoring();
        monitoringTimer = setInterval(loadMonitoring, 15000);
        break;
      case "services":
        loadServices();
        break;
      case "network":
        loadNetwork();
        break;
      case "files":
        loadFiles(currentFilePath || "/");
        break;
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

    // Close sidebar on mobile
    $("#sidebar").classList.remove("open");
  }

  // ==========================================
  //  MONITORING
  // ==========================================

  function loadMonitoring() {
    if (currentMachine === "all") {
      loadMonitoringAll();
    } else {
      loadMonitoringSingle();
    }
  }

  function loadMonitoringAll() {
    var container = $("#monitoring-content");
    var onlineMachines = getOnlineMachines();
    var offlineMachines = machines.filter(function(m) { return m.status !== "online"; });

    if (machines.length === 0) {
      container.innerHTML = '<p class="text-secondary">No machines configured.</p>';
      return;
    }

    var promises = onlineMachines.map(function(m) {
      return apiFetchSilent(machineUrl(m.id) + "/system")
        .then(function(data) { return { machine: m, data: data, error: false }; })
        .catch(function() { return { machine: m, data: null, error: true }; });
    });

    Promise.all(promises).then(function(results) {
      var html = '<div class="overview-grid">';

      results.forEach(function(r) {
        var m = r.machine;
        var d = r.data;
        var cpuVal = d ? Math.round(d.cpu_percent || 0) : 0;
        var ramVal = d && d.memory ? Math.round(d.memory.percent || 0) : 0;
        var diskVal = d && d.disk ? Math.round(d.disk.percent || 0) : 0;
        var tempVal = d && d.temperature != null ? Math.round(d.temperature) : null;
        var uptimeStr = d ? formatUptime(d.uptime_seconds) : "-";

        html +=
          '<div class="overview-card" data-select-machine="' + escapeAttr(m.id) + '">' +
            '<div class="overview-card-header">' +
              '<span class="overview-card-icon">' + (m.icon || "&#127827;") + '</span>' +
              '<span class="overview-card-name">' + escapeHtml(m.name) + '</span>' +
              '<span class="status-dot online"></span>' +
            '</div>' +
            '<div class="overview-metrics">' +
              buildMiniRing("CPU", cpuVal, cpuVal + "%", metricColor(cpuVal)) +
              buildMiniRing("RAM", ramVal, ramVal + "%", metricColor(ramVal)) +
              buildMiniRing("Disk", diskVal, diskVal + "%", metricColor(diskVal)) +
              buildMiniRing("Temp", tempVal != null ? tempVal : 0, tempVal != null ? tempVal + "\u00b0C" : "N/A", tempVal != null ? metricColor(tempVal > 80 ? 90 : tempVal) : "#888") +
            '</div>' +
            '<div class="overview-card-footer">Uptime: ' + escapeHtml(uptimeStr) + '</div>' +
          '</div>';
      });

      offlineMachines.forEach(function(m) {
        html +=
          '<div class="overview-card overview-card-offline" data-select-machine="' + escapeAttr(m.id) + '">' +
            '<div class="overview-card-header">' +
              '<span class="overview-card-icon">' + (m.icon || "&#127827;") + '</span>' +
              '<span class="overview-card-name">' + escapeHtml(m.name) + '</span>' +
              '<span class="status-dot offline"></span>' +
            '</div>' +
            '<div class="overview-offline-banner">Offline</div>' +
          '</div>';
      });

      html += '</div>';
      container.innerHTML = html;
    });
  }

  function loadMonitoringSingle() {
    var container = $("#monitoring-content");
    var m = getCurrentMachine();
    if (!m) return;

    if (m.status !== "online") {
      container.innerHTML = '<p class="text-secondary">Machine is offline.</p>';
      return;
    }

    apiFetchSilent(machineUrl(m.id) + "/system")
      .then(function(d) {
        var cpuVal = Math.round(d.cpu_percent || 0);
        var ramVal = d.memory ? Math.round(d.memory.percent || 0) : 0;
        var diskVal = d.disk ? Math.round(d.disk.percent || 0) : 0;
        var tempVal = d.temperature != null ? Math.round(d.temperature) : null;
        var tempDisplay = tempVal != null ? tempVal + "\u00b0C" : "N/A";
        var tempPct = tempVal != null ? Math.min(tempVal, 100) : 0;

        var html = '<div class="metrics-rings">';
        html += buildProgressRing(cpuVal, cpuVal + "%", metricColor(cpuVal), "CPU");
        html += buildProgressRing(ramVal, ramVal + "%", metricColor(ramVal), "RAM");
        html += buildProgressRing(diskVal, diskVal + "%", metricColor(diskVal), "Disk");
        html += buildProgressRing(tempPct, tempDisplay, tempVal != null ? metricColor(tempVal > 80 ? 90 : tempVal) : "#888", "Temp");
        html += '</div>';

        var loadAvg = d.load_average || [0, 0, 0];
        var swapPct = d.swap ? d.swap.percent : null;
        var swapStr = swapPct != null ? swapPct.toFixed(1) + "%" : "N/A";
        if (d.swap && d.swap.total != null) {
          swapStr += " (" + formatBytes(d.swap.used) + " / " + formatBytes(d.swap.total) + ")";
        }

        html +=
          '<div class="system-info-grid">' +
            buildInfoItem("Hostname", d.hostname || "-") +
            buildInfoItem("Platform", d.platform || "-") +
            buildInfoItem("Architecture", d.architecture || "-") +
            buildInfoItem("Kernel", d.platform_release || "-") +
            buildInfoItem("Uptime", formatUptime(d.uptime_seconds)) +
            buildInfoItem("Load Average", loadAvg.map(function(v) { return v.toFixed(2); }).join(", ")) +
            buildInfoItem("CPU Freq", d.cpu_freq ? d.cpu_freq + " MHz" : "-") +
            buildInfoItem("CPU Count", d.cpu_count != null ? d.cpu_count : "-") +
            buildInfoItem("Memory", d.memory ? formatBytes(d.memory.total) : "-") +
            buildInfoItem("Disk", d.disk ? formatBytes(d.disk.total) : "-") +
            buildInfoItem("Swap", swapStr) +
          '</div>';

        container.innerHTML = html;
      })
      .catch(function() {
        container.innerHTML = '<p class="text-secondary">Failed to load system data.</p>';
      });
  }

  function metricColor(value) {
    if (value < 50) return "#4caf50";
    if (value < 75) return "#ff9800";
    return "#f44336";
  }

  function buildInfoItem(label, value) {
    return '<div class="info-item"><span class="info-label">' + escapeHtml(label) + '</span><span class="info-value">' + escapeHtml(String(value)) + '</span></div>';
  }

  function buildProgressRing(value, display, color, label) {
    var radius = 54;
    var circumference = 2 * Math.PI * radius;
    var offset = circumference - (value / 100) * circumference;

    return '<div class="metric-card">' +
      '<svg class="progress-ring" viewBox="0 0 120 120">' +
        '<circle class="progress-ring-bg" cx="60" cy="60" r="' + radius + '" />' +
        '<circle class="progress-ring-fill" cx="60" cy="60" r="' + radius + '" ' +
          'stroke="' + color + '" ' +
          'stroke-dasharray="' + circumference + '" ' +
          'stroke-dashoffset="' + offset + '" />' +
        '<text x="60" y="60" text-anchor="middle" dominant-baseline="central" class="progress-ring-text">' + escapeHtml(display) + '</text>' +
      '</svg>' +
      '<div class="metric-label">' + escapeHtml(label) + '</div>' +
    '</div>';
  }

  function buildMiniRing(label, value, display, color) {
    var radius = 20;
    var circumference = 2 * Math.PI * radius;
    var pct = Math.max(0, Math.min(100, value || 0));
    var offset = circumference - (pct / 100) * circumference;

    return '<div class="mini-metric">' +
      '<svg class="mini-ring" viewBox="0 0 48 48">' +
        '<circle class="progress-ring-bg" cx="24" cy="24" r="' + radius + '" />' +
        '<circle class="progress-ring-fill" cx="24" cy="24" r="' + radius + '" ' +
          'stroke="' + color + '" ' +
          'stroke-dasharray="' + circumference + '" ' +
          'stroke-dashoffset="' + offset + '" />' +
        '<text x="24" y="24" text-anchor="middle" dominant-baseline="central" class="mini-ring-text">' + escapeHtml(display) + '</text>' +
      '</svg>' +
      '<div class="mini-metric-label">' + escapeHtml(label) + '</div>' +
    '</div>';
  }

  // ==========================================
  //  SERVICES
  // ==========================================

  function loadServices() {
    var selectMsg = $("#services-select-msg");
    var card = $("#services-card");

    if (currentMachine === "all") {
      selectMsg.classList.remove("hidden");
      card.classList.add("hidden");
      return;
    }

    selectMsg.classList.add("hidden");
    card.classList.remove("hidden");

    var m = getCurrentMachine();
    if (!m || m.status !== "online") {
      $("#services-body").innerHTML = '<tr><td colspan="4">Machine is offline.</td></tr>';
      return;
    }

    apiFetch(machineUrl(m.id) + "/services")
      .then(function(data) {
        var services = Array.isArray(data) ? data : (data.services || []);
        servicesList = services;
        var tbody = $("#services-body");

        if (services.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4">No services found.</td></tr>';
          return;
        }

        var html = "";
        services.forEach(function(svc) {
          var activeBadge = statusBadge(svc.active, "active");
          var enabledBadge = statusBadge(svc.enabled, "enabled");

          html +=
            '<tr>' +
              '<td>' + escapeHtml(svc.name) + '</td>' +
              '<td>' + activeBadge + '</td>' +
              '<td>' + enabledBadge + '</td>' +
              '<td class="service-actions">' +
                '<button class="btn btn-sm btn-primary" data-svc="' + escapeAttr(svc.name) + '" data-action="start">Start</button>' +
                '<button class="btn btn-sm" data-svc="' + escapeAttr(svc.name) + '" data-action="stop">Stop</button>' +
                '<button class="btn btn-sm" data-svc="' + escapeAttr(svc.name) + '" data-action="restart">Restart</button>' +
              '</td>' +
            '</tr>';
        });

        tbody.innerHTML = html;
      })
      .catch(function() {
        $("#services-body").innerHTML = '<tr><td colspan="4">Failed to load services.</td></tr>';
      });
  }

  function statusBadge(value, type) {
    var cls = "badge badge-unknown";
    var text = value || "unknown";

    if (type === "active") {
      if (value === "active") cls = "badge badge-active";
      else if (value === "inactive") cls = "badge badge-inactive";
      else cls = "badge badge-unknown";
    } else if (type === "enabled") {
      if (value === "enabled") cls = "badge badge-enabled";
      else if (value === "disabled") cls = "badge badge-disabled";
      else if (value === "manual") cls = "badge badge-manual";
      else cls = "badge badge-unknown";
    }

    return '<span class="' + cls + '">' + escapeHtml(text) + '</span>';
  }

  function serviceAction(name, action) {
    if (!confirm(action.charAt(0).toUpperCase() + action.slice(1) + " service \"" + name + "\"?")) return;

    var m = getCurrentMachine();
    if (!m) return;

    apiFetch(machineUrl(m.id) + "/services/" + encodeURIComponent(name) + "/" + encodeURIComponent(action), {
      method: "POST"
    })
      .then(function(data) {
        showToast(data.message || "Action completed", "success");
        loadServices();
      })
      .catch(function() {});
  }

  // ==========================================
  //  NETWORK
  // ==========================================

  function loadNetwork() {
    if (currentMachine === "all") {
      loadNetworkAll();
    } else {
      loadNetworkSingle();
    }
  }

  function loadNetworkSingle() {
    var container = $("#network-cards");
    var m = getCurrentMachine();
    if (!m || m.status !== "online") {
      container.innerHTML = '<p class="text-secondary">Machine is offline.</p>';
      return;
    }

    container.innerHTML = '<div class="loading-indicator">Loading...</div>';

    apiFetch(machineUrl(m.id) + "/network")
      .then(function(data) {
        var html = '<div class="network-grid">';

        // Interface cards
        var interfaces = data.interfaces || [];
        interfaces.forEach(function(iface) {
          html += '<div class="card">';
          html += '<h3>' + escapeHtml(iface.name) + '</h3>';
          var addrs = iface.addresses || [];
          if (addrs.length === 0) {
            html += '<p class="text-secondary">No addresses</p>';
          } else {
            addrs.forEach(function(addr) {
              html += '<div class="network-addr">' +
                '<span class="network-ip">' + escapeHtml(addr.ip) + '</span>' +
                '<span class="network-netmask">/ ' + escapeHtml(addr.netmask || "") + '</span>' +
              '</div>';
            });
          }
          html += '</div>';
        });

        // Statistics card
        var io = data.io || {};
        html += '<div class="card">';
        html += '<h3>Statistics</h3>';
        html += '<div class="network-stats">';
        html += buildInfoItem("Connections", data.connections != null ? data.connections : "-");
        html += buildInfoItem("Bytes Sent", formatBytes(io.bytes_sent));
        html += buildInfoItem("Bytes Recv", formatBytes(io.bytes_recv));
        html += buildInfoItem("Packets Sent", io.packets_sent != null ? io.packets_sent.toLocaleString() : "-");
        html += buildInfoItem("Packets Recv", io.packets_recv != null ? io.packets_recv.toLocaleString() : "-");
        html += '</div>';
        html += '</div>';

        html += '</div>';
        container.innerHTML = html;
      })
      .catch(function() {
        container.innerHTML = '<p class="text-secondary">Failed to load network data.</p>';
      });
  }

  function loadNetworkAll() {
    var container = $("#network-cards");
    var onlineMachines = getOnlineMachines();

    if (onlineMachines.length === 0) {
      container.innerHTML = '<p class="text-secondary">No online machines.</p>';
      return;
    }

    container.innerHTML = '<div class="loading-indicator">Loading...</div>';

    var promises = onlineMachines.map(function(m) {
      return apiFetchSilent(machineUrl(m.id) + "/network")
        .then(function(data) { return { machine: m, data: data }; })
        .catch(function() { return { machine: m, data: null }; });
    });

    Promise.all(promises).then(function(results) {
      var html = '<div class="network-grid">';

      results.forEach(function(r) {
        var m = r.machine;
        var d = r.data;
        var io = d ? (d.io || {}) : {};
        var interfaces = d ? (d.interfaces || []) : [];
        var mainIp = "-";
        for (var i = 0; i < interfaces.length; i++) {
          var addrs = interfaces[i].addresses || [];
          for (var j = 0; j < addrs.length; j++) {
            if (addrs[j].ip && addrs[j].ip !== "127.0.0.1" && addrs[j].ip !== "::1") {
              mainIp = addrs[j].ip;
              break;
            }
          }
          if (mainIp !== "-") break;
        }

        html +=
          '<div class="card">' +
            '<div class="network-machine-header">' +
              '<span>' + (m.icon || "&#127827;") + '</span> ' +
              '<strong>' + escapeHtml(m.name) + '</strong>' +
            '</div>' +
            '<div class="network-stats">' +
              buildInfoItem("IP", mainIp) +
              buildInfoItem("Sent", formatBytes(io.bytes_sent)) +
              buildInfoItem("Recv", formatBytes(io.bytes_recv)) +
            '</div>' +
          '</div>';
      });

      html += '</div>';
      container.innerHTML = html;
    });
  }

  // ==========================================
  //  FILES
  // ==========================================

  function loadFiles(path) {
    var selectMsg = $("#files-select-msg");
    var card = $("#files-card");
    var drivesBar = $("#drives-bar");

    if (currentMachine === "all") {
      selectMsg.classList.remove("hidden");
      card.classList.add("hidden");
      drivesBar.classList.add("hidden");
      return;
    }

    selectMsg.classList.add("hidden");
    card.classList.remove("hidden");

    var m = getCurrentMachine();
    if (!m || m.status !== "online") {
      $("#files-body").innerHTML = '<tr><td colspan="3">Machine is offline.</td></tr>';
      drivesBar.classList.add("hidden");
      return;
    }

    path = path || m.default_path || "/";
    currentFilePath = path;

    loadDrives(m);

    apiFetch(machineUrl(m.id) + "/files?path=" + encodeURIComponent(path))
      .then(function(data) {
        var actualPath = data.path || path;
        currentFilePath = actualPath;
        renderBreadcrumbs(actualPath);

        var entries = data.entries || [];
        var tbody = $("#files-body");

        if (entries.length === 0) {
          tbody.innerHTML = '<tr><td colspan="3">Empty directory</td></tr>';
          return;
        }

        var isWindows = /^[A-Za-z]:\\/.test(actualPath);
        var sep = isWindows ? "\\" : "/";

        var html = "";
        entries.forEach(function(entry) {
          var fullPath;
          if (isWindows) {
            fullPath = actualPath.replace(/\\$/, "") + "\\" + entry.name;
          } else {
            fullPath = actualPath === "/" ? "/" + entry.name : actualPath.replace(/\/$/, "") + "/" + entry.name;
          }

          if (entry.is_dir) {
            html +=
              '<tr class="file-row file-dir" data-dir="' + escapeAttr(fullPath) + '">' +
                '<td>&#128193; ' + escapeHtml(entry.name) + '</td>' +
                '<td>-</td>' +
                '<td>' + formatDate(entry.modified) + '</td>' +
              '</tr>';
          } else {
            html +=
              '<tr class="file-row file-file" data-file="' + escapeAttr(fullPath) + '">' +
                '<td>&#128196; ' + escapeHtml(entry.name) + '</td>' +
                '<td>' + formatBytes(entry.size) + '</td>' +
                '<td>' + formatDate(entry.modified) + '</td>' +
              '</tr>';
          }
        });

        tbody.innerHTML = html;
      })
      .catch(function() {
        $("#files-body").innerHTML = '<tr><td colspan="3">Failed to load files.</td></tr>';
      });
  }

  function loadDrives(machine) {
    var drivesBar = $("#drives-bar");

    apiFetchSilent(machineUrl(machine.id) + "/drives")
      .then(function(data) {
        var drives = data.drives || [];
        if (drives.length <= 1) {
          drivesBar.classList.add("hidden");
          return;
        }

        drivesBar.classList.remove("hidden");
        var html = "";
        drives.forEach(function(drive) {
          var isActive = currentFilePath.indexOf(drive.path) === 0;
          var label = drive.label || drive.path;
          var info = drive.percent != null ? " (" + drive.percent + "%)" : "";
          html +=
            '<button class="drive-btn' + (isActive ? " active" : "") + '" data-path="' + escapeAttr(drive.path) + '">' +
              escapeHtml(label) + info +
            '</button>';
        });
        drivesBar.innerHTML = html;

        // Drive click events
        drivesBar.querySelectorAll(".drive-btn").forEach(function(btn) {
          btn.addEventListener("click", function() {
            loadFiles(btn.dataset.path);
          });
        });
      })
      .catch(function() {
        drivesBar.classList.add("hidden");
      });
  }

  function renderBreadcrumbs(path) {
    var container = $("#breadcrumbs");
    var isWindows = /^[A-Za-z]:\\/.test(path);
    var html = "";

    if (isWindows) {
      var parts = path.split("\\").filter(function(p) { return p !== ""; });
      // First part is drive letter like "C:"
      var accumulated = "";
      parts.forEach(function(part, i) {
        if (i === 0) {
          accumulated = part + "\\";
        } else {
          accumulated += part + "\\";
        }
        if (i < parts.length - 1) {
          html += '<a class="breadcrumb-link" data-path="' + escapeAttr(accumulated) + '">' + escapeHtml(part) + '</a>';
          html += '<span class="breadcrumb-sep">\\</span>';
        } else {
          html += '<span class="breadcrumb-current">' + escapeHtml(part) + '</span>';
        }
      });
    } else {
      html += '<a class="breadcrumb-link" data-path="/">/</a>';
      var parts = path.split("/").filter(function(p) { return p !== ""; });
      var accumulated = "";
      parts.forEach(function(part, i) {
        accumulated += "/" + part;
        if (i < parts.length - 1) {
          html += '<a class="breadcrumb-link" data-path="' + escapeAttr(accumulated) + '">' + escapeHtml(part) + '</a>';
          html += '<span class="breadcrumb-sep">/</span>';
        } else {
          html += '<span class="breadcrumb-current">' + escapeHtml(part) + '</span>';
        }
      });
    }

    container.innerHTML = html;
  }

  function loadFileContent(path) {
    var m = getCurrentMachine();
    if (!m) return;

    apiFetch(machineUrl(m.id) + "/files/content?path=" + encodeURIComponent(path))
      .then(function(data) {
        editorFilePath = data.path || path;
        $("#editor-title").textContent = "Edit: " + editorFilePath;
        $("#editor-content").value = data.content || "";
        $("#editor-modal").classList.remove("hidden");
      })
      .catch(function() {});
  }

  function saveFile(path, content) {
    var m = getCurrentMachine();
    if (!m) return;

    apiFetch(machineUrl(m.id) + "/files/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path, content: content })
    })
      .then(function(data) {
        showToast(data.message || "File saved", "success");
        $("#editor-modal").classList.add("hidden");
      })
      .catch(function() {});
  }

  function openTransferModal() {
    var m = getCurrentMachine();
    if (!m) {
      showToast("Select a machine first", "error");
      return;
    }

    // Set source to the current file path
    $("#transfer-source").value = currentFilePath;

    // Populate destination machine dropdown
    var select = $("#transfer-dest-machine");
    var html = "";
    machines.forEach(function(mach) {
      if (mach.id !== m.id) {
        html += '<option value="' + escapeAttr(mach.id) + '">' + escapeHtml(mach.name) + '</option>';
      }
    });
    select.innerHTML = html;
    $("#transfer-dest-path").value = "";

    $("#transfer-modal").classList.remove("hidden");
  }

  function submitTransfer() {
    var m = getCurrentMachine();
    if (!m) return;

    var sourcePath = $("#transfer-source").value.trim();
    var destMachine = $("#transfer-dest-machine").value;
    var destPath = $("#transfer-dest-path").value.trim();

    if (!sourcePath || !destMachine || !destPath) {
      showToast("All fields are required", "error");
      return;
    }

    apiFetch("/api/transfer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_machine: m.id,
        source_path: sourcePath,
        dest_machine: destMachine,
        dest_path: destPath
      })
    })
      .then(function(data) {
        showToast(data.message || "Transfer completed", "success");
        $("#transfer-modal").classList.add("hidden");
      })
      .catch(function() {});
  }

  // ==========================================
  //  TERMINAL
  // ==========================================

  function loadTerminal() {
    var selectMsg = $("#terminal-select-msg");
    var warning = $("#terminal-warning");
    var card = $("#terminal-card");

    if (currentMachine === "all") {
      selectMsg.classList.remove("hidden");
      warning.classList.add("hidden");
      card.classList.add("hidden");
      return;
    }

    selectMsg.classList.add("hidden");
    warning.classList.remove("hidden");
    card.classList.remove("hidden");

    var m = getCurrentMachine();
    if (m) {
      updateTerminalPrompt(m);
      $("#terminal-input").focus();
    }
  }

  function getTerminalCwd(machineId) {
    return terminalCwd[machineId] || null;
  }

  function updateTerminalPrompt(machine) {
    var cwd = getTerminalCwd(machine.id);
    var prompt = escapeHtml(machine.name);
    if (cwd) prompt += " " + escapeHtml(cwd);
    prompt += " $";
    $("#terminal-prompt").textContent = prompt;
  }

  function runCommand(cmd) {
    if (!cmd || !cmd.trim()) return;

    var m = getCurrentMachine();
    if (!m) return;

    // Add to history
    commandHistory.push(cmd);
    historyIndex = commandHistory.length;

    var output = $("#terminal-output");
    var cwd = getTerminalCwd(m.id);

    // Show the command
    var cmdDiv = document.createElement("div");
    cmdDiv.className = "cmd-line";
    var promptText = m.name;
    if (cwd) promptText += " " + cwd;
    promptText += " $ " + cmd;
    cmdDiv.textContent = promptText;
    output.appendChild(cmdDiv);

    var body = { command: cmd };
    if (cwd) body.cwd = cwd;

    apiFetch(machineUrl(m.id) + "/terminal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function(data) {
        if (data.stdout) {
          var stdoutDiv = document.createElement("div");
          stdoutDiv.className = "cmd-output";
          stdoutDiv.textContent = data.stdout;
          output.appendChild(stdoutDiv);
        }
        if (data.stderr) {
          var stderrDiv = document.createElement("div");
          stderrDiv.className = "cmd-error";
          stderrDiv.textContent = data.stderr;
          output.appendChild(stderrDiv);
        }
        if (data.cwd) {
          terminalCwd[m.id] = data.cwd;
        }
        updateTerminalPrompt(m);
        output.scrollTop = output.scrollHeight;
      })
      .catch(function(err) {
        var errDiv = document.createElement("div");
        errDiv.className = "cmd-error";
        errDiv.textContent = "Error: " + err.message;
        output.appendChild(errDiv);
        output.scrollTop = output.scrollHeight;
      });
  }

  // ==========================================
  //  UPDATES
  // ==========================================

  function loadUpdatesSection() {
    var selectMsg = $("#updates-select-msg");
    var card = $("#updates-card");

    if (currentMachine === "all") {
      selectMsg.classList.remove("hidden");
      card.classList.add("hidden");
      return;
    }

    selectMsg.classList.add("hidden");
    card.classList.remove("hidden");
    $("#updates-output").textContent = "";
    $("#updates-spinner").classList.add("hidden");
  }

  function checkUpdates() {
    var m = getCurrentMachine();
    if (!m) return;

    var spinner = $("#updates-spinner");
    var outputEl = $("#updates-output");
    spinner.classList.remove("hidden");
    outputEl.textContent = "Checking for updates...";

    apiFetch(machineUrl(m.id) + "/update/check", { method: "POST" })
      .then(function(data) {
        spinner.classList.add("hidden");
        outputEl.textContent = data.output || "No output";
        if (data.success) {
          showToast("Update check completed", "success");
        }
      })
      .catch(function() {
        spinner.classList.add("hidden");
        outputEl.textContent = "Failed to check updates.";
      });
  }

  function installUpdates() {
    if (!confirm("Install updates? This may take a while and could require a reboot.")) return;

    var m = getCurrentMachine();
    if (!m) return;

    var spinner = $("#updates-spinner");
    var outputEl = $("#updates-output");
    spinner.classList.remove("hidden");
    outputEl.textContent = "Installing updates...";

    apiFetch(machineUrl(m.id) + "/update/upgrade", { method: "POST" })
      .then(function(data) {
        spinner.classList.add("hidden");
        outputEl.textContent = data.output || "No output";
        if (data.success) {
          showToast("Updates installed successfully", "success");
        } else {
          showToast("Update may have encountered issues", "error");
        }
      })
      .catch(function() {
        spinner.classList.add("hidden");
        outputEl.textContent = "Failed to install updates.";
      });
  }

  // ==========================================
  //  LOGS
  // ==========================================

  function loadLogsSection() {
    var selectMsg = $("#logs-select-msg");
    var card = $("#logs-card");

    if (currentMachine === "all") {
      selectMsg.classList.remove("hidden");
      card.classList.add("hidden");
      return;
    }

    selectMsg.classList.add("hidden");
    card.classList.remove("hidden");

    populateLogsDropdown();

    var service = $("#logs-service").value || "system";
    loadLogs(service);
  }

  function populateLogsDropdown() {
    var select = $("#logs-service");
    var html = '<option value="system">system</option>';
    servicesList.forEach(function(svc) {
      if (svc.name !== "system") {
        html += '<option value="' + escapeAttr(svc.name) + '">' + escapeHtml(svc.name) + '</option>';
      }
    });
    select.innerHTML = html;
  }

  function loadLogs(service) {
    var m = getCurrentMachine();
    if (!m) return;

    var lines = $("#logs-lines").value || "100";
    var outputEl = $("#logs-output");
    outputEl.textContent = "Loading logs...";

    apiFetch(machineUrl(m.id) + "/logs?service=" + encodeURIComponent(service) + "&lines=" + encodeURIComponent(lines))
      .then(function(data) {
        var logLines = data.lines || [];
        outputEl.textContent = logLines.join("\n") || "No logs found.";
        outputEl.scrollTop = outputEl.scrollHeight;
      })
      .catch(function() {
        outputEl.textContent = "Failed to load logs.";
      });
  }

  // ==========================================
  //  EVENT LISTENERS & INIT
  // ==========================================

  function init() {
    // Navigation clicks
    $$(".nav-link").forEach(function(link) {
      link.addEventListener("click", function(e) {
        e.preventDefault();
        switchSection(link.dataset.section);
      });
    });

    // Hamburger toggle
    $("#hamburger").addEventListener("click", function() {
      $("#sidebar").classList.toggle("open");
    });

    // Close sidebar on click outside (mobile)
    document.addEventListener("click", function(e) {
      var sb = $("#sidebar");
      if (sb.classList.contains("open") && !sb.contains(e.target) && e.target !== $("#hamburger")) {
        sb.classList.remove("open");
      }
    });

    // Machine selector clicks (event delegation)
    $("#machine-selector").addEventListener("click", function(e) {
      var pill = e.target.closest(".machine-pill");
      if (pill) selectMachine(pill.dataset.machine);
    });

    // Overview card clicks -> select machine
    document.addEventListener("click", function(e) {
      var card = e.target.closest("[data-select-machine]");
      if (card) selectMachine(card.dataset.selectMachine);
    });

    // Machine management
    $("#btn-manage-machines").addEventListener("click", openMachinesModal);
    $("#machines-modal-close").addEventListener("click", closeMachinesModal);
    $("#machines-modal").addEventListener("click", function(e) {
      if (e.target === e.currentTarget) closeMachinesModal();
    });
    $("#machines-list").addEventListener("click", function(e) {
      var btn = e.target.closest("[data-delete-machine]");
      if (btn) deleteMachine(btn.dataset.deleteMachine);
    });
    $("#btn-add-machine").addEventListener("click", openAddMachineModal);
    $("#add-machine-close").addEventListener("click", closeAddMachineModal);
    $("#add-machine-cancel").addEventListener("click", closeAddMachineModal);
    $("#add-machine-modal").addEventListener("click", function(e) {
      if (e.target === e.currentTarget) closeAddMachineModal();
    });
    $("#add-machine-submit").addEventListener("click", submitAddMachine);

    // Services action buttons (delegation)
    $("#services-body").addEventListener("click", function(e) {
      var btn = e.target.closest("button[data-svc]");
      if (btn) serviceAction(btn.dataset.svc, btn.dataset.action);
    });

    // Files: breadcrumb clicks
    $("#breadcrumbs").addEventListener("click", function(e) {
      var link = e.target.closest("[data-path]");
      if (link) loadFiles(link.dataset.path);
    });

    // Files: dir/file clicks
    $("#files-body").addEventListener("click", function(e) {
      e.preventDefault();
      var dir = e.target.closest("[data-dir]");
      if (dir) { loadFiles(dir.dataset.dir); return; }
      var file = e.target.closest("[data-file]");
      if (file) loadFileContent(file.dataset.file);
    });

    // Transfer
    $("#btn-transfer").addEventListener("click", openTransferModal);
    $("#transfer-close").addEventListener("click", function() { $("#transfer-modal").classList.add("hidden"); });
    $("#transfer-cancel").addEventListener("click", function() { $("#transfer-modal").classList.add("hidden"); });
    $("#transfer-modal").addEventListener("click", function(e) {
      if (e.target === e.currentTarget) e.target.classList.add("hidden");
    });
    $("#transfer-submit").addEventListener("click", submitTransfer);

    // Editor modal
    $("#editor-save").addEventListener("click", function() {
      saveFile(editorFilePath, $("#editor-content").value);
    });
    $("#editor-cancel").addEventListener("click", function() { $("#editor-modal").classList.add("hidden"); });
    $("#editor-close").addEventListener("click", function() { $("#editor-modal").classList.add("hidden"); });
    $("#editor-modal").addEventListener("click", function(e) {
      if (e.target === e.currentTarget) e.target.classList.add("hidden");
    });

    // Terminal input
    $("#terminal-input").addEventListener("keydown", function(e) {
      if (e.key === "Enter") {
        var cmd = this.value;
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

    // Updates
    $("#btn-check-updates").addEventListener("click", checkUpdates);
    $("#btn-install-updates").addEventListener("click", installUpdates);

    // Logs
    $("#btn-refresh-logs").addEventListener("click", function() { loadLogs($("#logs-service").value); });
    $("#logs-service").addEventListener("change", function() { loadLogs(this.value); });
    $("#logs-lines").addEventListener("change", function() { loadLogs($("#logs-service").value); });

    // Escape closes modals
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape") {
        $$(".modal-overlay").forEach(function(m) { m.classList.add("hidden"); });
      }
    });

    // Initial load
    loadMachines().then(function() {
      switchSection("monitoring");
    });
    statusTimer = setInterval(refreshMachineStatuses, 30000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
