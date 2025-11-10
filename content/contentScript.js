(async function () {
  const utils = window.GMS && window.GMS.hashUtils;
  if (!utils) {
    console.error("hashUtils not loaded");
    return;
  }

  // ========== Config ==========
  const SAMPLE_INTERVAL_MS = 1000; // sample every second
  const CHANGE_THRESHOLD = 0.25; // composite score threshold (0..1)
  const WEIGHTS = { pHash: 0.25, dHash: 0.25, ssim: 0.2, grad: 0.3 };

  // Slides-only detection: when true, we only notify if change looks like a slide transition
  // Heuristic: a significant fraction of pixels (on a 64x64 downscale) change by > PIXEL_DIFF_ABS
  // AND at least one of the hash distances is sizable. This filters out small cursor/motion noise.
  let SLIDES_ONLY = true;
  const SLIDE_PIXEL_DIFF_RES = 64;
  const SLIDE_PIXEL_DIFF_ABS = 12; // absolute gray difference to count a pixel as changed
  const SLIDE_PIXEL_DIFF_FRAC = 0.2; // fraction of pixels changed to consider "global" change
  const SLIDE_MIN_HASH = 0.18; // at least one hash distance should be above this to be considered slide-like

  // ========== Debug / logging ==========
  let DEBUG = true; // master on/off
  let DEBUG_LEVEL = 3; // 0:error,1:warn,2:info,3:debug
  const LOG_MAX_ENTRIES = 1000;
  const logs = [];

  function pushLog(level, ...args) {
    try {
      const ts = Date.now();
      const entry = {
        ts,
        level,
        message: args
          .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
          .join(" "),
      };
      logs.push(entry);
      if (logs.length > LOG_MAX_ENTRIES) logs.shift();
      if (!DEBUG) return;
      if (level === "error") console.error("[GMS]", ...args);
      else if (level === "warn") console.warn("[GMS]", ...args);
      else if (level === "info") console.info("[GMS]", ...args);
      else console.debug("[GMS]", ...args);
    } catch (e) {}
  }

  function logDebug(...a) {
    if (DEBUG && DEBUG_LEVEL >= 3) pushLog("debug", ...a);
  }
  function logInfo(...a) {
    if (DEBUG && DEBUG_LEVEL >= 2) pushLog("info", ...a);
  }
  function logWarn(...a) {
    if (DEBUG && DEBUG_LEVEL >= 1) pushLog("warn", ...a);
  }
  function logError(...a) {
    pushLog("error", ...a);
  }

  // Expose basic API
  window.GMS = window.GMS || {};
  window.GMS.getLogs = () => logs.slice();
  window.GMS.clearLogs = () => {
    logs.length = 0;
  };
  window.GMS.setDebug = (on, level = 3) => {
    DEBUG = !!on;
    DEBUG_LEVEL = level;
    pushLog("info", `debug set -> ${DEBUG}, level=${DEBUG_LEVEL}`);
    updatePanelStatus();
  };

  // ========== Monitoring state ==========
  let running = false;
  let monitorPromise = null;
  let useSSIM = true; // <- SSIM toggle

  let prevGray = null,
    prevP = null,
    prevD = null,
    prevG = null,
    prevW = 0,
    prevH = 0;

  // Canvas for sampling
  const canvas = document.createElement("canvas");
  canvas.style.display = "none";
  document.documentElement.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  // ========== Resource Monitor state ==========
  let perfStats = {
    fps: 0,
    frameTimeMs: 0,
    cpuPercent: 0,
    loopLagMs: 0,
    memUsedMB: null,
    memTotalMB: null,
  };
  let expectedInterval = 1000,
    lastTick = performance.now(),
    loopLagSamples = [],
    busyAccumMs = 0,
    busyIntervalStart = performance.now(),
    framesThisSecond = 0,
    frameTimeAccum = 0;
  let loopTimer = null;

  function startLoopMonitor() {
    lastTick = performance.now();
    loopLagSamples = [];
    busyAccumMs = 0;
    framesThisSecond = 0;
    frameTimeAccum = 0;
    if (loopTimer) clearInterval(loopTimer);
    let expected = performance.now() + 1000;
    loopTimer = setInterval(() => {
      const now = performance.now();
      const lag = now - expected;
      expected += 1000;
      loopLagSamples.push(lag);
      if (loopLagSamples.length > 60) loopLagSamples.shift();
      const sumLag = loopLagSamples.reduce((a, b) => a + b, 0);
      perfStats.loopLagMs = sumLag / loopLagSamples.length || 0;
      const intervalMs = now - busyIntervalStart || 1;
      const cpu = Math.min(1, busyAccumMs / intervalMs);
      perfStats.cpuPercent = Math.round(cpu * 100);
      perfStats.fps = framesThisSecond;
      perfStats.frameTimeMs = framesThisSecond
        ? Math.round((frameTimeAccum / framesThisSecond) * 100) / 100
        : 0;
      framesThisSecond = 0;
      frameTimeAccum = 0;
      busyAccumMs = 0;
      busyIntervalStart = performance.now();
      updatePerfUI();
      expected = performance.now() + 1000;
    }, 1000);
  }

  function stopLoopMonitor() {
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
    perfStats = {
      fps: 0,
      frameTimeMs: 0,
      cpuPercent: 0,
      loopLagMs: 0,
      memUsedMB: null,
      memTotalMB: null,
    };
    updatePerfUI();
  }

  function sampleMemory() {
    try {
      if (performance && performance.memory) {
        const used = performance.memory.usedJSHeapSize;
        const total =
          performance.memory.jsHeapSizeLimit ||
          performance.memory.totalJSHeapSize ||
          null;
        perfStats.memUsedMB = Math.round((used / 1024 / 1024) * 10) / 10;
        perfStats.memTotalMB = total
          ? Math.round((total / 1024 / 1024) * 10) / 10
          : null;
      } else {
        perfStats.memUsedMB = null;
        perfStats.memTotalMB = null;
      }
    } catch (e) {
      perfStats.memUsedMB = null;
      perfStats.memTotalMB = null;
    }
  }

  // ========== Video sampling ==========
  function findShareVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    let best = null,
      bestArea = 0;
    for (const v of videos) {
      if (v.readyState < 2) continue;
      const area =
        (v.videoWidth || v.clientWidth) * (v.videoHeight || v.clientHeight);
      if (area > bestArea) {
        best = v;
        bestArea = area;
      }
      try {
        const so = v.srcObject;
        if (so && so.getVideoTracks) {
          const t = so.getVideoTracks()[0];
          if (t && /screen/i.test(t.label || "")) return v;
        }
      } catch (e) {}
    }
    return best;
  }

  function getGrayscaleFromVideo(video) {
    const w = Math.max(
      32,
      Math.min(1280, video.videoWidth || video.clientWidth)
    );
    const h = Math.max(
      32,
      Math.min(720, video.videoHeight || video.clientHeight)
    );
    canvas.width = w;
    canvas.height = h;
    try {
      ctx.drawImage(video, 0, 0, w, h);
    } catch (e) {
      return null;
    }
    const imageData = ctx.getImageData(0, 0, w, h).data;
    const gray = utils.toGrayscale(imageData, w, h);
    return { gray, w, h };
  }

  function compositeScore(pDistNorm, dDistNorm, ssimVal, gDistNorm) {
    const ssimDiff = useSSIM ? 1 - ssimVal : 0;
    return (
      WEIGHTS.pHash * pDistNorm +
      WEIGHTS.dHash * dDistNorm +
      WEIGHTS.ssim * ssimDiff +
      WEIGHTS.grad * gDistNorm
    );
  }

  // Cheap downscaled pixel-change fraction (res x res)
  function computePixelChangeFraction(
    prevGray,
    prevW,
    prevH,
    gray,
    w,
    h,
    res = SLIDE_PIXEL_DIFF_RES
  ) {
    try {
      const a = utils.resizeGray(prevGray, prevW, prevH, res, res);
      const b = utils.resizeGray(gray, w, h, res, res);
      let changed = 0;
      for (let i = 0; i < a.length; i++) {
        if (Math.abs(a[i] - b[i]) > SLIDE_PIXEL_DIFF_ABS) changed++;
      }
      return changed / a.length;
    } catch (e) {
      return 0;
    }
  }

  async function monitorLoop() {
    startLoopMonitor();
    while (running) {
      const loopStart = performance.now();
      const video = findShareVideo();
      logDebug(
        "findShareVideo ->",
        video
          ? `found video (${video.videoWidth || video.clientWidth}x${
              video.videoHeight || video.clientHeight
            })`
          : "no video"
      );
      if (!video) {
        prevGray = prevP = prevD = prevG = null;
        await sleep(SAMPLE_INTERVAL_MS);
        continue;
      }

      const frameStart = performance.now();
      const frame = getGrayscaleFromVideo(video);
      if (!frame) {
        logWarn("Unable to capture frame from video element");
        await sleep(SAMPLE_INTERVAL_MS);
        continue;
      }
      const { gray, w, h } = frame;

      const busyStart = performance.now();
      const dBits = utils.dHashFromGray(gray, w, h);
      const pBits = utils.pHashFromGray(gray, w, h);
      const gBits = utils.gradientHash(gray, w, h);

      if (prevGray && prevP && prevD && prevG) {
        const pH = utils.hammingBits(prevP, pBits) / prevP.length;
        const dH = utils.hammingBits(prevD, dBits) / prevD.length;
        const gH = utils.hammingBits(prevG, gBits) / gBits.length;

        let ssimVal = 1;
        // compute downscaled frames once (used for SSIM and pixel-change heuristic)
        let downA = null,
          downB = null;
        try {
          downA = utils.resizeGray(prevGray, prevW, prevH, 64, 64);
          downB = utils.resizeGray(gray, w, h, 64, 64);
          if (useSSIM) ssimVal = utils.ssimGray(downA, downB);
        } catch (e) {
          logError("ssim/pixel compute error", e?.message || e);
          // keep defaults
        }

        const score = compositeScore(pH, dH, ssimVal, gH);
        const payload = {
          timestamp: Date.now(),
          compositeScore: score,
          pHashNorm: pH,
          dHashNorm: dH,
          gradNorm: gH,
          ssim: ssimVal,
          videoMeta: { w, h },
        };

        logInfo("metrics", {
          pHashNorm: pH.toFixed(4),
          dHashNorm: dH.toFixed(4),
          gradNorm: gH.toFixed(4),
          ssim: ssimVal.toFixed(4),
          score: score.toFixed(4),
        });
        // When SLIDES_ONLY is enabled we require the change to look like a slide transition:
        // - composite score above threshold (existing gating)
        // - and a significant fraction of pixels changed on a downscale AND at least one hash changed
        let send = false;
        if (score >= CHANGE_THRESHOLD) {
          if (!SLIDES_ONLY) {
            send = true;
          } else {
            // compute pixel-change fraction on a 64x64 downscale (falls back to computePixelChangeFraction)
            const pixelFrac =
              downA && downB
                ? computePixelChangeFraction(prevGray, prevW, prevH, gray, w, h)
                : 0;
            const hashFlag =
              pH >= SLIDE_MIN_HASH ||
              dH >= SLIDE_MIN_HASH ||
              gH >= SLIDE_MIN_HASH;
            const slideLike = pixelFrac >= SLIDE_PIXEL_DIFF_FRAC && hashFlag;
            if (slideLike) {
              send = true;
            } else {
              logDebug("change ignored (not slide-like)", {
                score: score.toFixed(3),
                pixelFrac: (pixelFrac || 0).toFixed(3),
                pH: pH.toFixed(3),
                dH: dH.toFixed(3),
                gH: gH.toFixed(3),
                slideLike,
              });
            }
          }
        }

        if (send) {
          logInfo("change detected", payload);
          try {
            chrome.runtime.sendMessage(
              { type: "GSM_CHANGE", payload },
              (resp) => logDebug("runtime.sendMessage response", resp)
            );
          } catch (e) {
            logError("sendMessage error", e?.message || e);
          }
        }
      }

      prevGray = gray;
      prevP = pBits;
      prevD = dBits;
      prevG = gBits;
      prevW = w;
      prevH = h;
      const busyEnd = performance.now();
      busyAccumMs += Math.max(0, busyEnd - busyStart);
      framesThisSecond++;
      frameTimeAccum += Math.max(0, performance.now() - frameStart);
      sampleMemory();
      await sleep(
        Math.max(0, SAMPLE_INTERVAL_MS - (performance.now() - loopStart))
      );
    }
    stopLoopMonitor();
  }

  function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }

  function startMonitoring() {
    if (running) return;
    running = true;
    logInfo("monitoring started");
    prevGray = prevP = prevD = prevG = null;
    monitorPromise = monitorLoop().catch((e) => console.error(e));
    updatePanelStatus();
  }
  function stopMonitoring() {
    if (!running) return;
    running = false;
    logInfo("monitoring stopped");
    monitorPromise = null;
    updatePanelStatus();
  }

  // ========== UI PANEL ==========
  const panelId = "gms-control-panel";
  function createControlPanel() {
    if (document.getElementById(panelId)) return;
    const panel = document.createElement("div");
    panel.id = panelId;
    panel.style.position = "fixed";
    panel.style.right = "12px";
    panel.style.bottom = "12px";
    panel.style.zIndex = 2147483647;
    panel.style.background = "rgba(0,0,0,0.78)";
    panel.style.color = "#fff";
    panel.style.padding = "10px";
    panel.style.borderRadius = "8px";
    panel.style.fontFamily = "Arial,sans-serif";
    panel.style.fontSize = "12px";
    panel.style.boxShadow = "0 2px 12px rgba(0,0,0,0.6)";
    panel.style.minWidth = "240px";
    panel.style.maxWidth = "420px";

    panel.innerHTML = `
      <div style="display:flex;gap:6px;align-items:center;">
        <button id="gms-start" style="padding:6px 8px;border-radius:4px;border:none;cursor:pointer;background:#2b8aef;color:#fff;">Start</button>
        <button id="gms-stop" style="padding:6px 8px;border-radius:4px;border:none;cursor:pointer;background:#666;color:#fff;">Stop</button>
        <label style="display:flex;align-items:center;gap:6px;margin-left:6px;color:#ddd;">
          <input id="gms-debug-toggle" type="checkbox" ${
            DEBUG ? "checked" : ""
          }/> Debug
        </label>
        <label style="display:flex;align-items:center;gap:6px;color:#ddd;">
          <input id="gms-ssim-toggle" type="checkbox" ${
            useSSIM ? "checked" : ""
          }/> SSIM
        </label>
        <label style="display:flex;align-items:center;gap:6px;color:#ddd;">
          <input id="gms-slides-toggle" type="checkbox" ${
            SLIDES_ONLY ? "checked" : ""
          }/> Slides only
        </label>
        <button id="gms-showlogs" title="Show logs" style="padding:6px 8px;border-radius:4px;border:none;cursor:pointer;background:#444;color:#fff;margin-left:auto;">Logs</button>
        <button id="gms-download" title="Download logs" style="padding:6px 8px;border-radius:4px;border:none;cursor:pointer;background:#444;color:#fff;margin-left:6px;">DL</button>
      </div>
      <div style="margin-top:8px;">
        <div id="gms-status" style="color:#fff;">Status: stopped</div>
        <div id="gms-perf" style="margin-top:8px;display:none;font-family:monospace;background:rgba(255,255,255,0.03);padding:6px;border-radius:6px;">
          <div style="font-weight:600;margin-bottom:4px;">Perf:</div>
          <div id="gms-perf-fps">FPS: -</div>
          <div id="gms-perf-cpu">CPU: -</div>
          <div id="gms-perf-frame">FrameTime: - ms</div>
          <div id="gms-perf-lag">LoopLag: - ms</div>
          <div id="gms-perf-mem" style="display:block;">Mem: -</div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    panel
      .querySelector("#gms-start")
      .addEventListener("click", startMonitoring);
    panel.querySelector("#gms-stop").addEventListener("click", stopMonitoring);

    panel.querySelector("#gms-debug-toggle").addEventListener("change", (e) => {
      DEBUG = !!e.target.checked;
      pushLog("info", `Debug toggled -> ${DEBUG}`);
      updatePanelStatus();
      updatePerfUI();
    });
    panel.querySelector("#gms-ssim-toggle").addEventListener("change", (e) => {
      useSSIM = !!e.target.checked;
      pushLog("info", `SSIM toggled -> ${useSSIM}`);
    });
    const slidesToggle = panel.querySelector("#gms-slides-toggle");
    if (slidesToggle) {
      slidesToggle.addEventListener("change", (e) => {
        SLIDES_ONLY = !!e.target.checked;
        pushLog("info", `Slides-only toggled -> ${SLIDES_ONLY}`);
      });
    }

    panel.querySelector("#gms-showlogs").addEventListener("click", () => {
      const overlayId = "gms-logs-overlay";
      let ov = document.getElementById(overlayId);
      if (ov) {
        ov.remove();
        return;
      }
      ov = document.createElement("div");
      ov.id = overlayId;
      ov.style.position = "fixed";
      ov.style.left = "8px";
      ov.style.right = "8px";
      ov.style.top = "8px";
      ov.style.bottom = "8px";
      ov.style.zIndex = 2147483648;
      ov.style.background = "rgba(0,0,0,0.95)";
      ov.style.color = "#0f0";
      ov.style.padding = "12px";
      ov.style.overflow = "auto";
      ov.style.fontFamily = "monospace";
      const pre = document.createElement("pre");
      pre.style.whiteSpace = "pre-wrap";
      pre.textContent = logs
        .map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.message}`)
        .join("\n");
      const closeBtn = document.createElement("button");
      closeBtn.textContent = "Close";
      closeBtn.style.marginBottom = "8px";
      closeBtn.addEventListener("click", () => ov.remove());
      ov.appendChild(closeBtn);
      ov.appendChild(pre);
      document.body.appendChild(ov);
    });

    panel.querySelector("#gms-download").addEventListener("click", () => {
      const data = logs.map((l) => ({
        ts: l.ts,
        level: l.level,
        message: l.message,
      }));
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gms-logs-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  function updatePanelStatus() {
    const s = document.getElementById("gms-status");
    if (!s) return;
    s.textContent = running
      ? `Status: running (debug=${DEBUG}, SSIM=${useSSIM})`
      : `Status: stopped (debug=${DEBUG}, SSIM=${useSSIM})`;
    const perf = document.getElementById("gms-perf");
    if (perf) perf.style.display = DEBUG ? "block" : "none";
  }

  function updatePerfUI() {
    const perf = document.getElementById("gms-perf");
    if (!perf) return;
    perf.style.display = DEBUG ? "block" : "none";
    const fpsEl = document.getElementById("gms-perf-fps");
    const cpuEl = document.getElementById("gms-perf-cpu");
    const frameEl = document.getElementById("gms-perf-frame");
    const lagEl = document.getElementById("gms-perf-lag");
    const memEl = document.getElementById("gms-perf-mem");
    if (fpsEl) fpsEl.textContent = `FPS: ${perfStats.fps}`;
    if (cpuEl) cpuEl.textContent = `CPU: ${perfStats.cpuPercent}%`;
    if (frameEl) frameEl.textContent = `FrameTime: ${perfStats.frameTimeMs} ms`;
    if (lagEl)
      lagEl.textContent = `LoopLag: ${
        Math.round(perfStats.loopLagMs * 10) / 10
      } ms`;
    if (memEl) {
      if (perfStats.memUsedMB != null) {
        memEl.style.display = "block";
        if (perfStats.memTotalMB)
          memEl.textContent = `Mem: ${perfStats.memUsedMB} MB / ${perfStats.memTotalMB} MB`;
        else memEl.textContent = `Mem: ${perfStats.memUsedMB} MB`;
      } else memEl.style.display = "none";
    }
  }

  setTimeout(() => {
    try {
      createControlPanel();
      updatePanelStatus();
      updatePerfUI();
    } catch (e) {}
  }, 1500);

  if (chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (msg === "GSM_STOP") {
        stopMonitoring();
        reply && reply({ ok: true });
      }
      if (msg === "GSM_START") {
        startMonitoring();
        reply && reply({ ok: true });
      }
    });
  }

  window.addEventListener("beforeunload", () => {
    running = false;
    if (loopTimer) clearInterval(loopTimer);
  });
  setInterval(() => {
    sampleMemory();
    updatePerfUI();
  }, 1000);
})();
