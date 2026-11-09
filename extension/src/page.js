// ─── VoiceDock - page script ─────────────────────────────────────────────────
// Bundled by esbuild into dist/page.js. Not a declared content script:
// background.js injects the bundle with
// chrome.scripting only into the tab the user is reading from, after a gesture
// that grants activeTab (the right-click menu, the keyboard shortcut or the
// toolbar button). It provides:
//   1. The selection bridge for the keyboard shortcut
//   2. The floating "Now Playing" overlay (shadow DOM, bottom-right corner)
//   3. Short hints ("Select text first", "Starting Kokoro, about 3 s")
//   4. Notes that stay until dismissed when an engine can't read: what
//      happened, and one fix (the engine's guided setup)
//
import { iconElement } from "./icons.js";
import { engineLabel, sentenceLabel } from "./shared.js";
import TOKENS_SOURCE from "../tokens.css";

// The whole bundle is one function so it can be injected again (after an
// extension update, say) without redeclaring anything; background.js pings the
// tab first and only injects when nothing answers.
(() => {

  // Cache last known selection so modifier keys can't clear it before our handler reads it
  let _lastSelection = "";
  const _snapshotSel = () => {
    const s = window.getSelection()?.toString().trim();
    if (s) _lastSelection = s;
  };
  document.addEventListener("mouseup",         _snapshotSel, true);
  document.addEventListener("selectionchange", _snapshotSel);
  document.addEventListener("keyup",           _snapshotSel, true); // keyboard selections (Shift+arrow)

  // ─── Local playback state (optimistic - for instant UI updates) ───────────────
  let _localPlaying  = false;
  let _localPaused   = false;
  let _currentVolume = 1.0;
  let _currentRate   = 1.0;
  let _currentEngine = null; // "piper" | "kokoro" | "browser": browser TTS can't adjust live
  let _startingText = "";    // "Starting Kokoro, about 3 s" until a cold engine's first audio
  let _note = null;          // { tone, text, fix } until dismissed or the next read
  let _runtimeUnavailable = false;
  let _playbackPollTimer = null;

  function isRuntimeUnavailableError(error) {
    const message = String(error?.message || error || "");
    return /Extension context invalidated|Receiving end does not exist/i.test(message);
  }

  function isExpectedRuntimeMessageError(error) {
    const message = String(error?.message || error || "");
    return isRuntimeUnavailableError(error) || /message port closed|message channel closed/i.test(message);
  }

  function markRuntimeUnavailable() {
    _runtimeUnavailable = true;
    if (_playbackPollTimer) {
      clearInterval(_playbackPollTimer);
      _playbackPollTimer = null;
    }
  }

  function getRuntimeLastError() {
    try {
      return chrome.runtime.lastError || null;
    } catch (error) {
      if (isRuntimeUnavailableError(error)) {
        markRuntimeUnavailable();
        return error;
      }
      console.warn("[VoiceDock] runtime lastError failed", error);
      return error;
    }
  }

  function safeRuntimeCallback(callback) {
    return (...args) => {
      if (_runtimeUnavailable) return;
      try {
        callback(...args);
      } catch (error) {
        if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
        else console.warn("[VoiceDock] runtime callback failed", error);
      }
    };
  }

  function sendRuntimeMessage(message, callback) {
    if (_runtimeUnavailable) return;

    try {
      const maybePromise = callback
        ? chrome.runtime.sendMessage(message, safeRuntimeCallback(callback))
        : chrome.runtime.sendMessage(message);

      if (maybePromise?.catch) {
        maybePromise.catch((error) => {
          if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
          else if (!isExpectedRuntimeMessageError(error)) console.warn("[VoiceDock] runtime message failed", error);
        });
      }
    } catch (error) {
      if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
      else if (!isExpectedRuntimeMessageError(error)) console.warn("[VoiceDock] runtime message failed", error);
    }
  }

  function applyPlaybackState(state) {
    if (!state) return;
    _localPlaying = !!state.isPlaying;
    _localPaused  = !!state.isPaused;
    if (state.volume != null) _currentVolume = state.volume;
    if (state.rate != null) _currentRate = state.rate;
    if (state.engine !== undefined) _currentEngine = state.engine;
    _startingText = state.starting ? (state.startingText || "") : "";
    updateOverlay(_localPlaying, _localPaused, state.progress);
  }

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "playback-state") {
        applyPlaybackState(message.state);
        return;
      }
      if (message.type === "ping") {
        sendResponse({ ok: true });
        return;
      }
      if (message.type === "get-selection") {
        const text = window.getSelection()?.toString().trim() || _lastSelection;
        sendResponse({ text });
        return;
      }
      if (message.type === "show-hint") {
        showHint(message.message || "");
        return;
      }
      if (message.type === "show-note") {
        showNote(message.note || null);
      }
    });
  } catch (error) {
    if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
    else console.warn("[VoiceDock] runtime listener failed", error);
  }

  // Stop when this tab navigates away or closes
  window.addEventListener("pagehide", () => {
    sendRuntimeMessage({ type: "tab-unloading" });
  });

  // ─── Overlay ──────────────────────────────────────────────────────────────────
  let overlayHost   = null;
  let overlayShadow = null;

  // The design tokens (tokens.css) without its @font-face rules: inside a
  // shadow root those would ask the host page's server for the font files.
  const TOKENS_CSS = TOKENS_SOURCE.replace(/@font-face\s*{[^}]*}/g, "");
  const OVERLAY_CSS = TOKENS_CSS + `
    :host {
      all: initial;
      position: fixed !important;
      bottom: 24px !important;
      right: 24px !important;
      z-index: 2147483647 !important;
      pointer-events: auto !important;
      display: block !important;
      font: 400 13px/1.3 var(--f-ui);
      color: var(--ink);
      -webkit-font-smoothing: antialiased;
    }
    * { box-sizing: border-box; }

    /* Notes and hints sit above the bar, right-aligned. */
    .stack { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }

    /* ── A note: amber while VoiceDock still reads, red when nothing can ── */
    .note {
      display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 4px 10px;
      width: 360px; padding: 10px 8px 10px 12px;
      background: color-mix(in srgb, var(--warn-soft) 75%, var(--surface));
      border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line));
      border-radius: 12px; box-shadow: var(--shadow-pop);
      font-size: 12.5px; line-height: 1.45; color: var(--ink);
    }
    .note.err {
      background: color-mix(in srgb, var(--err-soft) 75%, var(--surface));
      border-color: color-mix(in srgb, var(--err) 35%, var(--line));
    }
    .note-icon { color: var(--warn); padding-top: 1px; display: flex; }
    .note.err .note-icon { color: var(--err); }
    .note-text { padding-top: 1px; }
    .note-fix {
      grid-column: 2; justify-self: start; margin-top: 4px;
      font: 600 12px/1 var(--f-ui); color: var(--accent-ink); background: var(--accent);
      border: 0; border-radius: 7px; padding: 7px 10px; cursor: pointer;
    }
    .note-fix:hover { background: var(--accent-hover); }
    .note .note-close { color: var(--muted); }
    .note .note-close:hover { background: color-mix(in srgb, var(--ink) 8%, transparent); color: var(--ink); }
    .note-fix:focus-visible, .note-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .note-close { width: 26px; height: 26px; }

    /* ── The bar ── */
    .bar {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 360px;
      padding: 7px 6px 7px 8px;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: var(--shadow-pop);
    }

    /* The VoiceDock mark on its ink tile */
    .brand {
      width: 26px; height: 26px; border-radius: 7px; flex: none;
      display: grid; place-items: center;
      background: var(--mark-ink); color: var(--mark-hi);
    }
    .btn svg, .brand svg { display: block; }

    .btn {
      background: transparent; border: none; padding: 0; cursor: pointer; flex: none;
      width: 30px; height: 30px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      color: var(--muted);
      transition: background 0.15s, color 0.15s;
    }
    .btn:hover { background: var(--surface-2); color: var(--ink); }
    .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

    /* Play / pause: the one filled control */
    .btn-pp { width: 32px; height: 32px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); }
    .btn-pp:hover { background: var(--accent-hover); color: var(--accent-ink); }

    /* What is happening: "Reading sentence 2 of 6 · Kokoro", then a thin line */
    .info { flex: 1; min-width: 0; display: grid; gap: 5px; padding: 0 6px 0 4px; }
    .lbl {
      display: flex; align-items: center; gap: 6px; min-width: 0;
      font-size: 12px; font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    .lbl-text { overflow: hidden; text-overflow: ellipsis; }
    .meta { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .meta .prog { flex: 1; }
    .lbl-engine { color: var(--muted); font-size: 11px; font-weight: 500; flex: none; white-space: nowrap; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); flex: none; }
    .dot.live { background: var(--accent); animation: vd-bar-pulse 1.6s ease-in-out infinite; }
    @keyframes vd-bar-pulse { 0%, 100% { opacity: 0.35; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.15); } }
    .lbl.paused .lbl-text { color: var(--muted); }
    @media (prefers-color-scheme: dark) { .brand { background: var(--surface-3); } }

    .prog { height: 3px; background: var(--surface-3); border-radius: 999px; overflow: hidden; }
    .prog-fill { display: block; width: 0%; height: 100%; background: var(--accent); border-radius: inherit; transition: width 0.3s ease; }
    .prog-fill.is-indeterminate { width: 35%; animation: tts-progress-slide 1.1s ease-in-out infinite alternate; }
    @keyframes tts-progress-slide { from { transform: translateX(-60%); } to { transform: translateX(240%); } }

    /* ── Volume + speed hover rocker ── */
    .vol-wrap { position: relative; display: flex; align-items: center; }
    .rocker {
      position: absolute;
      bottom: 100%;
      right: -6px;
      /* Transparent bridge so moving the cursor up into the panel doesn't drop the
         :hover and snap it shut. */
      padding-bottom: 10px;
      display: none;
    }
    .vol-wrap:hover .rocker,
    .rocker:hover { display: block; }
    .rocker-panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 12px;
      box-shadow: var(--shadow-pop);
      padding: 10px 12px;
      width: 200px;
    }
    .rocker-row { display: grid; grid-template-columns: 48px 1fr 40px; align-items: center; gap: 8px; }
    .rocker-row + .rocker-row { margin-top: 9px; }
    .rocker-lbl { font-size: 11px; font-weight: 500; color: var(--faint); }
    .rocker-val { font-size: 12px; font-weight: 600; color: var(--ink); text-align: right; font-variant-numeric: tabular-nums; }
    .rocker-slider { width: 100%; margin: 0; accent-color: var(--accent); cursor: pointer; }
    .rocker-panel.is-disabled .rocker-slider { cursor: not-allowed; opacity: 0.45; }
    .rocker-panel.is-disabled .rocker-lbl,
    .rocker-panel.is-disabled .rocker-val { color: var(--faint); }
    .rocker-note { display: none; margin-top: 9px; font-size: 11px; line-height: 1.35; color: var(--warn); }

    /* ── Hint toast ── */
    .hint-bar {
      padding: 8px 14px;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 999px;
      box-shadow: var(--shadow-pop);
      font-size: 12px;
      font-weight: 600;
      color: var(--ink);
      pointer-events: none;
      user-select: none;
      white-space: nowrap;
    }
  `;

  function ensureOverlay() {
    // Re-attach if a page framework removed our host node
    if (overlayHost && !document.contains(overlayHost)) {
      (document.body || document.documentElement).appendChild(overlayHost);
    }
    if (overlayHost) return overlayShadow;

    overlayHost   = document.createElement("div");
    overlayShadow = overlayHost.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = OVERLAY_CSS;
    const stack = document.createElement("div");
    stack.className = "stack";
    overlayShadow.append(style, stack);

    (document.body || document.documentElement).appendChild(overlayHost);
    return overlayShadow;
  }

  function removeOverlay() {
    if (!overlayHost) return;
    overlayHost.remove();
    overlayHost = overlayShadow = null;
  }

  const stackOf = (shadow) => shadow.querySelector(".stack");

  // Nothing left to show (no note, hint or bar): take the host off the page.
  function removeOverlayIfEmpty() {
    if (overlayShadow && !stackOf(overlayShadow).childElementCount) removeOverlay();
  }

  // A short hint never replaces the bar or a note: it sits above the bar.
  let _hintTimer = null;
  function showHint(msg) {
    const stack = stackOf(ensureOverlay());
    stack.querySelectorAll(".hint-bar").forEach(el => el.remove());

    const hint = document.createElement("div");
    hint.className = "hint-bar";
    hint.setAttribute("role", "status");
    hint.textContent = msg;
    stack.insertBefore(hint, stack.querySelector(".bar"));

    clearTimeout(_hintTimer);
    _hintTimer = setTimeout(() => {
      hint.remove();
      removeOverlayIfEmpty();
    }, 2500);
  }

  // A note stays until dismissed or the next read (background.js sends null).
  function showNote(note) {
    _note = note && typeof note.text === "string" ? note : null;
    if (!_note) {
      overlayShadow?.querySelectorAll(".note").forEach(el => el.remove());
      removeOverlayIfEmpty();
      return;
    }
    const stack = stackOf(ensureOverlay());
    stack.querySelectorAll(".note").forEach(el => el.remove());
    const box = document.createElement("div");
    box.className = `note ${_note.tone === "err" ? "err" : "warn"}`;
    // Red means nothing reads: interrupt. Amber: VoiceDock still reads.
    box.setAttribute("role", _note.tone === "err" ? "alert" : "status");
    const ic = document.createElement("span");
    ic.className = "note-icon";
    ic.appendChild(icon(_note.tone === "err" ? "alert" : "warn", 16));
    const text = document.createElement("span");
    text.className = "note-text";
    text.textContent = _note.text;
    const close = document.createElement("button");
    close.className = "btn note-close";
    close.title = "Dismiss";
    close.setAttribute("aria-label", "Dismiss");
    close.appendChild(icon("close", 14));
    close.addEventListener("click", () => showNote(null));
    box.append(ic, text, close);
    if (_note.fix && _note.fix.label) {
      const fix = document.createElement("button");
      fix.className = "note-fix";
      fix.textContent = _note.fix.label;
      fix.addEventListener("click", () => sendRuntimeMessage({ type: "open-setup", engine: _note.fix.engine }));
      box.appendChild(fix);
    }
    stack.prepend(box);
  }

  // Icons come from the shared set (src/icons.js), drawn as inline SVG so the
  // bar looks the same on every system instead of depending on emoji fonts.
  const icon = (name, size) => iconElement(name, size);

  function setIcon(button, name, size) {
    if (button.dataset.icon === name) return;
    button.dataset.icon = name;
    button.replaceChildren(icon(name, size));
  }

  function fmtVol(v) {
    return Math.round((v ?? 1.0) * 100) + "%";
  }

  function fmtRate(v) {
    return (Math.round((v ?? 1.0) * 10) / 10).toFixed(1) + "×";
  }

  // Builds the speaker button + the hover popover holding the Speed and Volume
  // sliders. Adjustments change only the current playback - they are NOT written
  // back to the saved profile (background.js handles set-live-* without storage).
  function buildRocker() {
    const wrap = document.createElement("div");
    wrap.className = "vol-wrap";

    const btn = document.createElement("button");
    btn.className = "btn btn-vol";
    btn.appendChild(icon("volume", 16));
    btn.title = "Volume & speed";
    btn.setAttribute("aria-label", "Volume and speed");

    const rocker = document.createElement("div");
    rocker.className = "rocker";
    const panel = document.createElement("div");
    panel.className = "rocker-panel";

    const makeRow = (label, min, max, step, fmt, msgType, key) => {
      const row = document.createElement("div");
      row.className = "rocker-row";

      const lbl = document.createElement("span");
      lbl.className = "rocker-lbl";
      lbl.textContent = label;

      const slider = document.createElement("input");
      slider.className = "rocker-slider";
      slider.type = "range";
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(step);

      const val = document.createElement("span");
      val.className = "rocker-val";

      slider.addEventListener("input", () => {
        const v = Number.parseFloat(slider.value);
        val.textContent = fmt(v);
        if (key === "volume") _currentVolume = v; else _currentRate = v;
        sendRuntimeMessage({ type: msgType, [key]: v });
      });

      row.append(lbl, slider, val);
      return { row, slider, val };
    };

    const speed = makeRow("Speed", 0.5, 2.5, 0.1, fmtRate, "set-live-rate", "rate");
    const vol   = makeRow("Volume", 0, 2, 0.05, fmtVol, "set-live-volume", "volume");

    const note = document.createElement("div");
    note.className = "rocker-note";
    note.textContent = "The Basic voice can’t change these mid-read.";

    panel.append(speed.row, vol.row, note);
    rocker.appendChild(panel);
    wrap.append(btn, rocker);

    wrap._refs = { speed, vol, note, panel };
    return wrap;
  }

  // Reflects current engine + values onto the rocker. Skips moving the sliders
  // while the user is hovering/dragging so periodic state pushes don't fight them.
  function syncRocker(wrap) {
    if (!wrap || !wrap._refs) return;
    const { speed, vol, note, panel } = wrap._refs;

    const isBrowser = _currentEngine === "browser";
    speed.slider.disabled = isBrowser;
    vol.slider.disabled = isBrowser;
    panel.classList.toggle("is-disabled", isBrowser);
    note.style.display = isBrowser ? "block" : "none";

    if (wrap.matches(":hover")) return;
    speed.slider.value = String(_currentRate);
    speed.val.textContent = fmtRate(_currentRate);
    vol.slider.value = String(_currentVolume);
    vol.val.textContent = fmtVol(_currentVolume);
  }

  let _lastProgress = null;

  function updateOverlay(isPlaying, isPaused, progress = _lastProgress) {
    _lastProgress = progress;
    if (!isPlaying && !isPaused) {
      overlayShadow?.querySelector(".bar")?.remove();
      removeOverlayIfEmpty();
      return;
    }

    const shadow = ensureOverlay();

    let bar = shadow.querySelector(".bar");
    if (!bar) {
      // ── The mark ──
      const brand = document.createElement("span");
      brand.className = "brand";
      brand.title = "VoiceDock";
      brand.appendChild(icon("mark", 20));

      // ── Play/Pause button ──
      const btnPP = document.createElement("button");
      btnPP.className = "btn btn-pp";
      btnPP.addEventListener("click", () => {
        if (!_localPlaying) return;
        _localPaused = !_localPaused;
        updateOverlay(_localPlaying, _localPaused); // instant update
        sendRuntimeMessage({ type: "keyboard-pause" });
      });

      // ── What is reading, and where: a line of text over a thin progress line ──
      const info = document.createElement("div");
      info.className = "info";
      const lbl = document.createElement("div");
      lbl.className = "lbl";
      const dot = document.createElement("span");
      dot.className = "dot";
      const lblText = document.createElement("span");
      lblText.className = "lbl-text";
      const lblEngine = document.createElement("span");
      lblEngine.className = "lbl-engine";
      lbl.append(dot, lblText);
      const prog = document.createElement("div");
      prog.className = "prog";
      const progFill = document.createElement("span");
      progFill.className = "prog-fill";
      prog.appendChild(progFill);
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.append(prog, lblEngine);
      info.append(lbl, meta);

      // ── Volume + speed rocker (hover the speaker icon) ──
      const volWrap = buildRocker();

      // ── Stop button ──
      const btnClose = document.createElement("button");
      btnClose.className = "btn btn-close";
      btnClose.title = "Stop";
      btnClose.setAttribute("aria-label", "Stop");
      btnClose.appendChild(icon("close", 16));
      btnClose.addEventListener("click", () => {
        _localPlaying = false;
        _localPaused  = false;
        sendRuntimeMessage({ type: "stop-all" });
        bar.remove();
        removeOverlayIfEmpty();
      });

      bar = document.createElement("div");
      bar.className = "bar";
      bar.setAttribute("role", "region");
      bar.setAttribute("aria-label", "VoiceDock player");
      bar.append(brand, btnPP, info, volWrap, btnClose);
      stackOf(shadow).appendChild(bar);
    }

    const btnPP  = bar.querySelector(".btn-pp");
    const lbl    = bar.querySelector(".lbl");
    const dot    = bar.querySelector(".dot");
    const lblText = bar.querySelector(".lbl-text");
    const lblEngine = bar.querySelector(".lbl-engine");
    const progFill = bar.querySelector(".prog-fill");

    // Reflect current engine + volume/speed onto the rocker
    syncRocker(bar.querySelector(".vol-wrap"));

    if (progress?.total > 0) {
      const percent = Math.max(0, Math.min(1, (progress.current || 0) / progress.total));
      progFill.classList.remove("is-indeterminate");
      progFill.style.width = Math.round(percent * 100) + "%";
    } else {
      progFill.style.width = "";
      progFill.classList.add("is-indeterminate");
    }

    const sentence = sentenceLabel(progress);
    const started = (progress?.current || 0) > 0;
    lblEngine.textContent = _currentEngine ? engineLabel(_currentEngine) : "";
    if (isPaused) {
      setIcon(btnPP, "play", 14);
      btnPP.title = "Resume";
      btnPP.setAttribute("aria-label", "Resume");
      lblText.textContent = started ? `Paused · ${sentence.toLowerCase()}` : "Paused";
      lbl.className = "lbl paused";
      dot.className = "dot";
    } else {
      setIcon(btnPP, "pause", 14);
      btnPP.title = "Pause";
      btnPP.setAttribute("aria-label", "Pause");
      // A cold engine: say how long, until its first audio (background.js).
      lblText.textContent = _startingText || (started ? `Reading ${sentence.toLowerCase()}` : "Starting");
      lbl.className = "lbl";
      // The pulse means sound is coming out: only once a sentence plays.
      dot.className = started && !_startingText ? "dot live" : "dot";
    }
  }

  // One initial sync; later changes are pushed by background.js via playback-state.
  sendRuntimeMessage({ type: "get-playback-state" }, (resp) => {
    const error = getRuntimeLastError();
    if (error) {
      if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
      return;
    }
    applyPlaybackState(resp);
  });
})();
