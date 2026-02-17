(() => {
  const loginSection = document.getElementById("loginSection");
  const adminSection = document.getElementById("adminSection");
  const loginForm = document.getElementById("loginForm");
  const logoutBtn = document.getElementById("logoutBtn");
  const channelForm = document.getElementById("channelForm");
  const refreshBtn = document.getElementById("refreshBtn");
  const exportBtn = document.getElementById("exportBtn");
  const cancelEditBtn = document.getElementById("cancelEditBtn");
  const tableBody = document.getElementById("channelTableBody");
  const statusMessage = document.getElementById("statusMessage");
  const formTitle = document.getElementById("formTitle");
  const saveBtn = document.getElementById("saveBtn");
  const filterSearch = document.getElementById("filterSearch");
  const filterCategory = document.getElementById("filterCategory");
  const statTotalChannels = document.getElementById("statTotalChannels");
  const statCategories = document.getElementById("statCategories");
  const statCountries = document.getElementById("statCountries");
  const statAdminPath = document.getElementById("statAdminPath");

  const fields = {
    id: document.getElementById("channelId"),
    name: document.getElementById("channelName"),
    category: document.getElementById("channelCategory"),
    country: document.getElementById("channelCountry"),
    priority: document.getElementById("channelPriority"),
    thumbnail: document.getElementById("channelThumbnail"),
    streamUrl: document.getElementById("channelStreamUrl")
  };

  const statusBaseClasses = ["status-message", "mt-2.5", "min-h-5", "text-sm"];
  const statusToneClass = {
    default: "text-slate-400",
    success: "text-emerald-300",
    error: "text-rose-300"
  };

  let channels = [];
  let editingId = "";
  let currentSearch = "";
  let currentCategory = "All";
  let adminPath = window.location.pathname;

  function setMessage(message, type = "") {
    statusMessage.textContent = message;
    statusMessage.className = [...statusBaseClasses, statusToneClass[type] || statusToneClass.default].join(" ");
  }

  function normalizePriority(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return 0;
    }
    return parsed;
  }

  function sortChannels(list) {
    return [...list].sort((a, b) => {
      const priorityDiff = normalizePriority(a.priority) - normalizePriority(b.priority);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  }

  async function request(url, options = {}) {
    const requestOptions = { credentials: "same-origin", ...options };
    const headers = { ...(requestOptions.headers || {}) };

    if (requestOptions.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    requestOptions.headers = headers;

    const response = await fetch(url, requestOptions);
    let payload = {};

    try {
      payload = await response.json();
    } catch (_error) {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(payload.message || "Request failed");
    }

    return payload;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function showAdmin(visible) {
    loginSection.classList.toggle("hidden", visible);
    adminSection.classList.toggle("hidden", !visible);
    logoutBtn.classList.toggle("hidden", !visible);
  }

  function clearForm() {
    editingId = "";
    fields.id.value = "";
    fields.name.value = "";
    fields.category.value = "";
    fields.country.value = "";
    fields.priority.value = "";
    fields.thumbnail.value = "";
    fields.streamUrl.value = "";
    formTitle.textContent = "Add Channel";
    saveBtn.textContent = "Save Channel";
  }

  function fillForm(channel) {
    editingId = channel.id;
    fields.id.value = channel.id || "";
    fields.name.value = channel.name || "";
    fields.category.value = channel.category || "";
    fields.country.value = channel.country || "";
    fields.priority.value = channel.priority || "";
    fields.thumbnail.value = channel.thumbnail || "";
    fields.streamUrl.value = channel.streamUrl || "";
    formTitle.textContent = `Edit Channel: ${channel.name}`;
    saveBtn.textContent = "Update Channel";
  }

  function getFilteredChannels() {
    return channels.filter((channel) => {
      const searchTarget = `${channel.name} ${channel.category} ${channel.country || ""} ${channel.id}`.toLowerCase();
      const matchesSearch = searchTarget.includes(currentSearch);
      const matchesCategory = currentCategory === "All" || channel.category === currentCategory;
      return matchesSearch && matchesCategory;
    });
  }

  function renderStats() {
    const categorySet = new Set(channels.map((channel) => channel.category).filter(Boolean));
    const countrySet = new Set(channels.map((channel) => channel.country).filter(Boolean));
    statTotalChannels.textContent = String(channels.length);
    statCategories.textContent = String(categorySet.size);
    statCountries.textContent = String(countrySet.size);
    statAdminPath.textContent = adminPath;
  }

  function renderCategoryFilter() {
    const previous = currentCategory;
    const categories = ["All", ...new Set(channels.map((channel) => channel.category).filter(Boolean))];
    filterCategory.innerHTML = categories
      .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
      .join("");
    currentCategory = categories.includes(previous) ? previous : "All";
    filterCategory.value = currentCategory;
  }

  function renderTable() {
    const filtered = getFilteredChannels();

    if (!filtered.length) {
      tableBody.innerHTML = '<tr><td colspan="6" class="border-b border-white/10 px-2 py-3 text-left text-sm text-slate-400">No channels match current filters.</td></tr>';
      return;
    }

    tableBody.innerHTML = filtered
      .map((channel) => {
        const priority = normalizePriority(channel.priority) || 1;
        const atTop = priority <= 1;
        const atBottom = priority >= channels.length;

        return `
          <tr data-id="${escapeHtml(channel.id)}" class="align-top">
            <td class="priority-cell min-w-[190px] border-b border-white/10 px-2 py-2 text-[0.84rem]">
              <div class="priority-controls flex items-center gap-1.5">
                <button type="button" class="priority-btn h-8 w-8 rounded-lg border border-cyan-300/45 bg-cyan-300/15 text-sm font-bold text-cyan-100 transition enabled:hover:bg-cyan-300/25 disabled:cursor-not-allowed disabled:opacity-45" data-action="move-up" ${atTop ? "disabled" : ""} aria-label="Move channel up">&#8593;</button>
                <button type="button" class="priority-btn h-8 w-8 rounded-lg border border-cyan-300/45 bg-cyan-300/15 text-sm font-bold text-cyan-100 transition enabled:hover:bg-cyan-300/25 disabled:cursor-not-allowed disabled:opacity-45" data-action="move-down" ${atBottom ? "disabled" : ""} aria-label="Move channel down">&#8595;</button>
                <input class="priority-input h-8 w-14 rounded-lg border border-white/25 bg-white/5 text-center text-sm text-slate-100 outline-none focus:border-cyan-300/90" type="number" min="1" value="${priority}" />
                <button type="button" class="priority-set h-8 rounded-lg border border-emerald-300/45 bg-emerald-300/15 px-2 text-xs font-bold text-emerald-100 transition enabled:hover:bg-emerald-300/25 disabled:cursor-not-allowed disabled:opacity-45" data-action="set-priority">Set</button>
              </div>
            </td>
            <td class="border-b border-white/10 px-2 py-2 text-[0.84rem] text-slate-100">${escapeHtml(channel.name)}</td>
            <td class="border-b border-white/10 px-2 py-2 text-[0.84rem] text-slate-100">${escapeHtml(channel.category)}</td>
            <td class="border-b border-white/10 px-2 py-2 text-[0.84rem] text-slate-100">${escapeHtml(channel.country || "-")}</td>
            <td class="border-b border-white/10 px-2 py-2 text-[0.84rem] text-slate-100">${escapeHtml(channel.id)}</td>
            <td class="border-b border-white/10 px-2 py-2 text-[0.84rem]">
              <div class="row-actions flex flex-wrap gap-1.5">
                <button type="button" class="edit-btn h-8 rounded-lg border border-cyan-300/45 bg-cyan-300/20 px-2.5 text-xs font-bold text-cyan-100 transition hover:bg-cyan-300/30" data-action="edit">Edit</button>
                <button type="button" class="preview-btn h-8 rounded-lg border border-emerald-300/45 bg-emerald-300/20 px-2.5 text-xs font-bold text-emerald-100 transition hover:bg-emerald-300/30" data-action="preview">Preview</button>
                <button type="button" class="delete-btn h-8 rounded-lg border border-rose-300/45 bg-rose-300/20 px-2.5 text-xs font-bold text-rose-100 transition hover:bg-rose-300/30" data-action="delete">Delete</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function handleUnauthorized(error) {
    if (error.message !== "Unauthorized") {
      return false;
    }
    showAdmin(false);
    clearForm();
    setMessage("Session expired. Please login again.", "error");
    return true;
  }

  async function loadChannels() {
    try {
      const data = await request("/api/admin/channels");
      channels = sortChannels(Array.isArray(data) ? data : []);
      renderCategoryFilter();
      renderStats();
      renderTable();
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setMessage(error.message, "error");
      }
    }
  }

  async function updatePriority(channelId, priority) {
    const normalized = normalizePriority(priority);
    if (!normalized) {
      setMessage("Priority must be a number greater than 0.", "error");
      return;
    }

    try {
      await request(`/api/channels/${encodeURIComponent(channelId)}/priority`, {
        method: "PATCH",
        body: JSON.stringify({ priority: normalized })
      });
      await loadChannels();
      setMessage("Priority updated.", "success");
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setMessage(error.message, "error");
      }
    }
  }

  async function checkAuth() {
    try {
      const auth = await request("/api/admin/me");
      adminPath = auth.adminPath || window.location.pathname;
      showAdmin(true);
      await loadChannels();
      setMessage("Authenticated.", "success");
    } catch (_error) {
      showAdmin(false);
      setMessage("Please login to continue.");
    }
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(loginForm);
    const username = String(formData.get("username") || "").trim();
    const password = String(formData.get("password") || "").trim();

    try {
      await request("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      loginForm.reset();
      await checkAuth();
      setMessage("Login successful.", "success");
    } catch (error) {
      setMessage(error.message, "error");
    }
  });

  logoutBtn.addEventListener("click", async () => {
    try {
      await request("/api/admin/logout", { method: "POST" });
    } catch (_error) {
      // Ignore logout errors and continue with local UI reset.
    }
    clearForm();
    showAdmin(false);
    setMessage("Logged out.");
  });

  channelForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const priority = normalizePriority(fields.priority.value.trim());
    const payload = {
      id: fields.id.value.trim(),
      name: fields.name.value.trim(),
      category: fields.category.value.trim(),
      country: fields.country.value.trim(),
      thumbnail: fields.thumbnail.value.trim(),
      streamUrl: fields.streamUrl.value.trim(),
      priority: priority || undefined
    };

    try {
      if (editingId) {
        await request(`/api/channels/${encodeURIComponent(editingId)}`, {
          method: "PUT",
          body: JSON.stringify(payload)
        });
        setMessage("Channel updated.", "success");
      } else {
        await request("/api/channels", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        setMessage("Channel added.", "success");
      }

      clearForm();
      await loadChannels();
    } catch (error) {
      if (!handleUnauthorized(error)) {
        setMessage(error.message, "error");
      }
    }
  });

  cancelEditBtn.addEventListener("click", () => {
    clearForm();
    setMessage("Edit canceled.");
  });

  refreshBtn.addEventListener("click", async () => {
    await loadChannels();
    setMessage("Channel list refreshed.", "success");
  });

  exportBtn.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(channels, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `channels-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setMessage("Channel list exported.", "success");
  });

  filterSearch.addEventListener("input", (event) => {
    currentSearch = event.target.value.trim().toLowerCase();
    renderTable();
  });

  filterCategory.addEventListener("change", (event) => {
    currentCategory = event.target.value || "All";
    renderTable();
  });

  tableBody.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }

    const input = event.target.closest(".priority-input");
    if (!input) {
      return;
    }

    const row = event.target.closest("tr[data-id]");
    if (!row) {
      return;
    }

    event.preventDefault();
    await updatePriority(row.dataset.id || "", input.value);
  });

  tableBody.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("button[data-action]");
    if (!actionButton) {
      return;
    }

    const row = event.target.closest("tr[data-id]");
    if (!row) {
      return;
    }

    const channelId = row.dataset.id || "";
    const channel = channels.find((item) => item.id === channelId);
    if (!channel) {
      return;
    }

    const action = actionButton.dataset.action;

    if (action === "edit") {
      fillForm(channel);
      setMessage(`Editing ${channel.name}.`);
      return;
    }

    if (action === "preview") {
      window.open(channel.streamUrl, "_blank", "noopener,noreferrer");
      setMessage(`Preview opened for ${channel.name}.`);
      return;
    }

    if (action === "move-up") {
      await updatePriority(channel.id, normalizePriority(channel.priority) - 1);
      return;
    }

    if (action === "move-down") {
      await updatePriority(channel.id, normalizePriority(channel.priority) + 1);
      return;
    }

    if (action === "set-priority") {
      const input = row.querySelector(".priority-input");
      await updatePriority(channel.id, input ? input.value : channel.priority);
      return;
    }

    if (action === "delete") {
      const shouldDelete = confirm(`Delete channel "${channel.name}"?`);
      if (!shouldDelete) {
        return;
      }

      try {
        await request(`/api/channels/${encodeURIComponent(channel.id)}`, {
          method: "DELETE"
        });
        if (editingId === channel.id) {
          clearForm();
        }
        await loadChannels();
        setMessage("Channel deleted.", "success");
      } catch (error) {
        if (!handleUnauthorized(error)) {
          setMessage(error.message, "error");
        }
      }
    }
  });

  clearForm();
  checkAuth();
})();