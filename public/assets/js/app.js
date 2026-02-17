(() => {
  const byId = (id) => document.getElementById(id);
  const video = byId("videoPlayer");
  const grid = byId("channelGrid");
  const filterRow = document.querySelector(".filter-row");
  const searchInput = byId("searchInput");
  const searchPopup = byId("searchPopup");
  const searchPopupList = byId("searchPopupList");
  const nowPlayingName = byId("nowPlayingName");
  const nowPlayingCategory = byId("nowPlayingCategory");
  const streamStatus = byId("streamStatus");
  const bufferingOverlay = byId("bufferingOverlay");
  const playerPanel = document.querySelector(".player-panel");
  const commentsPanel = document.querySelector(".comments-panel");
  const streamSummary = byId("streamSummary");
  const viewerCountChip = byId("viewerCountChip");
  const metaNotice = byId("metaNotice");
  const detailTabs = byId("detailTabs");
  const detailAbout = byId("detailPanelAbout");
  const detailSchedule = byId("detailPanelSchedule");
  const detailRelated = byId("detailPanelRelated");
  const upNextList = byId("upNextList");
  const channelCountLabel = byId("channelCountLabel");
  const followBtn = byId("followBtn");
  const shareBtn = byId("shareBtn");
  const reportBtn = byId("reportBtn");
  const reactionLike = byId("reactionLike");
  const reactionFire = byId("reactionFire");
  const reactionHeart = byId("reactionHeart");
  const FOLLOWED_KEY = "livetv.followed.channels";

  let channels = [];
  let categories = ["All"];
  let hls = null;
  let extPlayer = null;
  let activeCategory = "All";
  let searchQuery = "";
  let popupMatches = [];
  let popupActiveIndex = -1;
  let currentChannelId = "";
  let seekLockTime = 0;
  let seekBlockEnabled = false;
  let seekGuardUntil = 0;
  let isSeekCorrection = false;
  let activeDetailTab = "about";
  const followed = new Set();

  try {
    const parsedFollowed = JSON.parse(localStorage.getItem(FOLLOWED_KEY) || "[]");
    if (Array.isArray(parsedFollowed)) {
      parsedFollowed.filter((item) => typeof item === "string").forEach((item) => followed.add(item));
    }
  } catch (_error) {
    // Ignore invalid localStorage payload.
  }

  const esc = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const priority = (channel) => {
    const parsed = Number.parseInt(channel?.priority, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.MAX_SAFE_INTEGER;
  };

  const sortChannels = (list) =>
    [...list].sort((a, b) => {
      const diff = priority(a) - priority(b);
      return diff !== 0 ? diff : String(a.name || "").localeCompare(String(b.name || ""));
    });

  const compact = (num) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(num);
  const setStatus = (text) => (streamStatus.textContent = text);

  function setNotice(text, tone = "default") {
    if (!metaNotice) return;
    metaNotice.classList.remove("text-slate-400", "text-emerald-300", "text-rose-300");
    metaNotice.classList.add(tone === "success" ? "text-emerald-300" : tone === "error" ? "text-rose-300" : "text-slate-400");
    metaNotice.textContent = text;
  }

  function hash(value = "") {
    let out = 0;
    for (const ch of String(value)) out = (out * 31 + ch.charCodeAt(0)) >>> 0;
    return out;
  }

  function summary(channel) {
    const map = {
      News: "Rolling headlines and live field reports updated in real time.",
      Sports: "Live coverage with commentary, momentum swings, and match context.",
      Entertainment: "Continuous entertainment stream featuring trending segments.",
      Movies: "Always-on movie programming curated for prime-time viewing.",
      Music: "Live music blocks with artist highlights and nonstop playlists.",
      Kids: "Family-friendly live lineup with safe, age-appropriate programming."
    };
    return map[channel.category] || "Always-on live stream with curated programming.";
  }

  function notifyChannelChange(channel) {
    window.liveTvCurrentChannel = { id: channel.id, name: channel.name };
    window.dispatchEvent(new CustomEvent("livetv:channel-change", { detail: { id: channel.id, name: channel.name } }));
  }

  function setBufferingState(isBuffering) {
    bufferingOverlay.classList.toggle("hidden", !isBuffering);
    bufferingOverlay.classList.toggle("grid", isBuffering);
  }

  function syncChatHeightToPlayer() {
    if (!playerPanel || !commentsPanel) return;

    const isDesktop = window.matchMedia("(min-width: 1280px)").matches;
    if (!isDesktop) {
      commentsPanel.style.height = "";
      return;
    }

    const playerHeight = Math.round(playerPanel.getBoundingClientRect().height);
    commentsPanel.style.height = `${Math.max(420, playerHeight)}px`;
  }

  function playVideo() {
    const promise = video.play();
    if (promise && typeof promise.catch === "function") {
      promise.catch(() => setStatus("Tap play to start"));
    }
  }

  function destroyHls() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
  }

  function startFromBeginning() {
    let nextTime = 0;
    try {
      if (video.seekable && video.seekable.length > 0) nextTime = Math.max(0, video.seekable.start(0));
    } catch (_error) {
      nextTime = 0;
    }
    isSeekCorrection = true;
    try {
      video.currentTime = nextTime;
    } catch (_error) {
      // Ignore unsupported seek state.
    }
    seekLockTime = nextTime;
    requestAnimationFrame(() => {
      isSeekCorrection = false;
    });
  }

  function initExternalPlayer() {
    video.disablePictureInPicture = true;
    if (!window.Plyr) {
      video.controls = true;
      return;
    }
    if (extPlayer) return;
    extPlayer = new window.Plyr(video, {
      controls: ["play-large", "play", "mute", "volume", "fullscreen"],
      settings: [],
      seekTime: 0,
      keyboard: { focused: false, global: false },
      clickToPlay: true,
      invertTime: false
    });
  }

  function categoryButtonClass(active) {
    return [
      "category-btn rounded-full border px-3 py-2 text-[0.83rem] transition",
      active ? "border-transparent bg-gradient-to-r from-cyan-400 to-emerald-300 font-bold text-slate-900" : "border-white/20 bg-white/5 text-slate-100 hover:border-cyan-300"
    ].join(" ");
  }

  function channelCardClass(active) {
    return [
      "channel-card w-full appearance-none overflow-hidden rounded-xl border bg-slate-900/85 p-0 text-left text-inherit transition min-h-[132px]",
      active ? "border-emerald-300/80 shadow-[inset_0_0_0_2px_rgba(53,242,161,0.22)]" : "border-white/10 hover:-translate-y-0.5 hover:border-cyan-300/80"
    ].join(" ");
  }

  function tabButtonClass(active) {
    return [
      "detail-tab-btn rounded-full border px-2.5 py-1 text-[11px] font-semibold transition",
      active ? "border-cyan-300/70 bg-cyan-300/20 text-cyan-100" : "border-white/15 bg-white/[0.03] text-slate-300 hover:border-cyan-300/40"
    ].join(" ");
  }

  function renderFilters() {
    filterRow.innerHTML = categories.map((category) => `<button class="${categoryButtonClass(category === activeCategory)}" data-category="${esc(category)}">${esc(category)}</button>`).join("");
  }

  function filteredChannels() {
    return channels.filter((channel) => {
      const categoryMatch = activeCategory === "All" || channel.category === activeCategory;
      const blob = `${channel.name} ${channel.category} ${channel.country || ""}`.toLowerCase();
      return categoryMatch && blob.includes(searchQuery);
    });
  }

  function renderChannels() {
    const list = filteredChannels();
    if (channelCountLabel) channelCountLabel.textContent = `${list.length} channels`;
    if (!list.length) {
      grid.innerHTML = '<div class="col-span-full rounded-lg border border-white/15 p-4 text-center text-sm text-slate-400">No channels match your search/filter.</div>';
      return;
    }

    grid.innerHTML = list
      .map((channel) => {
        const active = channel.id === currentChannelId;
        return `
          <button type="button" role="listitem" class="${channelCardClass(active)}" data-channel-id="${esc(channel.id)}" aria-label="Play channel ${esc(channel.name)}" aria-pressed="${active ? "true" : "false"}">
            <img class="channel-thumb block aspect-video w-full object-cover bg-gradient-to-br from-[#112447] to-[#15354a]" src="${esc(channel.thumbnail)}" alt="${esc(channel.name)} thumbnail" loading="lazy" />
            <div class="channel-details px-2.5 pb-2.5 pt-2">
              <h3 class="channel-name m-0 text-sm font-bold">${esc(channel.name)}</h3>
              <p class="channel-meta mt-1 text-xs text-slate-400">${esc(channel.category)}${channel.country ? ` | ${esc(channel.country)}` : ""}</p>
            </div>
          </button>
        `;
      })
      .join("");
  }

  function getPopupMatches(query) {
    if (!query) return [];
    return channels.filter((channel) => `${channel.name} ${channel.category} ${channel.country || ""}`.toLowerCase().includes(query)).slice(0, 8);
  }

  function closeSearchPopup() {
    searchPopup.classList.add("hidden");
    searchInput.setAttribute("aria-expanded", "false");
    searchInput.removeAttribute("aria-activedescendant");
    popupActiveIndex = -1;
  }

  function updatePopupActiveItem() {
    const items = searchPopupList.querySelectorAll(".search-popup-item");
    items.forEach((item, index) => {
      const active = index === popupActiveIndex;
      item.classList.toggle("bg-cyan-400/20", active);
      item.classList.toggle("ring-1", active);
      item.classList.toggle("ring-cyan-300/40", active);
      item.setAttribute("aria-selected", active ? "true" : "false");
      if (active) searchInput.setAttribute("aria-activedescendant", item.id);
    });
    if (popupActiveIndex < 0) searchInput.removeAttribute("aria-activedescendant");
  }

  function renderSearchPopup() {
    popupMatches = getPopupMatches(searchQuery);
    if (!searchQuery) {
      closeSearchPopup();
      return;
    }

    if (!popupMatches.length) {
      searchPopupList.innerHTML = '<div class="px-3 py-3 text-xs text-slate-400">No matching channels found.</div>';
      searchPopup.classList.remove("hidden");
      searchInput.setAttribute("aria-expanded", "true");
      return;
    }

    searchPopupList.innerHTML = popupMatches
      .map((channel, index) => {
        const id = `searchPopupOption-${index}`;
        const meta = `${channel.category}${channel.country ? ` | ${channel.country}` : ""}`;
        return `
          <button id="${esc(id)}" type="button" role="option" class="search-popup-item last:border-b-0 flex w-full items-center justify-between gap-2.5 border-0 border-b border-white/10 bg-transparent px-3 py-2.5 text-left text-slate-100 transition hover:bg-cyan-400/10" data-channel-id="${esc(channel.id)}" aria-selected="false">
            <span class="text-sm font-semibold">${esc(channel.name)}</span>
            <span class="text-xs text-slate-400">${esc(meta)}</span>
          </button>
        `;
      })
      .join("");

    searchPopup.classList.remove("hidden");
    searchInput.setAttribute("aria-expanded", "true");
    popupActiveIndex = -1;
  }

  function updateFollowButton() {
    const active = currentChannelId && followed.has(currentChannelId);
    followBtn.textContent = active ? "Following" : "Follow";
    followBtn.setAttribute("aria-pressed", active ? "true" : "false");
    followBtn.classList.toggle("border-emerald-300/60", !!active);
    followBtn.classList.toggle("bg-emerald-300/15", !!active);
  }

  function renderDetailContent(channel) {
    if (!detailAbout || !detailSchedule || !detailRelated || !upNextList) return;

    detailAbout.innerHTML = `
      <div class="space-y-2 text-xs text-slate-200">
        <p>${esc(summary(channel))}</p>
        <div class="grid gap-1.5 sm:grid-cols-2">
          <div class="rounded-xl border border-white/10 bg-white/[0.03] p-2"><p class="text-[11px] uppercase tracking-wide text-slate-400">Channel</p><p class="mt-1 text-xs font-semibold">${esc(channel.name)}</p></div>
          <div class="rounded-xl border border-white/10 bg-white/[0.03] p-2"><p class="text-[11px] uppercase tracking-wide text-slate-400">Region</p><p class="mt-1 text-xs font-semibold">${esc(channel.country || "Global")}</p></div>
          <div class="rounded-xl border border-white/10 bg-white/[0.03] p-2"><p class="text-[11px] uppercase tracking-wide text-slate-400">Stream Type</p><p class="mt-1 text-xs font-semibold">HLS Live (.m3u8)</p></div>
          <div class="rounded-xl border border-white/10 bg-white/[0.03] p-2"><p class="text-[11px] uppercase tracking-wide text-slate-400">Category</p><p class="mt-1 text-xs font-semibold">${esc(channel.category || "General")}</p></div>
        </div>
      </div>
    `;

    const now = new Date();
    const base = new Date(now);
    base.setMinutes(now.getMinutes() - (now.getMinutes() % 30), 0, 0);
    const titles = ["Live Desk", "Prime Bulletin", "Spotlight", "After Hours", "Late Window"];
    detailSchedule.innerHTML = Array.from({ length: 5 }, (_, i) => {
      const start = new Date(base.getTime() + i * 30 * 60 * 1000);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      const time = `${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} - ${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      const badge = i === 0 ? '<span class="rounded-full px-1.5 py-0.5 text-[10px] font-semibold border border-rose-300/50 bg-rose-300/15 text-rose-100">On Air</span>' : '<span class="rounded-full px-1.5 py-0.5 text-[10px] font-semibold border border-white/20 bg-white/[0.04] text-slate-300">Upcoming</span>';
      return `<div class="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-1.5"><div><p class="text-xs font-semibold text-slate-100">${esc(titles[i % titles.length])}</p><p class="text-[11px] text-slate-400">${esc(time)}</p></div>${badge}</div>`;
    }).join("");

    const related = channels.filter((item) => item.id !== channel.id && item.category === channel.category).concat(channels.filter((item) => item.id !== channel.id && item.category !== channel.category)).slice(0, 4);
    detailRelated.innerHTML = related.length
      ? `<div class="grid gap-1.5 sm:grid-cols-2">${related
          .map(
            (item) =>
              `<button type="button" class="group flex w-full items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] p-1.5 text-left transition hover:border-cyan-300/40 hover:bg-cyan-300/10" data-channel-id="${esc(item.id)}"><img src="${esc(item.thumbnail)}" alt="${esc(item.name)} thumbnail" class="h-10 w-16 rounded-md object-cover" loading="lazy" /><span class="min-w-0"><span class="block truncate text-xs font-semibold text-slate-100">${esc(item.name)}</span><span class="block text-[11px] text-slate-400">${esc(item.category || "General")}</span></span></button>`
          )
          .join("")}</div>`
      : '<p class="text-xs text-slate-400">No related channels available right now.</p>';

    const upNext = channels.filter((item) => item.id !== channel.id).slice(0, 6);
    upNextList.innerHTML = upNext.length
      ? upNext
          .map(
            (item) =>
              `<button type="button" class="group flex w-full items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] p-1.5 text-left transition hover:border-cyan-300/40 hover:bg-cyan-300/10" data-channel-id="${esc(item.id)}"><img src="${esc(item.thumbnail)}" alt="${esc(item.name)} thumbnail" class="h-9 w-14 rounded-md object-cover" loading="lazy" /><span class="min-w-0"><span class="block truncate text-xs font-semibold text-slate-100">${esc(item.name)}</span><span class="block text-[11px] text-slate-400">${esc(item.category || "General")}</span></span></button>`
          )
          .join("")
      : '<p class="text-xs text-slate-400">No additional channels available.</p>';
  }

  function setDetailTab(tab) {
    activeDetailTab = tab;
    detailTabs?.querySelectorAll("[data-detail-tab]").forEach((button) => {
      const active = button.dataset.detailTab === tab;
      button.className = tabButtonClass(active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    detailAbout?.classList.toggle("hidden", tab !== "about");
    detailSchedule?.classList.toggle("hidden", tab !== "schedule");
    detailRelated?.classList.toggle("hidden", tab !== "related");
  }

  function updateMeta(channel) {
    nowPlayingName.textContent = channel.name;
    nowPlayingCategory.textContent = channel.category || "General";
    streamSummary.textContent = summary(channel);
    viewerCountChip.textContent = `${compact(320 + (hash(channel.id) % 9200))} watching`;
    reactionLike.textContent = `Like ${compact(40 + (hash(`${channel.id}-1`) % 1600))}`;
    reactionFire.textContent = `Hype ${compact(40 + (hash(`${channel.id}-2`) % 1600))}`;
    reactionHeart.textContent = `Fav ${compact(40 + (hash(`${channel.id}-3`) % 1600))}`;
    renderDetailContent(channel);
    updateFollowButton();
  }

  function handleHlsFatalError(data) {
    if (!hls || !data || !data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      setStatus("Network issue, retrying...");
      hls.startLoad();
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      setStatus("Recovering media...");
      hls.recoverMediaError();
      return;
    }
    setBufferingState(false);
    setStatus("Stream error");
    destroyHls();
  }

  function loadChannel(channel) {
    if (!channel) return;
    currentChannelId = channel.id;
    notifyChannelChange(channel);
    updateMeta(channel);
    renderChannels();
    setStatus("Loading...");
    setNotice(`Switched to ${channel.name}.`);
    seekLockTime = 0;
    seekBlockEnabled = false;
    seekGuardUntil = Date.now() + 2500;
    isSeekCorrection = false;

    try {
      const url = new URL(window.location.href);
      url.searchParams.set("channel", channel.id);
      window.history.replaceState({}, "", url.toString());
    } catch (_error) {
      // Ignore URL update issues.
    }

    setBufferingState(true);
    destroyHls();
    video.pause();
    video.removeAttribute("src");
    video.load();
    syncChatHeightToPlayer();

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 90 });
      hls.loadSource(channel.streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        startFromBeginning();
        setStatus("Live");
        playVideo();
      });
      hls.on(Hls.Events.ERROR, (_, data) => handleHlsFatalError(data));
      return;
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = channel.streamUrl;
      video.addEventListener(
        "loadedmetadata",
        () => {
          startFromBeginning();
          setStatus("Live");
          playVideo();
        },
        { once: true }
      );
      return;
    }

    setBufferingState(false);
    setStatus("HLS unsupported");
    alert("This browser does not support HLS playback.");

    syncChatHeightToPlayer();
  }

  async function fetchChannels() {
    const response = await fetch("/api/channels", { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to fetch channels");
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  }

  function initialChannel() {
    const id = new URLSearchParams(window.location.search).get("channel");
    if (!id) return channels[0] || null;
    return channels.find((channel) => channel.id === id) || channels[0] || null;
  }

  function bindEvents() {
    ["loadstart", "waiting", "stalled", "seeking"].forEach((name) => video.addEventListener(name, () => setBufferingState(true)));
    ["playing", "canplay", "seeked"].forEach((name) =>
      video.addEventListener(name, () => {
        setBufferingState(false);
        if (name === "playing") setStatus("Live");
      })
    );

    video.addEventListener("pause", () => {
      if (!video.ended) setStatus("Paused");
    });
    video.addEventListener("error", () => {
      setBufferingState(false);
      setStatus("Playback error");
    });
    video.addEventListener("timeupdate", () => {
      if (!video.seeking && !isSeekCorrection) seekLockTime = video.currentTime;
    });
    video.addEventListener("playing", () => {
      seekBlockEnabled = true;
      seekGuardUntil = Date.now() + 1000;
    });
    video.addEventListener("seeking", () => {
      if (!seekBlockEnabled || isSeekCorrection || Date.now() < seekGuardUntil) return;
      isSeekCorrection = true;
      try {
        video.currentTime = seekLockTime;
      } catch (_error) {
        // Ignore seek reset errors.
      }
      requestAnimationFrame(() => {
        isSeekCorrection = false;
      });
      setStatus("Seeking disabled");
    });
    video.addEventListener("ended", () => {
      startFromBeginning();
      playVideo();
    });
    video.addEventListener("loadedmetadata", () => syncChatHeightToPlayer());

    searchInput.addEventListener("input", (event) => {
      searchQuery = event.target.value.trim().toLowerCase();
      renderChannels();
      renderSearchPopup();
    });
    searchInput.addEventListener("focus", () => {
      if (searchQuery) renderSearchPopup();
    });
    searchInput.addEventListener("keydown", (event) => {
      if (searchPopup.classList.contains("hidden")) return;
      if (event.key === "ArrowDown") {
        if (!popupMatches.length) return;
        event.preventDefault();
        popupActiveIndex = (popupActiveIndex + 1) % popupMatches.length;
        updatePopupActiveItem();
        return;
      }
      if (event.key === "ArrowUp") {
        if (!popupMatches.length) return;
        event.preventDefault();
        popupActiveIndex = popupActiveIndex <= 0 ? popupMatches.length - 1 : popupActiveIndex - 1;
        updatePopupActiveItem();
        return;
      }
      if (event.key === "Enter" && popupActiveIndex >= 0 && popupActiveIndex < popupMatches.length) {
        event.preventDefault();
        loadChannel(popupMatches[popupActiveIndex]);
        closeSearchPopup();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearchPopup();
      }
    });

    searchPopup?.addEventListener("mousedown", (event) => {
      const item = event.target.closest(".search-popup-item");
      if (!item) return;
      event.preventDefault();
      const channel = channels.find((entry) => entry.id === item.dataset.channelId);
      loadChannel(channel);
      closeSearchPopup();
    });

    filterRow.addEventListener("click", (event) => {
      const button = event.target.closest(".category-btn");
      if (!button) return;
      activeCategory = button.dataset.category || "All";
      renderFilters();
      renderChannels();
    });

    grid.addEventListener("click", (event) => {
      const card = event.target.closest(".channel-card");
      if (!card) return;
      loadChannel(channels.find((entry) => entry.id === card.dataset.channelId));
    });

    detailTabs?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-detail-tab]");
      if (!button) return;
      setDetailTab(button.dataset.detailTab || "about");
    });

    detailRelated?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-channel-id]");
      if (!button) return;
      loadChannel(channels.find((entry) => entry.id === button.dataset.channelId));
    });

    upNextList?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-channel-id]");
      if (!button) return;
      loadChannel(channels.find((entry) => entry.id === button.dataset.channelId));
    });

    followBtn?.addEventListener("click", () => {
      if (!currentChannelId) return;
      if (followed.has(currentChannelId)) {
        followed.delete(currentChannelId);
        setNotice("Channel removed from followed list.");
      } else {
        followed.add(currentChannelId);
        setNotice("Channel added to followed list.", "success");
      }
      localStorage.setItem(FOLLOWED_KEY, JSON.stringify([...followed]));
      updateFollowButton();
    });

    shareBtn?.addEventListener("click", async () => {
      if (!currentChannelId) return;
      const url = new URL(window.location.href);
      url.searchParams.set("channel", currentChannelId);
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(url.toString());
          setNotice("Channel link copied to clipboard.", "success");
          return;
        } catch (_error) {
          // Fallback to prompt if clipboard fails.
        }
      }
      window.prompt("Copy channel URL:", url.toString());
      setNotice("Copy the channel URL from the dialog.");
    });

    reportBtn?.addEventListener("click", () => setNotice("Thanks. Report submitted for review.", "success"));

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".search-area") && !event.target.closest("#searchPopup")) closeSearchPopup();
    });

    window.addEventListener("resize", () => syncChatHeightToPlayer());
  }

  async function init() {
    try {
      channels = sortChannels(await fetchChannels());
      categories = ["All", ...new Set(channels.map((channel) => channel.category).filter(Boolean))];
      renderFilters();
      renderChannels();
      setDetailTab(activeDetailTab);
      bindEvents();
      initExternalPlayer();
      syncChatHeightToPlayer();

      if (!channels.length) {
        setStatus("No channels");
        setNotice("No channels are available yet.", "error");
        return;
      }

      loadChannel(initialChannel());
      syncChatHeightToPlayer();
    } catch (_error) {
      setStatus("Unable to load channels");
      setNotice("Could not load stream data. Please try again.", "error");
      grid.innerHTML = '<div class="col-span-full rounded-lg border border-white/15 p-4 text-center text-sm text-slate-400">Unable to load channels from server.</div>';
    }
  }

  init();
})();
