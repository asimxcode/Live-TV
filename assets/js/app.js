(() => {
  const video = document.getElementById("videoPlayer");
  const grid = document.getElementById("channelGrid");
  const filterRow = document.querySelector(".filter-row");
  const searchInput = document.getElementById("searchInput");
  const nowPlayingName = document.getElementById("nowPlayingName");
  const nowPlayingCategory = document.getElementById("nowPlayingCategory");
  const streamStatus = document.getElementById("streamStatus");
  const bufferingOverlay = document.getElementById("bufferingOverlay");

  const channels = Array.isArray(window.CHANNELS) ? window.CHANNELS : [];

  const categoryButtonBaseClasses = [
    "category-btn",
    "rounded-full",
    "border",
    "px-3",
    "py-2",
    "text-[0.83rem]",
    "transition"
  ];
  const categoryButtonActiveClasses = [
    "border-transparent",
    "bg-gradient-to-r",
    "from-cyan-400",
    "to-emerald-300",
    "font-bold",
    "text-slate-900"
  ];
  const categoryButtonInactiveClasses = [
    "border-white/20",
    "bg-white/5",
    "text-slate-100",
    "hover:border-cyan-300"
  ];

  const channelCardBaseClasses = [
    "channel-card",
    "w-full",
    "overflow-hidden",
    "rounded-xl",
    "border",
    "bg-slate-900/85",
    "text-left",
    "transition",
    "min-h-[132px]"
  ];
  const channelCardActiveClasses = [
    "border-emerald-300/80",
    "shadow-[inset_0_0_0_2px_rgba(53,242,161,0.22)]"
  ];
  const channelCardInactiveClasses = [
    "border-white/10",
    "hover:-translate-y-0.5",
    "hover:border-cyan-300/80"
  ];

  let hls = null;
  let activeCategory = "All";
  let searchQuery = "";
  let currentChannelId = null;

  const categories = [
    "All",
    ...new Set(channels.map((channel) => channel.category).filter(Boolean))
  ];

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function setStatus(text) {
    streamStatus.textContent = text;
  }

  function setBufferingState(isBuffering) {
    bufferingOverlay.classList.toggle("hidden", !isBuffering);
    bufferingOverlay.classList.toggle("grid", isBuffering);
  }

  function playVideo() {
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {
        setStatus("Tap play to start");
      });
    }
  }

  function destroyHls() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
  }

  function applyStateClasses(element, isActive, activeClasses, inactiveClasses) {
    if (!element) {
      return;
    }
    element.classList.remove(...activeClasses, ...inactiveClasses);
    element.classList.add(...(isActive ? activeClasses : inactiveClasses));
  }

  function highlightActiveCard() {
    const cards = grid.querySelectorAll(".channel-card");
    cards.forEach((card) => {
      const isActive = card.dataset.channelId === currentChannelId;
      applyStateClasses(card, isActive, channelCardActiveClasses, channelCardInactiveClasses);
    });
  }

  function filteredChannels() {
    return channels.filter((channel) => {
      const matchesCategory = activeCategory === "All" || channel.category === activeCategory;
      const normalized = `${channel.name} ${channel.category} ${channel.country || ""}`.toLowerCase();
      const matchesSearch = normalized.includes(searchQuery);
      return matchesCategory && matchesSearch;
    });
  }

  function renderFilters() {
    filterRow.innerHTML = categories
      .map((category) => {
        const isActive = category === activeCategory;
        const classes = [
          ...categoryButtonBaseClasses,
          ...(isActive ? categoryButtonActiveClasses : categoryButtonInactiveClasses)
        ].join(" ");
        return `<button class="${classes}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`;
      })
      .join("");
  }

  function renderChannels() {
    const list = filteredChannels();

    if (!list.length) {
      grid.innerHTML = '<div class="col-span-full rounded-lg border border-white/15 p-4 text-center text-sm text-slate-400">No channels match your search/filter.</div>';
      return;
    }

    grid.innerHTML = list
      .map((channel) => {
        const isActive = channel.id === currentChannelId;
        const cardClasses = [
          ...channelCardBaseClasses,
          ...(isActive ? channelCardActiveClasses : channelCardInactiveClasses)
        ].join(" ");

        return `
          <article class="${cardClasses}" data-channel-id="${escapeHtml(channel.id)}">
            <img class="channel-thumb block aspect-video w-full object-cover bg-gradient-to-br from-[#112447] to-[#15354a]" src="${escapeHtml(channel.thumbnail)}" alt="${escapeHtml(channel.name)} thumbnail" loading="lazy" />
            <div class="channel-details px-2.5 pb-2.5 pt-2">
              <h3 class="channel-name m-0 text-sm font-bold">${escapeHtml(channel.name)}</h3>
              <p class="channel-meta mt-1 text-xs text-slate-400">${escapeHtml(channel.category)}${channel.country ? ` • ${escapeHtml(channel.country)}` : ""}</p>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function handleHlsFatalError(data) {
    if (!hls || !data || !data.fatal) {
      return;
    }

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
    if (!channel) {
      return;
    }

    currentChannelId = channel.id;
    nowPlayingName.textContent = channel.name;
    nowPlayingCategory.textContent = channel.category || "General";
    setStatus("Loading...");
    setBufferingState(true);

    destroyHls();
    video.pause();
    video.removeAttribute("src");
    video.load();

    const streamUrl = channel.streamUrl;

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90
      });

      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setStatus("Live");
        playVideo();
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        handleHlsFatalError(data);
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = streamUrl;
      video.addEventListener(
        "loadedmetadata",
        () => {
          setStatus("Live");
          playVideo();
        },
        { once: true }
      );
    } else {
      setBufferingState(false);
      setStatus("HLS unsupported");
      alert("This browser does not support HLS playback.");
    }

    highlightActiveCard();
  }

  function bindEvents() {
    ["loadstart", "waiting", "stalled", "seeking"].forEach((eventName) => {
      video.addEventListener(eventName, () => setBufferingState(true));
    });

    ["playing", "canplay", "seeked"].forEach((eventName) => {
      video.addEventListener(eventName, () => {
        setBufferingState(false);
        if (eventName === "playing") {
          setStatus("Live");
        }
      });
    });

    video.addEventListener("pause", () => {
      if (!video.ended) {
        setStatus("Paused");
      }
    });

    video.addEventListener("error", () => {
      setBufferingState(false);
      setStatus("Playback error");
    });

    searchInput.addEventListener("input", (event) => {
      searchQuery = event.target.value.trim().toLowerCase();
      renderChannels();
    });

    filterRow.addEventListener("click", (event) => {
      const button = event.target.closest(".category-btn");
      if (!button) {
        return;
      }

      activeCategory = button.dataset.category || "All";
      renderFilters();
      renderChannels();
      highlightActiveCard();
    });

    grid.addEventListener("click", (event) => {
      const card = event.target.closest(".channel-card");
      if (!card) {
        return;
      }

      const channel = channels.find((item) => item.id === card.dataset.channelId);
      loadChannel(channel);
    });
  }

  function init() {
    if (!channels.length) {
      grid.innerHTML = '<div class="col-span-full rounded-lg border border-white/15 p-4 text-center text-sm text-slate-400">No channels found. Add channel objects in assets/js/channels.js.</div>';
      return;
    }

    renderFilters();
    renderChannels();
    bindEvents();

    loadChannel(channels[0]);
  }

  init();
})();