// Offscreen document: fetches audio from the local engine (Piper or Kokoro,
// both through the VoiceDock hub's POST /tts) and plays it, one sentence at a time, so the popup and the player bar can
// say "Sentence 3 of 6" and skip back or forward a sentence.
// This runs in a real DOM context, unlike the service worker.
import { splitSentences } from "./src/shared.js";

let currentAudio = null;
let currentBlobUrl = null;
let rejectCurrentPlay = null;    // C1: lets stopCurrentAudio() settle a pending playBlob() Promise
let currentDisconnectNodes = null; // stores the active chunk's disconnectNodes so stopCurrentAudio can call it
let currentGainNode = null;      // exposed so set-volume can adjust gain in real-time
let audioCtx = null;             // Web Audio API context - reused across chunks for volume boost
let playbackQueue = [];
let isPlaying = false;
let isPaused  = false; // true while audio is paused mid-queue
let playGeneration = 0; // incremented on each new speak request; stale queues self-terminate
let currentVolume = 1.0; // updated by speak-text and set-volume; used for per-chunk initial gain
let currentRate = 1.0;   // updated by speak-text and set-rate; applied live + to later chunks
let currentEngine = "piper"; // engine of the active speak-text request
let jumpTo = null;           // sentence index a skip asked for, taken by playQueue

const ENGINE_LABELS = { piper: "Piper", kokoro: "Kokoro" };
const engineLabel = (engine) => ENGINE_LABELS[engine] || "TTS";

function sendProgress(current, total, label = "") {
  if (current > 0) currentIndex = current - 1;
  chrome.runtime.sendMessage({
    type: "playback-progress",
    engine: currentEngine,
    current,
    total,
    percent: total > 0 ? current / total : null,
    label
  }).catch(() => {});
}

// ─── Fetch Audio from the local engine ────────────────────────────────────────
// V2 fix: 30s per-chunk timeout so a server that accepts TCP but stalls never
// leaves the queue hanging indefinitely.
const FETCH_TIMEOUT_MS = 30_000;

// In-flight fetches so a stop (or a new speak request) can abort a prefetch
// that's still synthesizing on the server - otherwise the discarded chunk keeps
// running for up to FETCH_TIMEOUT_MS, wasting engine CPU on audio nobody hears.
const activeFetches = new Set();
function abortPendingFetches() {
  for (const c of activeFetches) { try { c.abort(); } catch (_) {} }
  activeFetches.clear();
}

async function fetchEngineAudio(text, ttsUrl, voice = "", engine = currentEngine) {
  const controller = new AbortController();
  activeFetches.add(controller);
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(ttsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(voice ? { text, engine, voice } : { text, engine }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer); // always clear, whether fetch succeeded, failed, or aborted
    activeFetches.delete(controller);
  }

  if (!response.ok) {
    let details = "";
    let reason = "";
    try {
      const body = await response.json();
      details = body.error || "";
      reason = typeof body.reason === "string" ? body.reason : "";
    } catch (_) {}
    const err = new Error(details || `${engineLabel(engine)} could not read (error ${response.status})`);
    err.reason = reason; // the hub's "not-installed", "low-memory" or "failed"
    throw err;
  }

  return response.blob();
}

// ─── Play a Single Audio Blob ─────────────────────────────────────────────────
// C1: stores its own reject in rejectCurrentPlay so stopCurrentAudio() can
//     settle the Promise immediately when stop is called mid-playback.
// C5: reads MediaError from e.target.error instead of the undefined e.message.
// C6: accepts rate and applies it via audio.playbackRate.
function playBlob(blob, volume = 1.0, rate = 1.0) {
  return new Promise((resolve, reject) => {
    // Settle any prior pending playBlob (guard against concurrent calls)
    stopCurrentAudio();

    // Register our reject so stopCurrentAudio can settle this Promise
    rejectCurrentPlay = reject;

    const url = URL.createObjectURL(blob);
    currentBlobUrl = url;
    currentAudio = new Audio(url);
    currentAudio.playbackRate = Math.max(0.1, Math.min(4.0, rate));

    // Volume via Web Audio API GainNode - allows values > 1.0 for boost.
    // Standard audio.volume is capped at 1.0; GainNode has no upper limit.
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new AudioContext();
    }
    const source = audioCtx.createMediaElementSource(currentAudio);
    const gain   = audioCtx.createGain();
    gain.gain.value = Math.max(0, volume);
    source.connect(gain);
    gain.connect(audioCtx.destination);
    audioCtx.resume().catch(() => {});
    currentGainNode = gain; // expose so set-volume can adjust in real-time

    // Disconnect Web Audio nodes after use to prevent accumulating dead nodes
    // on the shared AudioContext across chunks. Each playBlob call creates a
    // new source+gain pair; without disconnect they linger until the context
    // is GC'd, which may never happen during a long session.
    let nodesDisconnected = false;
    function disconnectNodes() {
      if (nodesDisconnected) return;
      nodesDisconnected = true;
      if (currentGainNode === gain) currentGainNode = null; // clear only if still this chunk's node
      currentDisconnectNodes = null; // clear module-level ref once called
      try { source.disconnect(); } catch (_) {}
      try { gain.disconnect();  } catch (_) {}
    }
    // Expose to stopCurrentAudio() so it can disconnect nodes when stop is
    // called mid-playback (onended/onerror/play.catch won't fire on a pause).
    currentDisconnectNodes = disconnectNodes;

    currentAudio.onended = () => {
      rejectCurrentPlay = null;
      disconnectNodes();
      URL.revokeObjectURL(url);
      currentBlobUrl = null;
      currentAudio = null;
      resolve();
    };

    // C5 fix: e is a plain Event; the actual error lives at e.target.error (MediaError)
    currentAudio.onerror = (e) => {
      rejectCurrentPlay = null;
      disconnectNodes();
      URL.revokeObjectURL(url);
      currentBlobUrl = null;
      currentAudio = null;
      const mediaErr = e.target?.error;
      const msg =
        mediaErr?.message ||
        (mediaErr?.code != null ? `MediaError code ${mediaErr.code}` : null) ||
        "unknown audio error";
      reject(new Error("Audio playback error: " + msg));
    };

    currentAudio.play().catch((err) => {
      rejectCurrentPlay = null;
      disconnectNodes();
      reject(err);
    });
  });
}

// ─── Stop Current Audio ───────────────────────────────────────────────────────
// C1 fix: explicitly rejects the pending playBlob() Promise before clearing
// audio state, so await playBlob() in playQueue() always settles on stop.
function stopCurrentAudio() {
  if (rejectCurrentPlay) {
    const r = rejectCurrentPlay;
    rejectCurrentPlay = null;
    // V3 fix: use a sentinel property instead of string comparison so browser
    // DOMExceptions with coincidentally matching messages are never misidentified.
    const stopErr = new Error("Playback stopped");
    stopErr.isStop = true;
    r(stopErr); // settles the pending playBlob Promise
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  // Disconnect Web Audio nodes for the chunk that was just stopped.
  // (disconnectNodes is a closure inside playBlob; we keep a module-level
  //  reference so we can call it from here even when stop fires mid-playback.)
  if (currentDisconnectNodes) {
    currentDisconnectNodes();
    currentDisconnectNodes = null;
  }
}

// ─── Stop and Clear Queue ─────────────────────────────────────────────────────
function stopAll() {
  playbackQueue = [];
  isPlaying = false;
  isPaused  = false;
  abortPendingFetches(); // cancel any prefetch still synthesizing on the server
  stopCurrentAudio();
}

// ─── Sentence Queue Player ────────────────────────────────────────────────────
// background.js checks the engine first and fires speak-text without waiting,
// so playQueue just plays sentences until done, stopped, or an error occurs.
// volume/rate are intentionally NOT parameters: playBlob reads the live module
// values currentVolume/currentRate (set by speak-text and updated by the
// popup and the player bar) so adjustments carry across sentences.
async function playQueue(sentences, ttsUrl, voice, engine, generation) {
  isPlaying = true;
  playbackQueue = [...sentences];
  const total = sentences.length;
  let failed = false;
  sendProgress(0, total, "Starting");

  const live = () => isPlaying && playGeneration === generation;

  // Synthesize sentence i+1 while sentence i plays, so there's no gap. The
  // .then(ok, err) wrapper keeps a prefetched promise from rejecting unhandled.
  const fetched = new Map();
  const fetchSentence = (i) => {
    if (!fetched.has(i)) {
      fetched.set(i, fetchEngineAudio(sentences[i], ttsUrl, voice, engine).then((blob) => ({ blob }), (err) => ({ err })));
    }
    return fetched.get(i);
  };

  // index: the sentence that failed, so the Basic voice can read on from it.
  const reportError = (err, index) => {
    if (err && err.isStop === true) return; // intentional stop - exit silently
    if (live()) {
      console.error("TTS sentence error:", err);
      failed = true;
      chrome.runtime.sendMessage({
        type: "playback-error",
        engine,
        reason: (err && err.reason) || "",
        index,
        error: (err && err.message) || `${engineLabel(engine)} playback failed.`
      }).catch(() => {});
    }
  };

  let i = 0;
  let firstAudio = true;
  while (i < total && live()) {
    sendProgress(i + 1, total, `${i + 1}/${total}`);
    const { blob, err } = await fetchSentence(i);
    if (!err && firstAudio && live()) {
      firstAudio = false;
      chrome.runtime.sendMessage({ type: "engine-audio", engine }).catch(() => {});
    }
    if (i + 1 < total) fetchSentence(i + 1);
    // Keep memory flat on long reads: forget audio more than one sentence back.
    fetched.delete(i - 2);

    if (!live()) break;
    if (jumpTo !== null) { i = jumpTo; jumpTo = null; continue; }
    if (err) { reportError(err, i); break; }

    // Paused between sentences: wait for resume-audio (or a skip).
    if (isPaused) {
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (!isPaused || !live() || jumpTo !== null) { clearInterval(check); resolve(); }
        }, 100);
      });
      if (!live()) break;
      if (jumpTo !== null) { i = jumpTo; jumpTo = null; continue; }
    }

    try {
      await playBlob(blob, currentVolume, currentRate);
    } catch (playErr) {
      if (playErr.isSkip === true) { i = jumpTo ?? i; jumpTo = null; continue; }
      if (playErr.isStop === true) break; // intentional stop
      reportError(playErr, i);
      break;
    }
    if (jumpTo !== null) { i = jumpTo; jumpTo = null; continue; }
    i += 1;
  }

  // Only reset isPlaying if we're still the active generation
  if (playGeneration === generation) {
    isPlaying = false;
    isPaused  = false;
    if (!failed) {
      // Notify background so it can update the popup's now-playing indicator
      chrome.runtime.sendMessage({ type: "playback-ended" }).catch(() => {});
    }
  }
}

// Skip to another sentence: delta -1 restarts the current sentence when it
// has played for more than two seconds (as music players do), else goes back.
let currentIndex = 0;
function skipSentence(delta) {
  if (!isPlaying || playbackQueue.length === 0) return;
  const total = playbackQueue.length;
  let target = currentIndex + delta;
  if (delta < 0 && currentAudio && currentAudio.currentTime > 2) target = currentIndex;
  target = Math.max(0, Math.min(total - 1, target));
  jumpTo = target;
  if (currentAudio) {
    // Settle the playing sentence's promise as a skip, not a stop.
    if (rejectCurrentPlay) {
      const r = rejectCurrentPlay;
      rejectCurrentPlay = null;
      const skipErr = new Error("Skipped");
      skipErr.isSkip = true;
      r(skipErr);
    }
    stopCurrentAudio();
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "stop-audio") {
    stopAll();
    return; // no async response needed
  }

  if (message.type === "pause-audio") {
    if (isPlaying) {
      isPaused = true;                             // set regardless of whether a chunk is mid-play
      if (currentAudio && !currentAudio.paused) {
        currentAudio.pause();
      }
    }
    return;
  }

  if (message.type === "resume-audio") {
    if (isPaused) {
      isPaused = false;
      if (currentAudio && currentAudio.paused) {
        currentAudio.play().catch(() => {});
      }
      // If currentAudio is null the queue is between chunks; it will check isPaused
      // before calling playBlob and resume naturally.
    }
    return;
  }

  if (message.type === "skip-audio") {
    skipSentence(message.delta < 0 ? -1 : 1);
    return;
  }

  if (message.type === "set-volume") {
    // Real-time gain adjustment from the overlay rocker
    currentVolume = Math.max(0, message.volume ?? 1.0);
    if (currentGainNode) currentGainNode.gain.value = currentVolume;
    return;
  }

  if (message.type === "set-rate") {
    // Real-time playback-speed adjustment from the overlay rocker. Applies to the
    // currently playing chunk immediately and to later chunks via currentRate.
    currentRate = Math.max(0.1, Math.min(4.0, message.rate ?? 1.0));
    if (currentAudio) currentAudio.playbackRate = currentRate;
    return;
  }

  if (message.type === "speak-text") {
    const { text, ttsUrl, engine = "piper", volume = 1.0, rate = 1.0, voice = "" } = message;
    currentVolume = volume; // live value; playQueue reads this for each chunk
    currentRate = rate;     // live value; playQueue reads this for each chunk

    // Stop previous playback and bump generation so stale queues self-terminate
    stopAll();
    playGeneration++;
    const gen = playGeneration;
    currentEngine = engine;

    jumpTo = null;
    currentIndex = 0;
    const sentences = splitSentences(text);
    if (sentences.length === 0) sentences.push(text);

    // Fire-and-forget: background.js no longer awaits a response, so respond
    // immediately and let playback run independently. This eliminates the
    // long-lived message channel that Chrome was killing mid-flight.
    playQueue(sentences, ttsUrl, voice, engine, gen).catch((err) => {
      console.error("Queue playback error:", err);
    });

    sendResponse({ ok: true });
    return false; // synchronous response already sent - port can close immediately
  }
});
