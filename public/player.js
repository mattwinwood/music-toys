// Shared audio player for music-toys. Renders Deezer 30-second previews.
//
// Architecture: one singleton <audio> element lives behind every player UI.
// On the first user gesture in the document, we "unlock" it by playing a
// silent buffer — once an audio element has been play()'d via a user gesture,
// browsers (notably Safari) bless it for the rest of the session, so
// subsequent .play() calls work even from async contexts (after fetch).
//
// Usage:
//   1. Include /player.css and /player.js in your toy.
//   2. Build markup with mtPlayerHtml(track, { autoplay: bool }).
//      `track` must have .preview, .cover, .fallbackQuery.
//   3. After injecting markup, call bindPlayers() to wire interactions.
//   4. Listen for "mt-ended" / "mt-unavailable" on a player element if needed.

(function () {
  const DEBUG = true;
  const log = (...args) => { if (DEBUG) console.log("[mt-player]", ...args); };

  function escAttr(s) { return String(s ?? "").replace(/"/g, "&quot;"); }
  function escUrl(s) { return encodeURI(String(s ?? "")); }

  // 1-frame silent WAV (used to "unlock" the audio element on first gesture).
  const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAVFYAAFRWAAABAAgAZGF0YQAAAAA=";

  // ---------- Singleton audio + lifecycle ----------
  let audio = null;
  let activePlayer = null;   // .mt-player div whose visual state mirrors `audio`
  let unlocked = false;
  let unlockArmed = false;

  function getAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = "auto";
    audio.playsInline = true;

    audio.addEventListener("play", () => {
      log("audio play, src:", (audio.src || "").slice(0, 60), "ct:", audio.currentTime.toFixed(2));
      if (activePlayer) {
        setIconsState(activePlayer, "playing");
        // Solo: nothing to do — there's only one audio element by design.
      }
    });
    audio.addEventListener("pause", () => {
      log("audio pause");
      if (activePlayer) setIconsState(activePlayer, "paused");
    });
    audio.addEventListener("ended", () => {
      if (!activePlayer) return;
      setIconsState(activePlayer, "paused");
      const bar = activePlayer.querySelector(".mt-bar");
      if (bar) bar.style.width = "100%";
      activePlayer.dispatchEvent(new CustomEvent("mt-ended", { bubbles: true }));
    });
    audio.addEventListener("timeupdate", () => {
      if (!activePlayer) return;
      const total = audio.duration || 30;
      const pct = total ? (audio.currentTime / total) * 100 : 0;
      const bar = activePlayer.querySelector(".mt-bar");
      const dur = activePlayer.querySelector(".mt-duration");
      if (bar) bar.style.width = pct + "%";
      if (dur) {
        const remaining = Math.max(0, Math.floor(total - audio.currentTime));
        dur.textContent = "0:" + String(remaining).padStart(2, "0");
      }
    });
    audio.addEventListener("error", () => {
      const code = audio.error ? audio.error.code : 0;
      log("audio error code:", code, "src:", (audio.src || "").slice(0, 60));
      // Only NETWORK (2) or SRC_NOT_SUPPORTED (4) signal "track unavailable".
      // ABORTED (1) fires when we swap src; DECODE (3) is rare and not always fatal.
      if ((code === 2 || code === 4) && activePlayer) {
        emitUnavailable(activePlayer, "audio-error-" + code);
      }
    });

    return audio;
  }

  // Unlock the singleton on the first user gesture. The unlock IS the gesture
  // — a play() call on the audio element from inside a real pointerdown/keydown
  // /touchstart handler — and once it succeeds the element stays "blessed".
  function armUnlock() {
    if (unlockArmed || unlocked) return;
    unlockArmed = true;
    const handler = (ev) => {
      if (unlocked) return;
      unlocked = true;
      const a = getAudio();
      try {
        a.muted = true;
        a.src = SILENT_WAV;
        const p = a.play();
        const finish = (ok) => {
          a.pause();
          try { a.currentTime = 0; } catch {}
          a.removeAttribute("src");
          try { a.load(); } catch {}
          a.muted = false;
          log("audio unlock", ok ? "succeeded" : "failed (silent fallback ok)");
        };
        if (p && typeof p.then === "function") {
          p.then(() => finish(true)).catch(() => finish(false));
        } else {
          finish(true);
        }
      } catch (err) {
        log("unlock threw:", err && err.message);
        a.muted = false;
      }
      document.removeEventListener("pointerdown", handler, true);
      document.removeEventListener("keydown", handler, true);
      document.removeEventListener("touchstart", handler, true);
    };
    document.addEventListener("pointerdown", handler, { capture: true });
    document.addEventListener("keydown", handler, { capture: true });
    document.addEventListener("touchstart", handler, { capture: true });
  }

  function setIconsState(el, state) {
    const toggle = el.querySelector(".mt-toggle");
    if (!toggle) return;
    toggle.dataset.state = state;
    const iconPlay = el.querySelector(".mt-icon-play");
    const iconPause = el.querySelector(".mt-icon-pause");
    if (iconPlay) iconPlay.style.display = state === "playing" ? "none" : "";
    if (iconPause) iconPause.style.display = state === "playing" ? "" : "none";
    toggle.setAttribute("aria-label", state === "playing" ? "Pause" : "Play");
    el.classList.toggle("mt-playing", state === "playing");
  }

  function emitUnavailable(el, reason) {
    if (!el || el.dataset.unavailableEmitted === "1") return;
    if (!el.isConnected) { log("skip emitUnavailable on detached:", reason); return; }
    el.dataset.unavailableEmitted = "1";
    log("emit mt-unavailable:", reason);
    setTimeout(() => {
      el.dispatchEvent(new CustomEvent("mt-unavailable", { bubbles: true, detail: { reason } }));
    }, 0);
  }

  function setActive(el) {
    const a = getAudio();
    const src = el.dataset.src || "";
    if (activePlayer === el && a.src === src) return;
    if (activePlayer && activePlayer !== el) {
      setIconsState(activePlayer, "paused");
      const bar = activePlayer.querySelector(".mt-bar");
      if (bar) bar.style.width = "0%";
    }
    activePlayer = el;
    if (src && a.src !== src) {
      a.src = src;
      try { a.load(); } catch {}
    }
  }

  function attemptPlay(el) {
    setActive(el);
    const a = getAudio();
    const p = a.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => {
        log("play() rejected:", err && err.name, "src:", (a.src || "").slice(0, 60));
        // NotAllowedError = autoplay blocked. The visible play button remains
        // for the user to tap. Don't try to be clever — the unlock should
        // prevent this in the common case.
        if (err && err.name === "NotAllowedError") return;
        // AbortError commonly fires when src changes mid-play; safe to ignore.
        if (err && err.name === "AbortError") return;
        // Anything else: wait for the next readiness event and try once more.
        const onReady = () => {
          const p2 = a.play();
          if (p2 && typeof p2.catch === "function") {
            p2.catch((err2) => {
              log("retry play() rejected:", err2 && err2.name);
              if (err2 && (err2.name === "NotAllowedError" || err2.name === "AbortError")) return;
              emitUnavailable(el, "play-failed-after-canplay");
            });
          }
        };
        a.addEventListener("canplay", onReady, { once: true });
        a.addEventListener("loadeddata", onReady, { once: true });
      });
    }
  }

  // ---------- Public API ----------
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
    return `<div class="mt-player"${dataAuto} data-src="${escAttr(escUrl(preview))}">
      ${cover ? `<img class="mt-cover" src="${escAttr(cover)}" alt="" />` : ""}
      <div class="mt-overlay"></div>
      <span class="mt-duration">0:30</span>
      <button class="mt-toggle" data-state="paused" type="button" aria-label="Play">
        <svg class="mt-icon-play" viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
        <svg class="mt-icon-pause" viewBox="0 0 24 24" width="24" height="24" style="display:none"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
      </button>
      <div class="mt-progress"><div class="mt-bar"></div></div>
    </div>`;
  };

  window.bindPlayers = function (scope) {
    scope = scope || document;
    armUnlock();

    scope.querySelectorAll(".mt-player-fallback[data-unavailable='1']:not([data-bound])").forEach((el) => {
      el.setAttribute("data-bound", "1");
      emitUnavailable(el, "no-preview-url");
    });

    scope.querySelectorAll(".mt-player:not([data-bound])").forEach((el) => {
      el.setAttribute("data-bound", "1");
      const toggle = el.querySelector(".mt-toggle");
      if (!toggle) return;

      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const a = getAudio();
        if (activePlayer !== el || a.paused) attemptPlay(el);
        else a.pause();
      });
      el.addEventListener("click", (e) => {
        if (e.target === toggle || (toggle && toggle.contains(e.target))) return;
        const a = getAudio();
        if (activePlayer !== el || a.paused) attemptPlay(el);
        else a.pause();
      });

      if (el.dataset.autoplay === "1") {
        log("autoplay attempt for:", (el.dataset.src || "").slice(0, 60), "unlocked:", unlocked);
        attemptPlay(el);
      }
    });
  };

  document.addEventListener("DOMContentLoaded", () => window.bindPlayers());
})();
