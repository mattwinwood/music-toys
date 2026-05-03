// Shared audio player for music-toys. Renders Deezer 30-second previews.
// Usage:
//   1. Include /player.css and /player.js in your toy.
//   2. Build the markup with mtPlayerHtml(track, { autoplay: bool }).
//      `track` is the object returned from /api/* — must have .preview, .cover, .fallbackQuery.
//   3. After injecting markup, call bindPlayers() to wire interactions.
//   4. Listen for "mt-ended" on a player element if you need sequence advance.

(function () {
  function escAttr(s) { return String(s ?? "").replace(/"/g, "&quot;"); }
  function escUrl(s) { return encodeURI(String(s ?? "")); }

  window.mtPlayerHtml = function (track, opts) {
    opts = opts || {};
    const autoplay = opts.autoplay === true;
    const preview = track && track.preview;
    const cover = track && track.cover;
    const fallback = track && track.fallbackQuery;

    if (!preview) {
      return `<div class="mt-player-fallback" data-unavailable="1">
        ${cover ? `<img src="${escAttr(cover)}" alt="" style="max-width:120px;border-radius:8px;opacity:0.7" />` : ""}
        <div>No preview available.${fallback ? ` <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(fallback)}" target="_blank" rel="noopener">▶ Try YouTube</a>` : ""}</div>
      </div>`;
    }

    const dataAuto = autoplay ? ' data-autoplay="1"' : "";
    return `<div class="mt-player"${dataAuto}>
      ${cover ? `<img class="mt-cover" src="${escAttr(cover)}" alt="" />` : ""}
      <div class="mt-overlay"></div>
      <span class="mt-duration">0:30</span>
      <button class="mt-toggle" data-state="paused" type="button" aria-label="Play">
        <svg class="mt-icon-play" viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
        <svg class="mt-icon-pause" viewBox="0 0 24 24" width="24" height="24" style="display:none"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
      </button>
      <div class="mt-progress"><div class="mt-bar"></div></div>
      <audio class="mt-audio" preload="auto" playsinline crossorigin="anonymous" src="${escUrl(preview)}"></audio>
    </div>`;
  };

  function emitUnavailable(el) {
    if (!el || el.dataset.unavailableEmitted === "1") return;
    el.dataset.unavailableEmitted = "1";
    setTimeout(() => {
      el.dispatchEvent(new CustomEvent("mt-unavailable", { bubbles: true }));
    }, 0);
  }

  window.bindPlayers = function (scope) {
    scope = scope || document;
    // Tracks with no preview at all — surface as unavailable so toys can re-pick.
    scope.querySelectorAll(".mt-player-fallback[data-unavailable='1']:not([data-bound])").forEach((el) => {
      el.setAttribute("data-bound", "1");
      emitUnavailable(el);
    });
    scope.querySelectorAll(".mt-player:not([data-bound])").forEach((el) => {
      el.setAttribute("data-bound", "1");
      const audio = el.querySelector(".mt-audio");
      const toggle = el.querySelector(".mt-toggle");
      const bar = el.querySelector(".mt-bar");
      const dur = el.querySelector(".mt-duration");
      const iconPlay = el.querySelector(".mt-icon-play");
      const iconPause = el.querySelector(".mt-icon-pause");
      if (!audio || !toggle) return;

      function setIcons(state) {
        toggle.dataset.state = state;
        iconPlay.style.display = state === "playing" ? "none" : "";
        iconPause.style.display = state === "playing" ? "" : "none";
        toggle.setAttribute("aria-label", state === "playing" ? "Pause" : "Play");
        el.classList.toggle("mt-playing", state === "playing");
      }

      let playAttempts = 0;
      function tryPlay() {
        const attempt = () => {
          if (audio.dataset.giveup === "1") return;
          playAttempts++;
          const p = audio.play();
          if (p && typeof p.catch === "function") {
            p.catch((err) => {
              // NotAllowedError = autoplay blocked by browser policy. Don't keep retrying;
              // the toggle stays visible so the user can press play themselves.
              if (err && err.name === "NotAllowedError") {
                audio.dataset.giveup = "1";
                return;
              }
              if (playAttempts < 5) {
                const onReady = () => attempt();
                audio.addEventListener("canplay", onReady, { once: true });
                audio.addEventListener("canplaythrough", onReady, { once: true });
                audio.addEventListener("loadeddata", onReady, { once: true });
              } else {
                // Out of retries with a load-related error — treat as unavailable.
                emitUnavailable(el);
              }
            });
          }
        };
        if (audio.readyState >= 2) {
          attempt();
        } else {
          try { audio.load(); } catch {}
          audio.addEventListener("canplay", attempt, { once: true });
          audio.addEventListener("loadeddata", attempt, { once: true });
          attempt();
        }
      }

      // The audio source itself failed to load (404, CORS, network) — unavailable.
      audio.addEventListener("error", () => emitUnavailable(el));

      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (audio.paused) tryPlay(); else audio.pause();
      });
      el.addEventListener("click", (e) => {
        if (e.target === toggle || (toggle && toggle.contains(e.target))) return;
        if (audio.paused) tryPlay(); else audio.pause();
      });

      audio.addEventListener("play", () => {
        // Solo mode: pause every other player on the page
        document.querySelectorAll(".mt-audio").forEach((a) => {
          if (a !== audio && !a.paused) a.pause();
        });
        setIcons("playing");
      });
      audio.addEventListener("pause", () => setIcons("paused"));
      audio.addEventListener("ended", () => {
        setIcons("paused");
        bar.style.width = "100%";
        el.dispatchEvent(new CustomEvent("mt-ended", { bubbles: true }));
      });
      audio.addEventListener("timeupdate", () => {
        const total = audio.duration || 30;
        const pct = total ? (audio.currentTime / total) * 100 : 0;
        bar.style.width = pct + "%";
        if (dur) {
          const remaining = Math.max(0, Math.floor(total - audio.currentTime));
          dur.textContent = "0:" + String(remaining).padStart(2, "0");
        }
      });

      if (el.dataset.autoplay === "1") {
        // Try once; mobile may block, in which case the toggle is right there.
        tryPlay();
      }
    });
  };

  document.addEventListener("DOMContentLoaded", () => window.bindPlayers());
})();
