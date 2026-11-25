const elements = {
  packageTabs: document.getElementById("package-tabs"),
  packagePanels: document.getElementById("package-panels"),
  packageContent: document.getElementById("package-content"),
  packageTitle: document.getElementById("package-title"),
  playPackage: document.getElementById("play-package"),
  trackList: document.getElementById("track-list"),
  trackStatus: document.getElementById("track-status"),
  audio: document.getElementById("audio-player"),
  speed: document.getElementById("speed"),
  speedValue: document.getElementById("speed-value"),
  autoScroll: document.getElementById("auto-scroll"),
  lineStatus: document.getElementById("line-status"),
  wordStatus: document.getElementById("word-status"),
  sourceList: document.getElementById("source-list"),
  trackTitle: document.getElementById("track-title"),
  verses: document.getElementById("verses"),
  installApp: document.getElementById("install-app"),
  // custom player
  playPause: document.getElementById("play-pause"),
  skipBack: document.getElementById("skip-back"),
  skipForward: document.getElementById("skip-forward"),
  audioProgress: document.getElementById("audio-progress"),
  progressFill: document.getElementById("audio-progress-fill"),
  audioTime: document.getElementById("audio-time"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsSheet: document.getElementById("settings-sheet"),
};

const state = {
  packages: [],
  activePackage: null,
  playingPackage: false,
  track: null,
  trackRequest: 0,
  timedLines: [],
  lineCards: [],    // one entry per timedLine index
  wordNodes: [],    // one array per timedLine index
  verseGroups: [],  // [{verse, lineIndices, card}] – Quran mode only
  activeLineIndex: -1,
  activeWordIndex: -1,
  syncOffset: 0,
  installPromptEvent: null,
};

const IS_DEBUG = new URLSearchParams(location.search).get("debug") === "91324";

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const STORAGE_PREFIX = "farh2:tafsir:";
const PLAYBACK_RATE_KEY = "nasr:playback-rate";

function toPersianNumber(input) {
  return String(input).replace(/\d/g, (d) => PERSIAN_DIGITS[d]);
}

function toArabicNumber(input) {
  return String(input).replace(/\d/g, (d) => ARABIC_INDIC_DIGITS[d]);
}

function formatRate(rate) {
  return `${toPersianNumber(rate.toFixed(2))}×`;
}

function formatSeconds(value) {
  const signed = value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
  return `${toPersianNumber(signed)} ثانیه`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "۰:۰۰";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${toPersianNumber(m)}:${toPersianNumber(String(s).padStart(2, "0"))}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lineWeight(line) {
  return Math.max(10, line.arabic.length * 1.2 + line.translation.length * 0.65);
}

function buildTimedLines(lines, durationHint, opts = {}) {
  const safeDuration = Number.isFinite(durationHint) && durationHint > 0 ? durationHint : 1;
  const autoStartPad = Math.min(1.6, Math.max(0.55, safeDuration * 0.013));
  const autoEndPad = Math.min(1.1, Math.max(0.4, safeDuration * 0.01));
  const startPad = Number.isFinite(opts.leadIn) ? clamp(opts.leadIn, 0, safeDuration * 0.4) : autoStartPad;
  const endPad = Number.isFinite(opts.leadOut) ? clamp(opts.leadOut, 0.2, safeDuration * 0.2) : autoEndPad;
  const usable = Math.max(safeDuration - startPad - endPad, safeDuration * 0.9);
  const fixedDurations = lines.map((line) => {
    return Number.isFinite(line.fixedDuration) && line.fixedDuration > 0 ? line.fixedDuration : 0;
  });
  const requestedFixed = fixedDurations.reduce((sum, value) => sum + value, 0);
  const fixedScale = requestedFixed > usable ? usable / requestedFixed : 1;
  const scaledFixedDurations = fixedDurations.map((value) => value * fixedScale);
  const dynamicIndices = lines
    .map((_, index) => index)
    .filter((index) => scaledFixedDurations[index] <= 0);
  const dynamicUsable = Math.max(
    0.001,
    usable - scaledFixedDurations.reduce((sum, value) => sum + value, 0)
  );
  const dynamicWeights = dynamicIndices.map((index) => lineWeight(lines[index]));
  const totalDynamicWeight = dynamicWeights.reduce((sum, weight) => sum + weight, 0) || 1;
  const dynamicShareByIndex = new Map();
  dynamicIndices.forEach((index, idx) => {
    dynamicShareByIndex.set(index, dynamicWeights[idx] / totalDynamicWeight);
  });

  let cursor = startPad;
  return lines.map((line, index) => {
    const fixedSegment = scaledFixedDurations[index];
    const dynamicSegment = dynamicShareByIndex.has(index)
      ? dynamicUsable * dynamicShareByIndex.get(index)
      : 0;
    const segment = fixedSegment > 0 ? fixedSegment : dynamicSegment;
    const start = cursor;
    const isLast = index === lines.length - 1;
    const end = isLast ? safeDuration - endPad : cursor + segment;
    cursor = end;
    return { ...line, start, end };
  });
}

function splitWords(text) {
  return text
    .replace(/\u200c/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function wordWeight(word) {
  const stripped = word.replace(/[^\p{L}\p{N}]/gu, "");
  return Math.max(1, stripped.length || word.length);
}

function buildSegmentTimeline(words, start, end, script) {
  if (!words.length || end <= start) return [];
  const totalDuration = Math.max(0.01, end - start);
  const weights = words.map(wordWeight);
  const sum = weights.reduce((acc, item) => acc + item, 0);
  let cursor = start;
  return words.map((word, index) => {
    const segment = totalDuration * (weights[index] / sum);
    const segmentStart = cursor;
    const isLast = index === words.length - 1;
    const segmentEnd = isLast ? end : cursor + segment;
    cursor = segmentEnd;
    return { text: word, start: segmentStart, end: segmentEnd, script };
  });
}

function buildWordTimeline(line, track) {
  const arWords = splitWords(line.arabic);
  const faWords = splitWords(line.translation);

  if (track?.spokenPattern === "ar-fa" && arWords.length && faWords.length) {
    const totalLineDuration = Math.max(0.01, line.end - line.start);
    const arWeight = arWords.reduce((sum, word) => sum + wordWeight(word), 0);
    const faWeightBase = faWords.reduce((sum, word) => sum + wordWeight(word), 0);
    const translationWeight =
      Number.isFinite(track.translationWeight) && track.translationWeight > 0
        ? track.translationWeight
        : 1;
    const faWeight = faWeightBase * translationWeight;
    const combined = Math.max(1, arWeight + faWeight);
    const arDuration = totalLineDuration * (arWeight / combined);
    const split = clamp(line.start + arDuration, line.start + 0.05, line.end - 0.05);
    const arTimeline = buildSegmentTimeline(arWords, line.start, split, "arabic");
    const faTimeline = buildSegmentTimeline(faWords, split, line.end, "translation");
    return [...arTimeline, ...faTimeline];
  }

  return buildSegmentTimeline(arWords, line.start, line.end, "arabic");
}

function withWordIndices(words) {
  return words.map((word, index) => ({ ...word, index }));
}

function sanitizeWordTimeline(words, fallbackScript = "arabic") {
  if (!Array.isArray(words)) return [];
  return words
    .filter(
      (word) =>
        word &&
        typeof word.text === "string" &&
        Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.end > word.start
    )
    .map((word) => ({
      text: word.text.trim(),
      start: Number(word.start),
      end: Number(word.end),
      script: word.script || fallbackScript,
      source: word.source || "whisper",
    }))
    .filter((word) => word.text.length > 0);
}

function buildTrackTimeline(track) {
  return (track.segments || []).map((segment, index) => {
    const wordTimestamps = segment.words || [];
    const text = segment.text || "";
    // Tanzil writes some pause marks as separate tokens, but they have no audio of their own.
    const textWords = Number.isInteger(segment.ayah)
      ? text.match(/\S+(?: +[\u06d6-\u06dc](?= |$))*/g) || []
      : splitWords(text);

    const segStart = segment.start ?? wordTimestamps[0]?.start ?? 0;
    const segEnd = segment.end ?? wordTimestamps[wordTimestamps.length - 1]?.end ?? segStart + 1;

    let words;
    if (textWords.length > 0 && wordTimestamps.length > 0) {
      if (textWords.length === wordTimestamps.length) {
        words = textWords.map((text, i) => ({
          text,
          start: wordTimestamps[i].start,
          end: wordTimestamps[i].end,
          script: "arabic",
          index: i,
        }));
      } else {
        words = withWordIndices(buildSegmentTimeline(textWords, segStart, segEnd, "arabic"));
      }
    } else {
      words = [];
    }

    return {
      id: index,
      arabic: text,
      translation: segment.translation || "",
      tafsir: segment.tafsir || "",
      lang: segment.language || segment.lang || "ar",
      verse: segment.ayah ?? index,
      start: segStart,
      end: segEnd,
      words,
    };
  });
}

function tafsirStorageKey(trackId, lineId) {
  return `${STORAGE_PREFIX}${trackId}:${lineId}`;
}

function getSavedTafsir(trackId, lineId) {
  return localStorage.getItem(tafsirStorageKey(trackId, lineId)) || "";
}

function saveTafsir(trackId, lineId, text) {
  localStorage.setItem(tafsirStorageKey(trackId, lineId), text);
}

function applyPlaybackRate() {
  const rate = Number(elements.speed.value);
  elements.audio.defaultPlaybackRate = rate;
  elements.audio.playbackRate = rate;
  elements.speedValue.textContent = formatRate(rate);
}

function restorePlaybackRate() {
  try {
    const savedRate = Number(localStorage.getItem(PLAYBACK_RATE_KEY));
    if (savedRate >= Number(elements.speed.min) && savedRate <= Number(elements.speed.max)) {
      elements.speed.value = String(savedRate);
    }
  } catch (_) {}
  applyPlaybackRate();
}

function renderTrackButtons() {
  elements.trackList.replaceChildren();
  for (const track of state.activePackage.tracks) {
    const button = document.createElement("button");
    button.className = "track-btn";
    button.type = "button";
    button.dataset.trackId = track.id;
    const icon = document.createElement("span");
    icon.className = "track-symbol";
    icon.setAttribute("aria-hidden", "true");
    const title = document.createElement("strong");
    title.textContent = track.title;
    const subtitle = document.createElement("small");
    subtitle.textContent = track.subtitle;
    button.append(icon, title, subtitle);
    button.addEventListener("click", () => {
      state.playingPackage = false;
      selectTrack(track);
    });
    elements.trackList.appendChild(button);
  }
  updateSelectedTrack();
}

function updateSelectedTrack() {
  for (const button of elements.trackList.children) {
    const active = button.dataset.trackId === state.track?.id;
    button.setAttribute("aria-pressed", String(active));
  }
}

function renderSources() {
  elements.sourceList.innerHTML = "";
  const details = elements.sourceList.closest("details");
  if (!state.track?.sources?.length) {
    if (details) details.hidden = true;
    return;
  }
  if (details) details.hidden = false;
  for (const source of state.track.sources) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.title;
    li.appendChild(link);
    elements.sourceList.appendChild(li);
  }
}

function seekToTime(targetTime, autoplay = true) {
  const safe = clamp(targetTime - state.syncOffset, 0, Math.max(elements.audio.duration || targetTime + 1, 0));
  elements.audio.currentTime = safe;
  if (autoplay && elements.audio.paused) {
    elements.audio.play().catch(() => {});
  }
  syncWordState();
}

function seekToLine(lineIndex) {
  const line = state.timedLines[lineIndex];
  if (!line) return;
  seekToTime(line.start);
}

function seekToWord(lineIndex, wordIndex) {
  const line = state.timedLines[lineIndex];
  const word = line?.words[wordIndex];
  if (!word) return;
  seekToTime(word.start);
}

function createWordNode({ text, lineIndex, wordIndex }) {
  const span = document.createElement("span");
  span.className = "word";
  if (IS_DEBUG) {
    const badge = document.createElement("sup");
    badge.className = "debug-word-index";
    badge.textContent = wordIndex;
    span.appendChild(badge);
    span.appendChild(document.createTextNode(text));
  } else {
    span.textContent = text;
  }
  span.setAttribute("role", "button");
  span.tabIndex = 0;
  span.addEventListener("click", (event) => {
    event.stopPropagation();
    seekToWord(lineIndex, wordIndex);
    span.blur();
  });
  span.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      seekToWord(lineIndex, wordIndex);
    }
  });
  return span;
}

// ── Quran mode rendering ────────────────────────────────────────────────────

function renderQuranLines() {
  // Group timedLines by verse number, preserving order
  const verseOrder = [];
  const verseMap = new Map();

  for (let i = 0; i < state.timedLines.length; i++) {
    const line = state.timedLines[i];
    const v = line.verse;
    if (!verseMap.has(v)) {
      verseMap.set(v, { lineIndices: [], translation: "" });
      verseOrder.push(v);
    }
    const group = verseMap.get(v);
    group.lineIndices.push(i);
    if (!group.translation && line.translation) {
      group.translation = line.translation;
    }
  }

  for (const verse of verseOrder) {
    const group = verseMap.get(verse);

    const card = document.createElement("article");
    card.className = "verse-group";

    const arabic = document.createElement("p");
    arabic.className = "arabic";

    // Render words for all lines in this verse group
    for (const lineIndex of group.lineIndices) {
      const line = state.timedLines[lineIndex];
      const lineWordNodes = [];

      if (line.words.length > 0) {
        for (let wi = 0; wi < line.words.length; wi++) {
          const word = line.words[wi];
          const span = createWordNode({ text: word.text, lineIndex, wordIndex: wi });
          span.classList.add("word-ar");
          lineWordNodes[wi] = span;
          arabic.appendChild(span);
          arabic.appendChild(document.createTextNode(" "));
        }
      } else {
        arabic.appendChild(document.createTextNode(line.arabic + " "));
      }

      state.wordNodes[lineIndex] = lineWordNodes;
    }

    // Verse number badge at end (skip verse 0 = bismillah)
    if (verse > 0) {
      const badge = document.createElement("span");
      badge.className = "verse-number-badge";
      badge.textContent = `\uFD3F${toArabicNumber(verse)}\uFD3E`;
      arabic.appendChild(badge);
    }

    card.appendChild(arabic);

    if (group.translation) {
      const transP = document.createElement("p");
      transP.className = "translation";
      transP.textContent = group.translation;
      card.appendChild(transP);
    }

    // Click on card seeks to first line in group
    card.addEventListener("click", () => seekToLine(group.lineIndices[0]));

    state.verseGroups.push({ verse, lineIndices: group.lineIndices, card });
    elements.verses.appendChild(card);

    // lineCards for all lines in this verse group point to the same card
    for (const li of group.lineIndices) {
      state.lineCards[li] = card;
    }
  }
}

// ── Dua mode rendering ──────────────────────────────────────────────────────

function renderDuaLines() {
  for (const [lineIndex, line] of state.timedLines.entries()) {
    const isPersian = line.lang === "fa";

    const card = document.createElement("article");
    card.className = isPersian ? "dua-segment dua-persian-segment" : "dua-segment";

    if (isPersian) {
      const p = document.createElement("p");
      p.className = "dua-persian";
      p.textContent = line.arabic;
      card.appendChild(p);
      state.wordNodes[lineIndex] = []; // no word highlight for Persian
    } else {
      const arabic = document.createElement("p");
      arabic.className = "arabic";
      const lineWordNodes = [];

      if (line.words.length > 0) {
        for (let wi = 0; wi < line.words.length; wi++) {
          const word = line.words[wi];
          const span = createWordNode({ text: word.text, lineIndex, wordIndex: wi });
          span.classList.add("word-ar");
          lineWordNodes[wi] = span;
          arabic.appendChild(span);
          arabic.appendChild(document.createTextNode(" "));
        }
      } else {
        arabic.textContent = line.arabic;
      }

      card.appendChild(arabic);
      state.wordNodes[lineIndex] = lineWordNodes;
    }

    if (line.translation) {
      const transP = document.createElement("p");
      transP.className = "translation";
      transP.textContent = line.translation;
      card.appendChild(transP);
    }

    card.addEventListener("click", () => seekToLine(lineIndex));
    state.lineCards[lineIndex] = card;
    elements.verses.appendChild(card);
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

function renderLines() {
  state.lineCards = [];
  state.wordNodes = [];
  state.verseGroups = [];
  elements.verses.innerHTML = "";

  if (state.track?.isQuran) {
    renderQuranLines();
  } else {
    renderDuaLines();
  }
}

// ── Active index helpers ────────────────────────────────────────────────────

function findActiveLineIndex(syncedTime) {
  if (!state.timedLines.length) return 0;
  if (syncedTime < (state.timedLines[0]?.start ?? 0)) return 0;
  for (let i = 0; i < state.timedLines.length - 1; i++) {
    if (syncedTime >= state.timedLines[i].start && syncedTime < state.timedLines[i + 1].start) {
      return i;
    }
  }
  return Math.max(0, state.timedLines.length - 1);
}

function findActiveWordIndex(words, syncedTime) {
  if (!words.length) return -1;
  if (syncedTime < words[0].start) return 0;
  for (let i = 0; i < words.length - 1; i++) {
    if (syncedTime >= words[i].start && syncedTime < words[i + 1].start) return i;
  }
  return words.length - 1;
}

function clearWordClasses(wordList) {
  for (const node of wordList) {
    if (node) node.classList.remove("done", "active");
  }
}

// ── Main sync ───────────────────────────────────────────────────────────────

function syncWordState() {
  if (!state.timedLines.length || !state.lineCards.length) return;

  const now = elements.audio.currentTime || 0;
  const syncedTime = now + state.syncOffset;

  const lineIndex = findActiveLineIndex(syncedTime);
  const activeLine = state.timedLines[lineIndex];
  const wordIndex = findActiveWordIndex(activeLine.words, syncedTime);

  const isQuran = !!state.track?.isQuran;
  const lineChanged = lineIndex !== state.activeLineIndex;
  const wordChanged = wordIndex !== state.activeWordIndex;
  const shouldScroll = elements.autoScroll.checked && (!elements.audio.paused || elements.audio.seeking);

  // Update word highlights for all lines
  for (let i = 0; i < state.timedLines.length; i++) {
    const words = state.wordNodes[i] || [];
    clearWordClasses(words);
    if (i < lineIndex) {
      for (const node of words) if (node) node.classList.add("done");
    } else if (i === lineIndex) {
      for (let w = 0; w < words.length; w++) {
        const node = words[w];
        if (!node) continue;
        if (w < wordIndex) node.classList.add("done");
        else if (w === wordIndex) node.classList.add("active");
      }
    }
  }

  if (isQuran) {
    // Update verse-group classes
    for (const group of state.verseGroups) {
      const lastLine = group.lineIndices[group.lineIndices.length - 1];
      const isActive = group.lineIndices.includes(lineIndex);
      const isPassed = lastLine < lineIndex;
      group.card.classList.toggle("verse-active", isActive);
      group.card.classList.toggle("verse-passed", isPassed);
    }
    // Auto-scroll to verse group when verse changes
    if (lineChanged && shouldScroll) {
      const activeGroup = state.verseGroups.find((g) => g.lineIndices.includes(lineIndex));
      activeGroup?.card.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  } else {
    // Update dua-segment cards
    for (let i = 0; i < state.lineCards.length; i++) {
      const card = state.lineCards[i];
      if (!card) continue;
      card.classList.toggle("active", i === lineIndex);
      card.classList.toggle("done", i < lineIndex);
    }
    // Auto-scroll
    if ((lineChanged || wordChanged) && shouldScroll) {
      const lang = activeLine.lang || "ar";
      const targetWord = lang !== "fa" ? state.wordNodes[lineIndex]?.[wordIndex] : null;
      if (targetWord) {
        targetWord.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      } else {
        state.lineCards[lineIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }

  state.activeLineIndex = lineIndex;
  state.activeWordIndex = wordIndex;

  // Status pills
  elements.lineStatus.textContent = `${toPersianNumber(lineIndex + 1)} / ${toPersianNumber(state.timedLines.length)} خط`;
  const totalWords = activeLine.words.length;
  if (totalWords > 0 && wordIndex >= 0) {
    elements.wordStatus.textContent = `${toPersianNumber(wordIndex + 1)} / ${toPersianNumber(totalWords)} کلمه`;
  } else {
    elements.wordStatus.textContent = "کلمه -";
  }

  updatePlayerProgress();
  updateMediaSessionPosition();
}

// ── Custom audio player ─────────────────────────────────────────────────────

function updatePlayerProgress() {
  const duration = elements.audio.duration || 0;
  const currentTime = elements.audio.currentTime || 0;
  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;
  elements.progressFill.style.width = `${pct}%`;
  elements.audioProgress.setAttribute("aria-valuenow", Math.round(pct));
  elements.audioTime.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
}

function seekViaProgress(clientX) {
  const rect = elements.audioProgress.getBoundingClientRect();
  const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
  const duration = elements.audio.duration || 0;
  elements.audio.currentTime = ratio * duration;
  syncWordState();
}

function setupPlayerControls() {
  elements.playPause.addEventListener("click", () => {
    if (elements.audio.paused) {
      elements.audio.play().catch(() => {});
    } else {
      elements.audio.pause();
    }
  });

  const SVG_PLAY = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5,3 19,12 5,21"/></svg>`;
  const SVG_PAUSE = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;

  elements.audio.addEventListener("play", () => {
    elements.playPause.innerHTML = SVG_PAUSE;
    elements.playPause.dataset.state = "playing";
    elements.playPause.setAttribute("aria-label", "توقف");
  });

  elements.audio.addEventListener("pause", () => {
    elements.playPause.innerHTML = SVG_PLAY;
    elements.playPause.dataset.state = "paused";
    elements.playPause.setAttribute("aria-label", "پخش");
  });

  elements.skipBack.addEventListener("click", () => {
    const syncedTime = (elements.audio.currentTime || 0) + state.syncOffset;
    const lineIndex = findActiveLineIndex(syncedTime);
    const lineStart = state.timedLines[lineIndex]?.start ?? 0;
    const target = (syncedTime - lineStart > 2) ? lineIndex : Math.max(0, lineIndex - 1);
    seekToLine(target);
  });

  elements.skipForward.addEventListener("click", () => {
    const syncedTime = (elements.audio.currentTime || 0) + state.syncOffset;
    const lineIndex = findActiveLineIndex(syncedTime);
    seekToLine(Math.min(state.timedLines.length - 1, lineIndex + 1));
  });

  // Progress bar – click
  elements.audioProgress.addEventListener("click", (e) => seekViaProgress(e.clientX));

  // Progress bar – drag
  let dragging = false;
  elements.audioProgress.addEventListener("mousedown", () => { dragging = true; });
  document.addEventListener("mousemove", (e) => { if (dragging) seekViaProgress(e.clientX); });
  document.addEventListener("mouseup", () => { dragging = false; });

  // Progress bar – touch
  elements.audioProgress.addEventListener("touchstart", (e) => { e.preventDefault(); }, { passive: false });
  elements.audioProgress.addEventListener("touchmove", (e) => {
    e.preventDefault();
    seekViaProgress(e.touches[0].clientX);
  }, { passive: false });

  // timeupdate → progress bar
  elements.audio.addEventListener("timeupdate", updatePlayerProgress);
  elements.audio.addEventListener("loadedmetadata", updatePlayerProgress);
  elements.audio.addEventListener("durationchange", updatePlayerProgress);
}

// ── Media Session API ───────────────────────────────────────────────────────

function setupMediaSession(track) {
  if (!("mediaSession" in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.reciter || track.subtitle || "آیات فتح دعای نصر",
    artwork: [{ src: "icons/icon.png", sizes: "any", type: "image/png" }],
  });

  navigator.mediaSession.setActionHandler("play", () => elements.audio.play().catch(() => {}));
  navigator.mediaSession.setActionHandler("pause", () => elements.audio.pause());
  navigator.mediaSession.setActionHandler("seekbackward", (d) => {
    elements.audio.currentTime = Math.max(0, elements.audio.currentTime - (d.seekOffset || 10));
    syncWordState();
  });
  navigator.mediaSession.setActionHandler("seekforward", (d) => {
    elements.audio.currentTime = Math.min(
      elements.audio.duration || 0,
      elements.audio.currentTime + (d.seekOffset || 10)
    );
    syncWordState();
  });
}

function updateMediaSessionPosition() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const duration = elements.audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: elements.audio.playbackRate,
      position: elements.audio.currentTime,
    });
  } catch (_) {}
}

// ── Collection and track management ────────────────────────────────────────

function renderPackageTabs() {
  for (const collection of state.packages) {
    const tab = document.createElement("button");
    tab.id = `tab-${collection.id}`;
    tab.className = "package-tab";
    tab.type = "button";
    tab.textContent = collection.tabLabel || collection.title;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `panel-${collection.id}`);
    tab.addEventListener("click", () => selectPackage(collection));

    const panel = document.createElement("div");
    panel.id = `panel-${collection.id}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.tabIndex = 0;
    panel.hidden = true;

    collection.tab = tab;
    collection.panel = panel;
    elements.packageTabs.appendChild(tab);
    elements.packagePanels.appendChild(panel);
  }
}

function selectPackage(collection) {
  if (collection === state.activePackage) return;
  state.activePackage = collection;
  state.playingPackage = false;

  for (const item of state.packages) {
    const active = item === collection;
    item.tab.setAttribute("aria-selected", String(active));
    item.tab.tabIndex = active ? 0 : -1;
    item.panel.hidden = !active;
  }
  collection.panel.appendChild(elements.packageContent);
  elements.packageTitle.textContent = collection.title;
  elements.playPackage.hidden = !collection.playAll;

  elements.audio.pause();
  if (state.track) {
    elements.audio.removeAttribute("src");
    elements.audio.load();
  }
  state.track = null;
  state.timedLines = [];
  elements.trackTitle.textContent = "";
  elements.playPause.disabled = true;
  renderSources();
  renderLines();
  renderTrackButtons();
  selectTrack(collection.selectedTrack || collection.tracks[0], { autoplay: false });
}

function showTrackStatus(message = "") {
  elements.trackStatus.textContent = message;
  elements.trackStatus.hidden = !message;
}

async function selectTrack(next, { autoplay, reveal = false } = {}) {
  const request = ++state.trackRequest;
  if (!next.segments || IS_DEBUG) {
    showTrackStatus("در حال بارگیری متن…");
    try {
      const response = await fetch(next.data, { cache: "no-store" });
      if (!response.ok) throw new Error(`Failed to load ${next.data} (${response.status})`);
      const segments = await response.json();
      if (request !== state.trackRequest) return;
      if (!Array.isArray(segments) || !segments.length) throw new Error("Track has no text segments");
      next.segments = segments;
    } catch (error) {
      if (request !== state.trackRequest) return;
      state.playingPackage = false;
      console.error(error);
      showTrackStatus("متن بارگیری نشد. برای تلاش دوباره، اثر را انتخاب کنید.");
      return;
    }
  }

  const shouldPlay = autoplay ?? !elements.audio.paused;
  state.activePackage.selectedTrack = next;
  state.track = next;
  state.activeLineIndex = -1;
  state.activeWordIndex = -1;
  state.timedLines = buildTrackTimeline(next);

  elements.trackTitle.textContent = next.title;
  elements.playPause.disabled = false;
  elements.audio.src = next.audio;
  elements.audio.load();
  elements.audio.playbackRate = elements.audio.defaultPlaybackRate;

  showTrackStatus();
  updateSelectedTrack();
  renderSources();
  renderLines();
  syncWordState();
  setupMediaSession(next);
  if (reveal) {
    requestAnimationFrame(() => {
      if (request === state.trackRequest) window.scrollTo({ top: 0, behavior: "instant" });
    });
  }

  if (shouldPlay) {
    elements.audio.play().catch((error) => {
      if (request !== state.trackRequest || error.name === "AbortError") return;
      showTrackStatus("برای شروع تلاوت، دکمهٔ پخش را بزنید.");
    });
  }
}

// ── Events ──────────────────────────────────────────────────────────────────

function bindEvents() {
  elements.audio.addEventListener("timeupdate", syncWordState);
  elements.audio.addEventListener("seeking", syncWordState);
  elements.audio.addEventListener("play", () => {
    showTrackStatus();
    syncWordState();
  });
  elements.audio.addEventListener("ended", () => {
    if (!elements.audio.ended || !state.activePackage?.playAll || !state.track) return;
    const tracks = state.activePackage.tracks;
    const next = tracks[tracks.indexOf(state.track) + 1];
    if (next) selectTrack(next, { autoplay: state.playingPackage, reveal: true });
    else state.playingPackage = false;
  });
  elements.audio.addEventListener("error", () => {
    if (!state.track) return;
    state.playingPackage = false;
    showTrackStatus("پخش صوت ممکن نشد. دوباره اثر را انتخاب کنید.");
  });

  elements.playPackage.addEventListener("click", () => {
    state.playingPackage = true;
    selectTrack(state.activePackage.tracks[0], { autoplay: true });
  });

  elements.packageTabs.addEventListener("keydown", (event) => {
    const index = state.packages.findIndex((collection) => collection.tab === event.target);
    if (index < 0) return;
    const count = state.packages.length;
    let target;
    switch (event.key) {
      case "ArrowLeft": target = (index + 1) % count; break;
      case "ArrowRight": target = (index + count - 1) % count; break;
      case "Home": target = 0; break;
      case "End": target = count - 1; break;
      default: return;
    }
    event.preventDefault();
    const next = state.packages[target];
    selectPackage(next);
    next.tab.focus();
  });

  elements.speed.addEventListener("input", () => {
    applyPlaybackRate();
    updateMediaSessionPosition();
    try {
      localStorage.setItem(PLAYBACK_RATE_KEY, elements.speed.value);
    } catch (_) {}
  });

  elements.installApp.addEventListener("click", async () => {
    if (!state.installPromptEvent) return;
    state.installPromptEvent.prompt();
    await state.installPromptEvent.userChoice;
    state.installPromptEvent = null;
    elements.installApp.hidden = true;
  });

  const toggleSettings = (e) => {
    e.stopPropagation();
    const isOpen = elements.settingsSheet.classList.toggle("open");
    elements.settingsBtn.setAttribute("aria-expanded", isOpen);
  };
  elements.settingsBtn.addEventListener("click", toggleSettings);
  elements.settingsBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSettings(e); }
  });

  document.addEventListener("click", (e) => {
    if (
      elements.settingsSheet.classList.contains("open") &&
      !elements.settingsSheet.contains(e.target) &&
      e.target !== elements.settingsBtn
    ) {
      elements.settingsSheet.classList.remove("open");
      elements.settingsBtn.setAttribute("aria-expanded", "false");
    }
  });

  // Keyboard shortcuts (always active)
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.target.closest("input, textarea, select, button, [role='button'], a")) return;
    switch (e.key) {
      case "]":
        e.preventDefault();
        elements.audio.pause();
        elements.audio.currentTime = Math.max(0, elements.audio.currentTime - 0.01);
        syncWordState();
        break;
      case "[":
        e.preventDefault();
        elements.audio.pause();
        elements.audio.currentTime = Math.min(elements.audio.duration || 0, elements.audio.currentTime + 0.01);
        syncWordState();
        break;
      case "}": // Shift+]
        e.preventDefault();
        elements.audio.pause();
        elements.audio.currentTime = Math.max(0, elements.audio.currentTime - 0.1);
        syncWordState();
        break;
      case "{": // Shift+[
        e.preventDefault();
        elements.audio.pause();
        elements.audio.currentTime = Math.min(elements.audio.duration || 0, elements.audio.currentTime + 0.1);
        syncWordState();
        break;
      case " ":
        e.preventDefault();
        if (elements.audio.paused) elements.audio.play().catch(() => {});
        else elements.audio.pause();
        break;
      case "p":
        e.preventDefault();
        if (elements.audio.paused) elements.audio.play().catch(() => {});
        else elements.audio.pause();
        break;
    }
  });
}

function registerPWA() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPromptEvent = event;
    elements.installApp.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    state.installPromptEvent = null;
    elements.installApp.hidden = true;
  });
}

async function loadData() {
  try {
    const response = await fetch("data/list.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load data/list.json (${response.status})`);
    const payload = await response.json();
    const tracks = new Map((payload.list || []).map((track) => [track.id, track]));
    const packages = payload.packages ?? [{
      id: "main",
      title: "توصیه قائد شهید جهت پیروزی جبهه مقاومت",
      tabLabel: "توصیه قائد شهید",
      tracks: [...tracks.keys()],
    }];
    state.packages = packages.map((item) => ({
      ...item,
      tracks: item.tracks.map((id) => tracks.get(id)).filter(Boolean),
    })).filter((item) => item.tracks.length > 0);
    if (!state.packages.length) throw new Error("No packages found in data file.");
    renderPackageTabs();
    selectPackage(state.packages.find((item) => item.id === payload.defaultPackageId) || state.packages[0]);
  } catch (error) {
    console.error(error);
    showTrackStatus("فهرست مجموعه‌ها بارگیری نشد. صفحه را دوباره باز کنید.");
  }
}

// ── Debug mode ──────────────────────────────────────────────────────────────

function setupDebugTimer() {
  if (!IS_DEBUG) return;

  const wrap = document.createElement("div");
  wrap.className = "debug-bar";

  // ← 0.1s back
  const btnBack = document.createElement("button");
  btnBack.className = "debug-btn";
  btnBack.textContent = "◀";
  btnBack.title = "۰.۱ ثانیه به جلو";
  btnBack.addEventListener("click", () => {
    elements.audio.pause();
    elements.audio.currentTime = Math.min(elements.audio.duration || 0, elements.audio.currentTime + 0.1);
    syncWordState();
  });

  // time display (click to copy)
  const el = document.createElement("div");
  el.id = "debug-timer";
  el.className = "debug-timer";
  el.title = "کلیک برای کپی";
  el.textContent = "0.00";
  el.addEventListener("click", () => {
    navigator.clipboard.writeText(el.textContent).then(() => {
      el.dataset.copied = "1";
      setTimeout(() => delete el.dataset.copied, 900);
    });
  });

  // ► 0.1s forward
  const btnFwd = document.createElement("button");
  btnFwd.className = "debug-btn";
  btnFwd.textContent = "▶";
  btnFwd.title = "۰.۱ ثانیه به عقب";
  btnFwd.addEventListener("click", () => {
    elements.audio.pause();
    elements.audio.currentTime = Math.max(0, elements.audio.currentTime - 0.1);
    syncWordState();
  });

  // test: play 3s then return
  let testTimer = null;
  const btnTest = document.createElement("button");
  btnTest.className = "debug-btn debug-btn-test";
  btnTest.textContent = "تست";
  btnTest.title = "۳ ثانیه پخش و بازگشت";
  btnTest.addEventListener("click", () => {
    if (testTimer !== null) {
      clearTimeout(testTimer);
      testTimer = null;
      elements.audio.pause();
      btnTest.dataset.active = "";
      delete btnTest.dataset.active;
      return;
    }
    const returnTo = elements.audio.currentTime;
    btnTest.dataset.active = "1";
    elements.audio.play().catch(() => {});
    testTimer = setTimeout(() => {
      elements.audio.pause();
      elements.audio.currentTime = returnTo;
      syncWordState();
      testTimer = null;
      delete btnTest.dataset.active;
    }, 1000);
  });

  elements.audio.addEventListener("timeupdate", () => {
    el.textContent = elements.audio.currentTime.toFixed(2);
  });

  wrap.append(btnFwd, btnTest, btnBack, el);

  const bar = document.getElementById("audio-bar");
  bar.parentNode.insertBefore(wrap, bar);

  // debug-only shortcut: c = copy timestamp
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select")) return;
    if (e.key === "c") { e.preventDefault(); el.click(); }
    if (e.key === "p") { e.preventDefault(); btnTest.click(); }
  });
}

function init() {
  restorePlaybackRate();
  bindEvents();
  setupPlayerControls();
  setupDebugTimer();
  registerPWA();
  loadData();
}

init();
