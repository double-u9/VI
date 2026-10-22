/**
 * Local AI Financial Agent - Chatbot Frontend Client
 * Pure Vanilla JavaScript implementation
 */

// Configuration Constants
const API_CONFIG = {
  ENDPOINT: 'http://localhost:3000/api/chat',
  TIMEOUT_MS: 30000 // 30 seconds timeout for local LLM inference
};

/**
 * Retrieves or generates a unique session ID for the current browser tab.
 * Persists across refreshes within the same tab via sessionStorage.
 * @returns {string} Session identifier
 */
function getOrCreateSessionId() {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      let sid = window.sessionStorage.getItem('vi_session_id');
      if (!sid) {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
          sid = 'sess_' + crypto.randomUUID();
        } else {
          sid = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
        }
        window.sessionStorage.setItem('vi_session_id', sid);
      }
      return sid;
    }
  } catch (e) {
    console.warn('[Session] Storage unavailable, using ephemeral ID:', e);
  }
  return 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
}

// DOM Elements (Safely resolved in both browser and test environments)
const getEl = (id) => (typeof document !== 'undefined' && typeof document.getElementById === 'function') ? document.getElementById(id) : null;
const chatWindow = getEl('chat-window');
const messagesContainer = getEl('messages-container');
const chatForm = getEl('chat-form');
const userInput = getEl('user-input');
const sendBtn = getEl('send-btn');
const micBtn = getEl('mic-btn');
const typingIndicator = getEl('typing-indicator');
const quickPromptsBar = getEl('quick-prompts');
const welcomeTimestamp = getEl('welcome-timestamp');

// Voice Recording & Visualizer System (Gemini / Antigravity Style)
const voiceRecordingDock = getEl('voice-recording-dock');
const voiceRecordingBar = getEl('voice-recording-bar');
const voiceWavesWrapper = getEl('voice-waves-wrapper');
const voiceStopBtn = getEl('voice-stop-btn');
const voiceSendBtn = getEl('voice-send-btn');
const voiceLiveBubble = getEl('voice-live-bubble');
const voiceLiveText = getEl('voice-live-text');
const voiceStatusLabel = getEl('voice-status-label');

const SpeechRecognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
let recognition = null;
let isVoiceActive = false;
let explicitlyStopped = false;
let accumulatedSpeech = '';
let interimSpeech = '';
let isRequestInProgress = false; // Synchronous guard against duplicate / concurrent request submissions

// Web Audio API Frequency Visualizer state (Gemini AI outward emanation visualizer)
let audioCtx = null;
let analyser = null;
let micStream = null;
let animFrameId = null;
let voiceCanvas = null;
let voiceCtx = null;
let visualizerBars = [];
let smoothedRms = 0;
let smoothedAuraEnergy = 0;

// Gemini Outward Wave Propagation Register
// Captures speech energy at center (d=0) and shifts wave packets outward (d=1..numSteps)
let waveHistory = [];
let lastWaveShiftTime = 0;
const WAVE_SHIFT_INTERVAL_MS = 38; // Time step for wave ripples traveling to outer edges (~26 steps/sec)

/**
 * Initializes or resizes the high-DPI Canvas for Gemini-style voice visualizer
 */
function initVoiceVisualizerCanvas() {
  const container = document.getElementById('voice-waves-wrapper');
  voiceCanvas = document.getElementById('voice-waves-canvas');
  if (!container || !voiceCanvas) return;

  voiceCtx = voiceCanvas.getContext('2d', { alpha: true });
  if (!voiceCtx) return;

  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(120, Math.floor(rect.width || 360));
  const height = Math.max(30, Math.floor(rect.height || 42));

  voiceCanvas.width = Math.floor(width * dpr);
  voiceCanvas.height = Math.floor(height * dpr);
  voiceCanvas.style.width = width + 'px';
  voiceCanvas.style.height = height + 'px';
  voiceCtx.scale(dpr, dpr);

  // Symmetrical bars emanating from center: ~3px width, ~4px gap
  const barWidth = 3;
  const barGap = 4;
  const step = barWidth + barGap;
  const maxAllowedBars = Math.floor((width - 12) / step);
  let count = Math.min(160, Math.max(17, maxAllowedBars));
  if (count % 2 === 0) count -= 1; // Always odd count for exact center symmetry

  visualizerBars = [];
  const mid = (count - 1) / 2;
  const numSteps = Math.floor(count / 2);
  waveHistory = new Float32Array(numSteps + 1);
  lastWaveShiftTime = 0;

  for (let i = 0; i < count; i++) {
    const distIndex = Math.abs(i - mid); // 0 at center, numSteps at outer bounds
    const normDist = distIndex / mid;    // 0 at center, 1 at ends
    visualizerBars.push({
      currentH: 3.5,
      targetH: 3.5,
      currentOpacity: 0.45,
      targetOpacity: 0.45,
      distIndex,
      normDist
    });
  }

  drawRestingVoiceWaves();
}

/**
 * Helper to render rounded capsule on canvas (supports modern roundRect with cross-browser fallback)
 */
function drawCapsule(ctx, x, y, w, h) {
  const r = Math.min(w / 2, h / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }
  ctx.fill();
}

/**
 * Draws the resting flat symmetrical micro-capsules centered in the visualizer when silent
 */
function drawRestingVoiceWaves() {
  if (!voiceCanvas || !voiceCtx || visualizerBars.length === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const width = voiceCanvas.width / dpr;
  const height = voiceCanvas.height / dpr;

  voiceCtx.clearRect(0, 0, width, height);

  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const barWidth = 3;
  const barGap = 4;
  const step = barWidth + barGap;
  const count = visualizerBars.length;
  const totalW = count * step - barGap;
  const startX = (width - totalW) / 2;

  voiceCtx.fillStyle = isDark ? 'rgba(74, 222, 128, 0.55)' : 'rgba(124, 58, 237, 0.55)';
  voiceCtx.shadowBlur = 0;

  for (let i = 0; i < count; i++) {
    const x = startX + i * step;
    const h = 3.5;
    const y = (height - h) / 2;
    voiceCtx.globalAlpha = 0.45;
    drawCapsule(voiceCtx, x, y, barWidth, h);
  }
}

/**
 * Modulates real-time multi-color chromatic aura around voice recording dock & chat form
 * Inspired by Google Gemini & Apple Siri
 * @param {number} energy - Normalized audio energy [0.0 - 1.0]
 * @param {boolean} isDark - Active theme state
 * @returns {object|null}
 */
function updateAudioReactiveChromaticAura(energy, isDark) {
  if (typeof document === 'undefined') return null;
  const dock = document.getElementById('voice-recording-dock');
  const form = document.getElementById('chat-form');
  const target = (dock && dock.style.display !== 'none') ? dock : form;
  if (!target) return null;

  if (target.classList && typeof target.classList.add === 'function') {
    target.classList.add('audio-reactive-active');
  }

  // Baseline ambient pulse when recording + dynamic reactive burst when speaking
  const clampedEnergy = Math.max(0.06, Math.min(1.0, energy));

  let boxShadow = '';
  let borderColor = '';

  if (isDark) {
    // Dark Mode: Fluid Emerald Green (#059669 / #10b981) + Cyan/Teal (#06b6d4)
    const blur1 = Math.round(10 + clampedEnergy * 24);
    const blur2 = Math.round(20 + clampedEnergy * 44);
    const blur3 = Math.round(34 + clampedEnergy * 65);
    const spread1 = Math.round(clampedEnergy * 4);
    const spread2 = Math.round(clampedEnergy * 8);

    const a1 = (0.28 + clampedEnergy * 0.45).toFixed(3);
    const a2 = (0.18 + clampedEnergy * 0.38).toFixed(3);
    const a3 = (0.08 + clampedEnergy * 0.28).toFixed(3);
    const borderAlpha = (0.42 + clampedEnergy * 0.52).toFixed(3);

    boxShadow = `0 0 ${blur1}px ${spread1}px rgba(16, 185, 129, ${a1}), 0 0 ${blur2}px ${spread2}px rgba(6, 182, 212, ${a2}), 0 10px ${blur3}px rgba(5, 150, 105, ${a3})`;
    borderColor = `rgba(16, 185, 129, ${borderAlpha})`;
  } else {
    // Light Mode: Vibrant Royal Violet (#7c3aed) + Electric Indigo (#6366f1)
    const blur1 = Math.round(10 + clampedEnergy * 24);
    const blur2 = Math.round(20 + clampedEnergy * 44);
    const blur3 = Math.round(34 + clampedEnergy * 65);
    const spread1 = Math.round(clampedEnergy * 4);
    const spread2 = Math.round(clampedEnergy * 8);

    const a1 = (0.25 + clampedEnergy * 0.42).toFixed(3);
    const a2 = (0.16 + clampedEnergy * 0.34).toFixed(3);
    const a3 = (0.08 + clampedEnergy * 0.24).toFixed(3);
    const borderAlpha = (0.42 + clampedEnergy * 0.52).toFixed(3);

    boxShadow = `0 0 ${blur1}px ${spread1}px rgba(124, 58, 237, ${a1}), 0 0 ${blur2}px ${spread2}px rgba(99, 102, 241, ${a2}), 0 10px ${blur3}px rgba(139, 92, 246, ${a3})`;
    borderColor = `rgba(124, 58, 237, ${borderAlpha})`;
  }

  if (target.style) {
    target.style.boxShadow = boxShadow;
    target.style.borderColor = borderColor;
  }

  return { energy: clampedEnergy, isDark, targetId: target.id || null, boxShadow, borderColor };
}

/**
 * Resets the chromatic aura when recording stops or cancels
 */
function resetAudioReactiveChromaticAura() {
  smoothedAuraEnergy = 0;
  if (typeof document === 'undefined') return true;
  const dock = document.getElementById('voice-recording-dock');
  const form = document.getElementById('chat-form');
  [dock, form].forEach(el => {
    if (el) {
      if (el.classList && typeof el.classList.remove === 'function') {
        el.classList.remove('audio-reactive-active');
      }
      if (el.style) {
        el.style.boxShadow = '';
        el.style.borderColor = '';
      }
    }
  });
  return true;
}

/**
 * Starts real-time Web Audio API frequency & volume analyzer to dynamically animate waveform bars
 * Emanates outward symmetrically from the center to both left and right, with buttery smooth LERP interpolation
 */
async function startWaveVisualizer(stream) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128; // 64 frequency bins, 128 time-domain samples
    analyser.smoothingTimeConstant = 0.48;
    source.connect(analyser);

    const freqData = new Uint8Array(analyser.frequencyBinCount);
    const timeData = new Uint8Array(analyser.fftSize);

    initVoiceVisualizerCanvas();

    function renderAudioWaves() {
      if (!isVoiceActive) return;

      // 1. RMS measurement for acoustic volume
      analyser.getByteTimeDomainData(timeData);
      let sumSquares = 0;
      for (let j = 0; j < timeData.length; j++) {
        const norm = (timeData[j] - 128) / 128;
        sumSquares += norm * norm;
      }
      const rawRms = Math.sqrt(sumSquares / timeData.length);
      smoothedRms += (rawRms - smoothedRms) * 0.28;

      // 2. Frequency spectrum measurement
      analyser.getByteFrequencyData(freqData);

      let speechBandSum = 0;
      const bandEnd = Math.min(24, freqData.length);
      for (let b = 1; b < bandEnd; b++) {
        speechBandSum += freqData[b];
      }
      const avgSpeechFreq = speechBandSum / ((bandEnd - 1) * 255);

      // Voice activity threshold
      const isSpeaking = smoothedRms > 0.016 || avgSpeechFreq > 0.08;

      // 3. Audio-Reactive Chromatic Aura (Google Gemini & Siri Style)
      const currentTheme = (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme')) || 'dark';
      const isDark = currentTheme !== 'light';

      const auraTarget = Math.min(1.0, Math.pow(Math.max(0, rawRms - 0.01) * 3.8, 0.82));
      const lerpFactor = auraTarget > smoothedAuraEnergy ? 0.34 : 0.14;
      smoothedAuraEnergy += (auraTarget - smoothedAuraEnergy) * lerpFactor;
      updateAudioReactiveChromaticAura(smoothedAuraEnergy, isDark);

      if (!voiceCanvas || !voiceCtx || visualizerBars.length === 0) {
        animFrameId = requestAnimationFrame(renderAudioWaves);
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      const width = voiceCanvas.width / dpr;
      const height = voiceCanvas.height / dpr;
      const count = visualizerBars.length;
      const numSteps = Math.floor(count / 2);

      voiceCtx.clearRect(0, 0, width, height);

      const barWidth = 3;
      const barGap = 4;
      const step = barWidth + barGap;
      const totalW = count * step - barGap;
      const startX = (width - totalW) / 2;
      const maxHeight = Math.max(16, height - 6);
      const minHeight = 3.5;

      // Theme-aware smooth gradient across the visualizer width
      const grad = voiceCtx.createLinearGradient(startX, 0, startX + totalW, 0);
      if (isDark) {
        grad.addColorStop(0, '#059669');
        grad.addColorStop(0.25, '#10b981');
        grad.addColorStop(0.5, '#4ade80');
        grad.addColorStop(0.75, '#10b981');
        grad.addColorStop(1, '#059669');
      } else {
        grad.addColorStop(0, '#6366f1');
        grad.addColorStop(0.25, '#7c3aed');
        grad.addColorStop(0.5, '#a855f7');
        grad.addColorStop(0.75, '#7c3aed');
        grad.addColorStop(1, '#6366f1');
      }
      voiceCtx.fillStyle = grad;

      // Current voice energy captured strictly at center
      let centerEnergy = 0;
      if (isSpeaking) {
        centerEnergy = Math.min(1.0, (smoothedRms * 2.4 + avgSpeechFreq * 0.95));
        centerEnergy = Math.pow(centerEnergy, 0.85); // Perceptual acoustic curve
      }

      // Outward propagation shift clock:
      // Injects current speech energy at the center and shifts wave packets outward left & right
      const now = performance.now();
      if (now - lastWaveShiftTime >= WAVE_SHIFT_INTERVAL_MS) {
        lastWaveShiftTime = now;
        for (let d = numSteps; d > 0; d--) {
          waveHistory[d] = (waveHistory[d - 1] || 0) * 0.962; // Natural dissipation
        }
        waveHistory[0] = centerEnergy;
      } else {
        // Immediate dynamic response if speech spikes between shift ticks
        if (centerEnergy > (waveHistory[0] || 0)) {
          waveHistory[0] = centerEnergy;
        }
      }

      // Fluid Gemini subtle glow when speaking
      if (isSpeaking && smoothedRms > 0.035) {
        voiceCtx.shadowColor = isDark ? 'rgba(74, 222, 128, 0.42)' : 'rgba(139, 92, 246, 0.42)';
        voiceCtx.shadowBlur = Math.min(12, smoothedRms * 32);
      } else {
        voiceCtx.shadowBlur = 0;
      }

      // Render each bar based on the traveling wave packet at its distance from center
      for (let i = 0; i < count; i++) {
        const bar = visualizerBars[i];
        const d = bar.distIndex;
        const energyAtD = waveHistory[d] || 0;

        // Taper gently at the outer boundaries so waves dissolve cleanly before the edge
        const taper = Math.cos((d / numSteps) * (Math.PI * 0.44));
        const effectiveEnergy = energyAtD * taper;

        if (effectiveEnergy < 0.016) {
          bar.targetH = minHeight;
          bar.targetOpacity = 0.45;
        } else {
          bar.targetH = Math.min(maxHeight, minHeight + effectiveEnergy * (maxHeight - minHeight));
          bar.targetOpacity = Math.min(1.0, 0.45 + effectiveEnergy * 0.55);
        }

        // Buttery smooth LERP interpolation (responsive attack, gentle decay)
        const lerpFactor = bar.targetH > bar.currentH ? 0.40 : 0.22;
        bar.currentH += (bar.targetH - bar.currentH) * lerpFactor;
        bar.currentOpacity += (bar.targetOpacity - bar.currentOpacity) * 0.26;

        const x = startX + i * step;
        const h = bar.currentH;
        const y = (height - h) / 2; // Centered vertically!

        voiceCtx.globalAlpha = bar.currentOpacity;
        drawCapsule(voiceCtx, x, y, barWidth, h);
      }

      animFrameId = requestAnimationFrame(renderAudioWaves);
    }

    animFrameId = requestAnimationFrame(renderAudioWaves);
  } catch (err) {
    console.warn('Real-time AudioContext visualizer note:', err);
  }
}

/**
 * Stops Web Audio API visualizer & resets wave bars to resting flat state
 */
function stopWaveVisualizer() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  if (audioCtx && audioCtx.state !== 'closed') {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  if (waveHistory && waveHistory.fill) {
    waveHistory.fill(0);
  }
  lastWaveShiftTime = 0;
  smoothedRms = 0;
  resetAudioReactiveChromaticAura();
  drawRestingVoiceWaves();
}

/**
 * Shows the voice recording bar and hides normal typing input form
 */
function showVoiceBar() {
  const dock = document.getElementById('voice-recording-dock');
  const bar = document.getElementById('voice-recording-bar');
  if (chatForm) chatForm.style.display = 'none';
  if (dock) {
    dock.style.display = 'flex';
    dock.classList.remove('has-live-transcription');
  }
  if (bar) bar.style.display = 'flex';
  initVoiceVisualizerCanvas();
  setTimeout(() => {
    initVoiceVisualizerCanvas();
  }, 40);
  window.dispatchEvent(new Event('resize'));
}

/**
 * Hides the voice recording bar and restores normal typing input form
 */
function hideVoiceBar() {
  resetAudioReactiveChromaticAura();
  const dock = document.getElementById('voice-recording-dock');
  const bar = document.getElementById('voice-recording-bar');
  if (dock) {
    dock.style.display = 'none';
    dock.classList.remove('has-live-transcription');
  }
  if (bar) bar.style.display = 'none';
  if (chatForm) chatForm.style.display = 'flex';
  const bubble = document.getElementById('voice-live-bubble');
  if (bubble) {
    bubble.style.display = 'none';
    const bubbleText = document.getElementById('voice-live-text');
    if (bubbleText) bubbleText.textContent = '';
  }
  window.dispatchEvent(new Event('resize'));
}

/**
 * Sets up a fresh speech recognition session
 */
function setupRecognitionSession() {
  if (!SpeechRecognition) return;

  try {
    recognition = new SpeechRecognition();
    recognition.lang = 'ar-IQ'; // Iraqi Arabic default
    recognition.continuous = true; // DO NOT STOP on pause or silence
    recognition.interimResults = true; // Real-time feedback
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isVoiceActive = true;
      const statusLabel = document.getElementById('voice-status-label');
      if (statusLabel) statusLabel.textContent = 'جارٍ الاستماع...';
    };

    recognition.onresult = (event) => {
      if (!isVoiceActive) return;
      let currentInterim = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const result = event.results[i];
        if (result.isFinal) {
          accumulatedSpeech += result[0].transcript + ' ';
        } else {
          currentInterim += result[0].transcript;
        }
      }
      interimSpeech = currentInterim;

      const fullRecognized = (accumulatedSpeech + ' ' + interimSpeech).trim();
      if (fullRecognized) {
        const bubble = document.getElementById('voice-live-bubble');
        const bubbleText = document.getElementById('voice-live-text');
        const statusLabel = document.getElementById('voice-status-label');
        const dock = document.getElementById('voice-recording-dock');
        if (bubble && bubbleText) {
          bubble.style.display = 'flex';
          bubbleText.textContent = fullRecognized;
          if (dock) dock.classList.add('has-live-transcription');

          // Auto-scroll so newest words (on the left in RTL) remain in view
          const wrapper = document.getElementById('voice-live-text-wrapper');
          if (wrapper) {
            requestAnimationFrame(() => {
              wrapper.scrollLeft = -wrapper.scrollWidth;
            });
          }
        }
        if (statusLabel) {
          statusLabel.textContent = 'جارٍ التسجيل...';
        }
      }
    };

    recognition.onerror = (event) => {
      console.warn('Speech recognition status:', event.error);
      if (event.error === 'not-allowed') {
        alert('يرجى منح إذن استخدام الميكروفون في المتصفح لتفعيل ميزة التسجيل الصوتي.');
        finishVoiceRecording(false);
      }
    };

    recognition.onend = () => {
      // Auto-restart if silence timeout occurred but user didn't stop recording
      if (isVoiceActive && !explicitlyStopped) {
        try {
          recognition.start();
        } catch (err) {}
      }
    };

    recognition.start();
  } catch (err) {
    console.error('Speech recognition error:', err);
  }
}

/**
 * Starts continuous voice recording session with instant 0ms UI transition
 */
function startVoiceRecording() {
  stopSpeaking();
  finishActiveStream();
  accumulatedSpeech = '';
  interimSpeech = '';
  explicitlyStopped = false;
  isVoiceActive = true;

  if (micBtn) {
    micBtn.classList.add('recording');
  }

  const bubble = document.getElementById('voice-live-bubble');
  const bubbleText = document.getElementById('voice-live-text');
  const statusLabel = document.getElementById('voice-status-label');
  const dock = document.getElementById('voice-recording-dock');

  if (bubbleText) bubbleText.textContent = 'تحدث الآن باللغة العربية...';
  if (bubble) bubble.style.display = 'none';
  if (dock) dock.classList.remove('has-live-transcription');
  if (statusLabel) statusLabel.textContent = 'جارٍ الاستماع...';

  // 1. Instantly switch UI to voice dock with ZERO latency
  showVoiceBar();

  // 2. Start speech recognition immediately (Web Speech API starts listening in 0ms)
  setupRecognitionSession();

  // 3. Connect audio stream for visualizer bars in parallel without blocking UI
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        if (!isVoiceActive || explicitlyStopped) {
          // User stopped before stream arrived
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        micStream = stream;
        startWaveVisualizer(stream);
      })
      .catch((err) => {
        console.warn('Microphone permission or hardware note:', err);
        if (isVoiceActive) {
          finishVoiceRecording(false);
          alert('يرجى منح إذن استخدام الميكروفون في المتصفح لتفعيل ميزة التسجيل الصوتي.');
        }
      });
  }
}

/**
 * Finishes voice recording session
 * @param {boolean} autoSend - If true, immediately sends message without waiting for user review
 */
function finishVoiceRecording(autoSend = false) {
  explicitlyStopped = true;
  isVoiceActive = false;

  if (micBtn) {
    micBtn.classList.remove('recording');
  }

  // 1. Instantly detach all handlers & abort recognition to prevent any delayed callbacks
  if (recognition) {
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch (err) {}
    recognition = null;
  }

  // 2. Stop visualizer & hide bar immediately
  stopWaveVisualizer();
  hideVoiceBar();

  // 3. Immediately hide live speech transcript bubble with ZERO delay
  const bubble = document.getElementById('voice-live-bubble');
  const bubbleText = document.getElementById('voice-live-text');
  const dock = document.getElementById('voice-recording-dock');
  if (dock) dock.classList.remove('has-live-transcription');
  if (bubble) bubble.style.display = 'none';
  if (bubbleText) bubbleText.textContent = '';

  const recordedText = (accumulatedSpeech + ' ' + interimSpeech).trim();
  accumulatedSpeech = '';
  interimSpeech = '';

  if (autoSend) {
    // Instant direct send: clear textarea completely and send without residue
    userInput.value = '';
    updateInputState();

    if (recordedText.length > 0) {
      if (!isRequestInProgress) {
        handleFormSubmit(recordedText);
      }
    } else {
      userInput.focus();
    }
  } else {
    // User pressed Stop to review & edit text in textarea
    if (recordedText) {
      userInput.value = recordedText;
    }
    updateInputState();
    userInput.focus();
  }
}

/**
 * Backward compatibility alias for waveform initialization
 */
function buildWaveformBars() {
  initVoiceVisualizerCanvas();
}

/**
 * Initialize Speech Recognition controls & event listeners
 */
function initSpeechRecognition() {
  if (!micBtn) return;

  initVoiceVisualizerCanvas();

  window.addEventListener('resize', () => {
    if (isVoiceActive) {
      initVoiceVisualizerCanvas();
    }
  });

  if (!SpeechRecognition) {
    console.warn('Web Speech API is not supported in this browser.');
    micBtn.addEventListener('click', () => {
      alert('عذراً، متصفحك لا يدعم ميزة التعرف على الصوت (Web Speech API). يرجى استخدام متصفح حديث مثل Chrome أو Edge.');
    });
    return;
  }

  // Toggle voice mode from the microphone icon
  micBtn.addEventListener('click', () => {
    if (isRequestInProgress) return;
    if (isVoiceActive) {
      finishVoiceRecording(false);
    } else {
      startVoiceRecording();
    }
  });

  // Stop & Review Button (Square icon): stops recording, converts to text in textarea, user reviews/edits
  const stopBtn = document.getElementById('voice-stop-btn');
  if (stopBtn) {
    stopBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isRequestInProgress) return;
      finishVoiceRecording(false);
    });
  }

  // Instant Direct Send Button: sends directly immediately without reviewing
  const sendVoiceBtn = document.getElementById('voice-send-btn');
  if (sendVoiceBtn) {
    sendVoiceBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isRequestInProgress) return;
      finishVoiceRecording(true);
    });
  }

  // Global Keydown shortcuts while voice recording is active
  window.addEventListener('keydown', (e) => {
    if (!isVoiceActive) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      explicitlyStopped = true;
      accumulatedSpeech = '';
      interimSpeech = '';
      finishVoiceRecording(false);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finishVoiceRecording(true);
    }
  });
}

/**
 * Generates an embedded, zero-network SVG data URI avatar for the bot
 * that matches the theme perfectly and never fails to render.
 */
function getBotFallbackAvatarUri(theme) {
  const isLight = theme === 'light';
  const bgGradient = isLight 
    ? '<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#9333ea"/><stop offset="100%" stop-color="#6b21a8"/></linearGradient></defs>'
    : '<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#10b981"/><stop offset="100%" stop-color="#047857"/></linearGradient></defs>';
  
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${bgGradient}<rect width="100" height="100" rx="50" fill="url(#g)"/><circle cx="50" cy="27" r="4" fill="white"/><rect x="48" y="27" width="4" height="9" fill="white"/><rect x="23" y="36" width="54" height="40" rx="17" fill="white"/><rect x="18" y="47" width="8" height="18" rx="4" fill="white"/><rect x="74" y="47" width="8" height="18" rx="4" fill="white"/><rect x="29" y="42" width="42" height="28" rx="11" fill="url(#g)"/><ellipse cx="42" cy="56" rx="4" ry="5.5" fill="white"/><ellipse cx="58" cy="56" rx="4" ry="5.5" fill="white"/></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/**
 * Returns the appropriate bot avatar image URL based on current active theme
 */
function getBotAvatarSrc() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  return currentTheme === 'light' ? 'assets/bot-violet.png' : 'assets/bot-emerald.png';
}

/**
 * Creates a robust circular bot avatar DOM element with multi-tiered fallback
 */
function createBotAvatarElement() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return null;
  }
  const avatarEl = document.createElement('div');
  avatarEl.classList.add('msg-avatar');
  const imgEl = document.createElement('img');
  imgEl.classList.add('avatar-img');
  
  const currentTheme = (document.documentElement && typeof document.documentElement.getAttribute === 'function')
    ? (document.documentElement.getAttribute('data-theme') || 'light')
    : 'light';
  imgEl.src = getBotAvatarSrc();
  imgEl.alt = 'المساعد المالي';
  imgEl.loading = 'eager';
  imgEl.decoding = 'async';

  // Multi-tier resilience: if network or relative path has any issue, failover gracefully
  imgEl.onerror = function() {
    const theme = (typeof document !== 'undefined' && document.documentElement && typeof document.documentElement.getAttribute === 'function')
      ? (document.documentElement.getAttribute('data-theme') || 'light')
      : 'light';
    const filename = theme === 'light' ? 'bot-violet.png' : 'bot-emerald.png';

    // Attempt 1: Try root-relative /assets/
    if (!this.dataset.retriedRoot) {
      this.dataset.retriedRoot = '1';
      this.src = '/assets/' + filename;
      return;
    }
    // Attempt 2: Try frontend/assets/
    if (!this.dataset.retriedFrontend) {
      this.dataset.retriedFrontend = '1';
      this.src = 'frontend/assets/' + filename;
      return;
    }
    // Final Guaranteed Fallback: Inline SVG Data URI (zero network, renders instantaneously)
    this.onerror = null;
    this.src = getBotFallbackAvatarUri(theme);
  };

  avatarEl.appendChild(imgEl);
  return avatarEl;
}

/**
 * Theme Management (Light White & Royal Violet <-> Dark Black & Emerald Green)
 */
function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  if (document.body) {
    document.body.setAttribute('data-theme', theme);
  }
  const themeLabel = document.getElementById('theme-label-text');
  const badgeThemeText = document.getElementById('badge-theme-text');
  const themeToggleBtn = document.getElementById('theme-toggle-btn');

  if (themeLabel) {
    themeLabel.textContent = theme === 'light' ? 'أبيض وبنفسجي' : 'أسود وأخضر';
  }
  if (badgeThemeText) {
    badgeThemeText.textContent = theme === 'light' ? 'ثيم الأبيض والبنفسجي' : 'ثيم الزمرد الفاخر';
  }
  if (themeToggleBtn) {
    themeToggleBtn.setAttribute('data-active-theme', theme);
  }

  // Instantly update all bot avatars across the app to match the theme
  const avatarSrc = theme === 'light' ? 'assets/bot-violet.png' : 'assets/bot-emerald.png';
  document.querySelectorAll('.avatar-img').forEach(img => {
    delete img.dataset.retriedRoot;
    delete img.dataset.retriedFrontend;
    img.onerror = function() {
      this.onerror = null;
      this.src = getBotFallbackAvatarUri(theme);
    };
    img.src = avatarSrc;
  });

  // Instantly update the centerpiece hero logo to match the theme (Emerald vs Violet)
  const heroLogoImg = document.getElementById('hero-logo-img');
  if (heroLogoImg) {
    heroLogoImg.src = theme === 'light' ? 'assets/logo-violet.png' : 'assets/logo-emerald.png';
  }

  // Instantly update resting voice visualizer theme colors
  if (typeof drawRestingVoiceWaves === 'function') {
    drawRestingVoiceWaves();
  }
}

/**
 * Triggers a state-of-the-art circular ripple transition using the native CSS View Transitions API
 * (document.startViewTransition). Calculates exact button viewport coordinates and expands a circular
 * CSS clip-path animation on ::view-transition-new(root) from circle(0px at x y) to circle(maxRadius at x y)
 * over 380ms with cubic-bezier(0.16, 1, 0.3, 1), providing a seamless fluid wave with automatic instant fallback.
 * @param {string} targetTheme - 'dark' | 'light'
 * @param {HTMLElement|null} [triggerBtn] - Element to emanate the circular ripple from
 * @returns {ViewTransition|null}
 */
function toggleThemeWithRipple(targetTheme, triggerBtn) {
  const updateThemeState = () => {
    applyTheme(targetTheme);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('fintech_theme', targetTheme);
      }
    } catch (e) {}
  };

  const prefersReducedMotion = typeof window !== 'undefined' && 
                               window.matchMedia && 
                               window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Gracefully fallback to instant theme switch if View Transitions API is not supported or reduced motion is preferred
  if (typeof document === 'undefined' || !document.startViewTransition || prefersReducedMotion) {
    updateThemeState();
    return null;
  }

  // 1. Calculate exact button viewport coordinates (x, y) via getBoundingClientRect()
  let x = typeof window !== 'undefined' ? window.innerWidth / 2 : 0;
  let y = typeof window !== 'undefined' ? window.innerHeight / 2 : 0;

  const btn = triggerBtn || (typeof document !== 'undefined' ? document.getElementById('theme-toggle-btn') : null);
  if (btn && typeof btn.getBoundingClientRect === 'function') {
    const rect = btn.getBoundingClientRect();
    x = rect.left + rect.width / 2;
    y = rect.top + rect.height / 2;
  }

  // 2. Calculate maximum radius to screen corners
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 1080;
  const maxRadius = Math.hypot(
    Math.max(x, viewportWidth - x),
    Math.max(y, viewportHeight - y)
  );

  // Set CSS custom properties on documentElement for CSS keyframe animation synchronization
  if (typeof document !== 'undefined' && document.documentElement && document.documentElement.style) {
    document.documentElement.style.setProperty('--ripple-x', `${x}px`);
    document.documentElement.style.setProperty('--ripple-y', `${y}px`);
    document.documentElement.style.setProperty('--ripple-r', `${maxRadius}px`);
  }

  // 3. Morphing Transition Mechanics via document.startViewTransition()
  const transition = document.startViewTransition(() => {
    updateThemeState();
  });

  if (transition && transition.ready) {
    transition.ready.then(() => {
      try {
        const clipPath = [
          `circle(0px at ${x}px ${y}px)`,
          `circle(${maxRadius}px at ${x}px ${y}px)`
        ];

        document.documentElement.animate(
          {
            clipPath: clipPath
          },
          {
            duration: 380,
            easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
            pseudoElement: '::view-transition-new(root)'
          }
        );
      } catch (e) {
        // Fallback gracefully if pseudoElement animation is unsupported in current engine
      }
    }).catch(() => {
      // Gracefully handle aborted or interrupted transitions
    });
  }

  return transition;
}

function initThemeToggle() {
  const themeToggleBtn = document.getElementById('theme-toggle-btn');

  // Default theme is 'dark' (Emerald & Black as primary console look)
  let savedTheme = 'dark';
  try {
    if (typeof localStorage !== 'undefined') {
      savedTheme = localStorage.getItem('fintech_theme') || 'dark';
    }
  } catch (e) {}
  applyTheme(savedTheme);

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const currentTheme = (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme')) || 'dark';
      const targetTheme = currentTheme === 'light' ? 'dark' : 'light';
      toggleThemeWithRipple(targetTheme, themeToggleBtn);
    });
  }
}

/**
 * Dual-Currency State & Exchange Rate Engine (IQD ⇄ USD)
 * Baseline: 100 USD = 153,000 IQD => 1 USD = 1,530 IQD
 * Pristine base currency precision (IQD) is preserved behind the scenes.
 */
let activeCurrency = 'IQD';
let iqdPerUsdRate = 1530;
let exchangeRateConfig = {
  base_currency: 'IQD',
  target_currency: 'USD',
  iqd_per_usd: 1530,
  usd_sample: 100,
  iqd_sample: 153000,
  formatted_rate: '100$ = 153,000 د.ع'
};

// Safe localStorage initialization
try {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem('vi_active_currency');
    if (saved === 'USD' || saved === 'IQD') {
      activeCurrency = saved;
    }
  }
} catch (_) {}

/**
 * Currency conversion mathematical helpers
 */
function convertIqdToUsd(amountIqd) {
  const num = Number(amountIqd) || 0;
  if (num <= 0) return 0;
  const rate = iqdPerUsdRate || 1530;
  return parseFloat((num / rate).toFixed(2));
}

function convertUsdToIqd(amountUsd) {
  const num = Number(amountUsd) || 0;
  if (num <= 0) return 0;
  const rate = iqdPerUsdRate || 1530;
  return Math.round(num * rate);
}

function getActiveCurrency() {
  return activeCurrency;
}

function getExchangeRateValue() {
  return iqdPerUsdRate;
}

function getExchangeRateConfig() {
  return { ...exchangeRateConfig };
}

/**
 * Formats live dual currency valuation with primary and secondary equivalent
 * @param {number} amountIqd - Base balance/amount in Iraqi Dinars
 * @param {boolean} isHidden - Privacy state (starred or revealed)
 * @param {boolean} isUsdPrimary - Whether USD is the primary displayed currency
 * @returns {{primary: string, secondary: string, primaryCurrency: string, secondaryCurrency: string}}
 */
function formatDualBalance(amountIqd, isHidden = isBalanceHidden, isUsdPrimary = (activeCurrency === 'USD')) {
  const num = Number(amountIqd) || 0;
  const rate = iqdPerUsdRate || 1530;
  const usdVal = num / rate;

  if (isHidden) {
    return {
      primary: '••••••',
      secondary: '••••••',
      primaryCurrency: isUsdPrimary ? 'USD' : 'IQD',
      secondaryCurrency: isUsdPrimary ? 'IQD' : 'USD'
    };
  }

  const iqdFormatted = `${num.toLocaleString('en-US')} د.ع`;
  const usdFormatted = `$${usdVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (isUsdPrimary) {
    return {
      primary: usdFormatted,
      secondary: `≈ ${iqdFormatted}`,
      primaryCurrency: 'USD',
      secondaryCurrency: 'IQD'
    };
  } else {
    return {
      primary: iqdFormatted,
      secondary: `≈ ${usdFormatted}`,
      primaryCurrency: 'IQD',
      secondaryCurrency: 'USD'
    };
  }
}

/**
 * Live Balance & Privacy Eye Toggle State
 * Default is hidden (isBalanceHidden = true) with stars per user requirement
 */
let currentWalletBalance = 3000000;
let isBalanceHidden = true;

/**
 * Updates the balance text and eye icon state across header and companion rail
 * Triggers fluid 3D number flip animation when animate is true
 * @param {boolean} animate - Whether to apply fluid flip transition
 */
function renderWalletBalance(animate = false) {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
  const balanceEl = document.getElementById('wallet-balance-display');
  const balanceSecondaryEl = document.getElementById('wallet-balance-secondary');
  const eyeBtn = document.getElementById('wallet-eye-btn');
  const companionBalanceEl = document.getElementById('companion-rail-balance');
  const companionBalanceSecondaryEl = document.getElementById('companion-rail-balance-secondary');
  const tickerEl = document.getElementById('companion-exchange-ticker');

  const isUsd = (activeCurrency === 'USD');
  const dual = formatDualBalance(currentWalletBalance, isBalanceHidden, isUsd);

  if (balanceEl) balanceEl.textContent = dual.primary;
  if (balanceSecondaryEl) balanceSecondaryEl.textContent = dual.secondary;

  if (companionBalanceEl) companionBalanceEl.textContent = dual.primary;
  if (companionBalanceSecondaryEl) companionBalanceSecondaryEl.textContent = dual.secondary;

  if (animate) {
    if (companionBalanceEl) {
      companionBalanceEl.classList.remove('balance-is-flipping');
      void companionBalanceEl.offsetWidth; // Reflow to trigger animation
      companionBalanceEl.classList.add('balance-is-flipping');
      setTimeout(() => {
        if (companionBalanceEl && companionBalanceEl.classList) {
          companionBalanceEl.classList.remove('balance-is-flipping');
        }
      }, 420);
    }

    if (typeof document.querySelectorAll === 'function') {
      const flipContainers = document.querySelectorAll('.balance-flip-container');
      flipContainers.forEach(el => {
        if (el && el.classList) {
          el.classList.remove('balance-is-flipping');
          void el.offsetWidth;
          el.classList.add('balance-is-flipping');
          setTimeout(() => {
            if (el && el.classList) {
              el.classList.remove('balance-is-flipping');
            }
          }, 420);
        }
      });
    }

    if (companionBalanceSecondaryEl) {
      companionBalanceSecondaryEl.style.opacity = '0';
      setTimeout(() => {
        if (companionBalanceSecondaryEl && companionBalanceSecondaryEl.style) {
          companionBalanceSecondaryEl.style.opacity = '0.85';
        }
      }, 150);
    }
  }

  if (eyeBtn) {
    if (isBalanceHidden) {
      eyeBtn.classList.add('is-hidden');
      eyeBtn.setAttribute('aria-label', 'إظهار الرصيد');
    } else {
      eyeBtn.classList.remove('is-hidden');
      eyeBtn.setAttribute('aria-label', 'إخفاء الرصيد');
    }
  }

  if (tickerEl && exchangeRateConfig && exchangeRateConfig.formatted_rate) {
    tickerEl.textContent = exchangeRateConfig.formatted_rate;
  }

  updateCurrencyTogglePills();
  if (typeof renderFintechPulse === 'function') {
    renderFintechPulse();
  }
}

/**
 * Updates all currency toggle pills (Header, Companion Card, Quick Transfer)
 */
function updateCurrencyTogglePills() {
  if (typeof document === 'undefined') return;

  // 1. Header Currency Switch Pill
  const headerPill = document.getElementById('currency-toggle-btn');
  if (headerPill) {
    headerPill.setAttribute('data-active', activeCurrency);
    const iqdItem = headerPill.querySelector('.currency-iqd');
    const usdItem = headerPill.querySelector('.currency-usd');
    if (iqdItem) iqdItem.classList.toggle('active', activeCurrency === 'IQD');
    if (usdItem) usdItem.classList.toggle('active', activeCurrency === 'USD');
  }

  // 2. Companion Balance Card Switcher
  const compActive = document.getElementById('companion-cur-badge-active');
  const compAlt = document.getElementById('companion-cur-badge-alt');
  if (compActive) compActive.textContent = activeCurrency;
  if (compAlt) compAlt.textContent = (activeCurrency === 'IQD') ? 'USD' : 'IQD';

  // 3. Quick Transfer Modal Currency Badge
  const qtName = document.getElementById('quick-transfer-currency-name');
  const qtUnit = document.getElementById('quick-transfer-amount-unit');
  if (qtName) {
    qtName.textContent = activeCurrency === 'USD' ? 'دولار أمريكي (USD)' : 'دينار عراقي (IQD)';
  }
  if (qtUnit) {
    qtUnit.textContent = activeCurrency === 'USD' ? '$' : 'د.ع';
  }
}

/**
 * Updates quick transfer amount wheel chips to show dual-currency valuation
 */
function updateQuickTransferChips() {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  const chips = document.querySelectorAll('.amount-wheel-chip');
  chips.forEach(chip => {
    const rawAmt = parseInt(chip.getAttribute('data-amount'), 10);
    if (isNaN(rawAmt)) return;
    let primaryEl = chip.querySelector('.chip-primary');
    let secondaryEl = chip.querySelector('.chip-secondary');
    if (!primaryEl) {
      chip.innerHTML = '<span class="chip-primary"></span><span class="chip-secondary"></span>';
      primaryEl = chip.querySelector('.chip-primary');
      secondaryEl = chip.querySelector('.chip-secondary');
    }
    const usdVal = (rawAmt / iqdPerUsdRate).toFixed(2);
    if (activeCurrency === 'USD') {
      primaryEl.textContent = `$${usdVal}`;
      secondaryEl.textContent = `≈ ${rawAmt.toLocaleString('en-US')} د.ع`;
    } else {
      primaryEl.textContent = `${rawAmt.toLocaleString('en-US')} د.ع`;
      secondaryEl.textContent = `≈ $${usdVal}`;
    }
  });
}

/**
 * Instantaneous ceiling guard: compares requested transfer amount against current available wallet balance.
 * If exceeded, smoothly tints the input border in soft amber, displays the Iraqi guidance alert
 * ('المبلغ المطلوب أكبر من رصيدك المتاح'), and gracefully disables #quick-transfer-submit-btn.
 * @param {number} [amountIqd] - Requested transfer amount in IQD
 * @param {number} [balance] - Available user wallet balance in IQD
 * @returns {{ isExceeded: boolean, amountIqd: number, balance: number }}
 */
function validateQuickTransferCeiling(amountIqd = currentTransferAmount, balance = currentWalletBalance) {
  const currentBal = (typeof balance === 'number' && balance >= 0)
    ? balance
    : (typeof currentWalletBalance === 'number' ? currentWalletBalance : 3000000);

  let amt = Number(amountIqd);
  if (isNaN(amt) || amt <= 0) {
    if (typeof document !== 'undefined') {
      const inputEl = document.getElementById('quick-transfer-amount-input');
      if (inputEl) {
        const rawDigits = inputEl.value.replace(/[^\d.]/g, '');
        const parsed = parseFloat(rawDigits) || 0;
        amt = activeCurrency === 'USD' ? Math.round(parsed * iqdPerUsdRate) : Math.round(parsed);
      }
    }
  }

  const isExceeded = (currentBal > 0) && (amt > currentBal);

  if (typeof document !== 'undefined') {
    const inputEl = document.getElementById('quick-transfer-amount-input');
    const alertEl = document.getElementById('quick-transfer-ceiling-alert');
    const alertMsgEl = document.getElementById('quick-transfer-ceiling-msg');
    const submitBtn = document.getElementById('quick-transfer-submit-btn');

    if (inputEl && inputEl.classList) {
      inputEl.classList.toggle('is-ceiling-exceeded', isExceeded);
      if (typeof inputEl.setAttribute === 'function') {
        inputEl.setAttribute('aria-invalid', isExceeded ? 'true' : 'false');
      }
    }

    if (alertEl && alertEl.classList) {
      alertEl.classList.toggle('hidden', !isExceeded);
    }

    if (alertMsgEl && isExceeded) {
      alertMsgEl.textContent = 'المبلغ المطلوب أكبر من رصيدك المتاح';
    }

    if (submitBtn) {
      if (isExceeded) {
        submitBtn.disabled = true;
        if (submitBtn.classList) submitBtn.classList.add('is-disabled');
        if (typeof submitBtn.setAttribute === 'function') submitBtn.setAttribute('aria-disabled', 'true');
      } else {
        submitBtn.disabled = false;
        if (submitBtn.classList) submitBtn.classList.remove('is-disabled');
        if (typeof submitBtn.removeAttribute === 'function') submitBtn.removeAttribute('aria-disabled');
      }
    }
  }

  return {
    isExceeded,
    amountIqd: amt,
    balance: currentBal
  };
}

/**
 * Updates quick transfer modal custom input unit and secondary equivalent valuation
 */
function updateQuickTransferInputVal() {
  if (typeof document === 'undefined') return;
  const inputEl = document.getElementById('quick-transfer-amount-input');
  const eqValSpan = document.getElementById('qt-eq-val');
  const unitSpan = document.getElementById('quick-transfer-amount-unit');
  if (!inputEl) return;
  if (unitSpan) {
    unitSpan.textContent = activeCurrency === 'USD' ? '$' : 'د.ع';
  }
  const rawDigits = inputEl.value.replace(/[^\d.]/g, '');
  const num = parseFloat(rawDigits) || 0;
  const currentIqd = (activeCurrency === 'USD')
    ? Math.round(num * iqdPerUsdRate)
    : Math.round(num);

  if (activeCurrency === 'USD') {
    if (eqValSpan) {
      eqValSpan.textContent = `${currentIqd.toLocaleString('en-US')} د.ع`;
    }
  } else {
    const usdEquivalent = (num / iqdPerUsdRate).toFixed(2);
    if (eqValSpan) {
      eqValSpan.textContent = `$${Number(usdEquivalent).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
  }

  if (typeof validateQuickTransferCeiling === 'function') {
    validateQuickTransferCeiling(currentIqd);
  }
}

/**
 * Sets the active currency with smooth animation, persistence, and reactive updates
 * @param {'IQD'|'USD'} curr - Target currency code
 * @param {boolean} animate - Whether to animate balance flip
 */
function setActiveCurrency(curr, animate = true) {
  if (curr !== 'IQD' && curr !== 'USD') return;
  activeCurrency = curr;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('vi_active_currency', curr);
    }
  } catch (_) {}

  renderWalletBalance(animate);
  updateCurrencyTogglePills();
  updateQuickTransferChips();
  updateQuickTransferInputVal();
  if (typeof renderFintechPulse === 'function') {
    renderFintechPulse();
  }

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent('currency-changed', {
        detail: { currency: activeCurrency, rate: iqdPerUsdRate }
      }));
    } catch (_) {}
  }
}

/**
 * Toggles the active currency between IQD and USD
 * @returns {'IQD'|'USD'} The newly activated currency
 */
function toggleActiveCurrency() {
  const next = activeCurrency === 'IQD' ? 'USD' : 'IQD';
  setActiveCurrency(next, true);
  if (typeof playClickSound === 'function') {
    playClickSound();
  }
  return next;
}

/**
 * Fetches the live configurable exchange rate from the backend
 */
async function fetchExchangeRate() {
  if (typeof fetch === 'undefined') return;
  try {
    const res = await fetch('/api/exchange-rate');
    if (!res.ok) return;
    const data = await res.json();
    if (data && typeof data.iqd_per_usd === 'number' && data.iqd_per_usd > 0) {
      iqdPerUsdRate = data.iqd_per_usd;
      exchangeRateConfig = data;
      renderWalletBalance(false);
      updateQuickTransferChips();
      updateQuickTransferInputVal();
      updateFxTickerTelemetry();
    }
  } catch (_) {
    // Graceful fallback to default 1530
  }
}

/**
 * Initializes the Currency Switcher Pills and event listeners
 */
function initCurrencySwitch() {
  if (typeof document === 'undefined') return;

  const headerPill = document.getElementById('currency-toggle-btn');
  const compBtn = document.getElementById('companion-currency-toggle-btn');
  const qtToggle = document.getElementById('quick-transfer-currency-toggle');

  if (headerPill) {
    headerPill.addEventListener('click', (e) => {
      e.preventDefault();
      toggleActiveCurrency();
    });
  }

  if (compBtn) {
    compBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleActiveCurrency();
    });
  }

  if (qtToggle) {
    qtToggle.addEventListener('click', (e) => {
      e.preventDefault();
      toggleActiveCurrency();
      const inputEl = document.getElementById('quick-transfer-amount-input');
      if (inputEl) {
        inputEl.value = (activeCurrency === 'USD')
          ? (currentTransferAmount / iqdPerUsdRate).toFixed(2)
          : Number(currentTransferAmount).toLocaleString('en-US');
      }
    });
  }

  updateCurrencyTogglePills();
  updateQuickTransferChips();
  updateQuickTransferInputVal();
}

/**
 * Dual-Currency FX Telemetry Ticker & Live Micro-Calculator Popover
 * Real-time bidirectional recalculation between USD and IQD with zero rounding artifacts
 */

/**
 * Updates the header ticker pill live text and popover rate badge
 */
function updateFxTickerTelemetry() {
  if (typeof document === 'undefined') return;
  const tickerText = document.getElementById('header-fx-ticker-text');
  const rateBadge = document.getElementById('fx-calc-rate-badge');

  const rate = (typeof iqdPerUsdRate === 'number' && iqdPerUsdRate > 0) ? iqdPerUsdRate : 1530;
  const iqdFor100 = Math.round(100 * rate);

  if (tickerText) {
    tickerText.textContent = `100$ = ${iqdFor100.toLocaleString('en-US')} د.ع ⇄`;
  }
  if (rateBadge) {
    rateBadge.textContent = `1$ = ${rate.toLocaleString('en-US')} د.ع`;
  }
}

/**
 * Recalculates IQD from USD with zero rounding artifacts
 * @param {string|number} usdInputVal
 * @returns {{usd: string, iqd: string, usdNum: number, iqdNum: number}}
 */
function syncFxCalculatorUsdToIqd(usdInputVal) {
  const rate = (typeof iqdPerUsdRate === 'number' && iqdPerUsdRate > 0) ? iqdPerUsdRate : 1530;
  if (usdInputVal === '' || usdInputVal === null || usdInputVal === undefined) {
    return { usd: '', iqd: '', usdNum: 0, iqdNum: 0 };
  }
  const cleanStr = String(usdInputVal).replace(/[^0-9.]/g, '');
  if (!cleanStr) {
    return { usd: '', iqd: '', usdNum: 0, iqdNum: 0 };
  }
  const usdNum = parseFloat(cleanStr);
  if (isNaN(usdNum) || usdNum <= 0) {
    return { usd: cleanStr, iqd: '', usdNum: 0, iqdNum: 0 };
  }

  const iqdNum = Math.round(usdNum * rate);
  return {
    usd: cleanStr,
    iqd: iqdNum.toLocaleString('en-US'),
    usdNum,
    iqdNum
  };
}

/**
 * Recalculates USD from IQD with clean rounding (up to 2 decimal places, no trailing .00)
 * @param {string|number} iqdInputVal
 * @returns {{usd: string, iqd: string, usdNum: number, iqdNum: number}}
 */
function syncFxCalculatorIqdToUsd(iqdInputVal) {
  const rate = (typeof iqdPerUsdRate === 'number' && iqdPerUsdRate > 0) ? iqdPerUsdRate : 1530;
  if (iqdInputVal === '' || iqdInputVal === null || iqdInputVal === undefined) {
    return { usd: '', iqd: '', usdNum: 0, iqdNum: 0 };
  }
  const cleanStr = String(iqdInputVal).replace(/[^0-9]/g, '');
  if (!cleanStr) {
    return { usd: '', iqd: '', usdNum: 0, iqdNum: 0 };
  }
  const iqdNum = parseInt(cleanStr, 10);
  if (isNaN(iqdNum) || iqdNum <= 0) {
    return { usd: '', iqd: cleanStr, usdNum: 0, iqdNum: 0 };
  }

  const usdRaw = iqdNum / rate;
  let formattedUsd = '';
  if (usdRaw % 1 === 0) {
    formattedUsd = usdRaw.toFixed(0);
  } else if (Number.isInteger(Math.round(usdRaw * 100) / 10)) {
    formattedUsd = usdRaw.toFixed(1);
  } else {
    formattedUsd = usdRaw.toFixed(2);
  }

  return {
    usd: formattedUsd,
    iqd: iqdNum.toLocaleString('en-US'),
    usdNum: parseFloat(formattedUsd),
    iqdNum
  };
}

/**
 * Toggles the FX micro-calculator popover
 * @param {boolean|null} forceOpen - Explicit open/close state or toggle if null
 */
function toggleFxCalculatorPopover(forceOpen = null) {
  if (typeof document === 'undefined') return;
  const popover = document.getElementById('fx-calculator-popover');
  const btn = document.getElementById('header-fx-ticker-btn');
  if (!popover || !btn) return;

  const isCurrentlyOpen = !popover.classList.contains('hidden');
  const willOpen = (forceOpen !== null) ? Boolean(forceOpen) : !isCurrentlyOpen;

  if (willOpen) {
    // Close other popovers to avoid collisions
    const ttsPopover = document.getElementById('tts-settings-popover');
    if (ttsPopover) ttsPopover.classList.add('hidden');
    const ttsBtn = document.getElementById('tts-settings-btn');
    if (ttsBtn) ttsBtn.setAttribute('aria-expanded', 'false');

    popover.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    updateFxTickerTelemetry();
  } else {
    popover.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  }
}

/**
 * Handles quick preset amount selection ($50, $100, $500)
 * @param {number} usdAmount
 */
function handleFxPresetClick(usdAmount) {
  if (typeof playClickSound === 'function') {
    playClickSound();
  }
  if (typeof document === 'undefined') return;
  const usdInput = document.getElementById('fx-calc-usd-input');
  const iqdInput = document.getElementById('fx-calc-iqd-input');
  const presetsContainer = document.getElementById('fx-preset-chips');

  const sync = syncFxCalculatorUsdToIqd(usdAmount);
  if (usdInput) usdInput.value = sync.usd;
  if (iqdInput) iqdInput.value = sync.iqd;

  if (presetsContainer) {
    const chips = presetsContainer.querySelectorAll('.fx-preset-chip');
    chips.forEach(chip => {
      const chipUsd = parseFloat(chip.getAttribute('data-usd'));
      chip.classList.toggle('active', chipUsd === usdAmount);
    });
  }
}

/**
 * Handles instant transfer CTA from the FX calculator popover
 * Pre-populates the Quick Transfer modal with the active converted amount
 */
function handleFxTransferAction() {
  if (typeof document === 'undefined') return;
  const iqdInput = document.getElementById('fx-calc-iqd-input');
  const usdInput = document.getElementById('fx-calc-usd-input');

  let targetIqd = 153000;
  if (iqdInput && iqdInput.value) {
    const rawDigits = iqdInput.value.replace(/[^0-9]/g, '');
    const parsed = parseInt(rawDigits, 10);
    if (!isNaN(parsed) && parsed > 0) {
      targetIqd = parsed;
    }
  } else if (usdInput && usdInput.value) {
    const sync = syncFxCalculatorUsdToIqd(usdInput.value);
    if (sync.iqdNum > 0) {
      targetIqd = sync.iqdNum;
    }
  }

  // Dismiss FX Popover
  toggleFxCalculatorPopover(false);

  // Pre-populate and launch Quick Transfer Modal
  if (typeof openQuickTransferModal === 'function') {
    openQuickTransferModal('أحمد كمال', '07701234567', 'حساب التوفير الرئيسي', targetIqd);
  }
}

/**
 * Initializes the FX Ticker & Micro-Calculator popover interactions
 */
function initFxCalculator() {
  if (typeof document === 'undefined') return;

  const tickerBtn = document.getElementById('header-fx-ticker-btn');
  const closeBtn = document.getElementById('fx-calc-close-btn');
  const usdInput = document.getElementById('fx-calc-usd-input');
  const iqdInput = document.getElementById('fx-calc-iqd-input');
  const presetsContainer = document.getElementById('fx-preset-chips');
  const transferBtn = document.getElementById('fx-calc-transfer-btn');
  const popover = document.getElementById('fx-calculator-popover');

  updateFxTickerTelemetry();

  if (tickerBtn) {
    tickerBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFxCalculatorPopover();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleFxCalculatorPopover(false);
    });
  }

  if (usdInput) {
    usdInput.addEventListener('input', () => {
      const sync = syncFxCalculatorUsdToIqd(usdInput.value);
      if (iqdInput) {
        iqdInput.value = sync.iqd;
      }
      if (presetsContainer) {
        const chips = presetsContainer.querySelectorAll('.fx-preset-chip');
        chips.forEach(chip => {
          const chipUsd = parseFloat(chip.getAttribute('data-usd'));
          chip.classList.toggle('active', chipUsd === sync.usdNum);
        });
      }
    });
  }

  if (iqdInput) {
    iqdInput.addEventListener('input', () => {
      const sync = syncFxCalculatorIqdToUsd(iqdInput.value);
      if (usdInput) {
        usdInput.value = sync.usd;
      }
      if (presetsContainer) {
        const chips = presetsContainer.querySelectorAll('.fx-preset-chip');
        chips.forEach(chip => {
          const chipUsd = parseFloat(chip.getAttribute('data-usd'));
          chip.classList.toggle('active', chipUsd === sync.usdNum);
        });
      }
    });
  }

  if (presetsContainer) {
    presetsContainer.addEventListener('click', (e) => {
      const chip = e.target && e.target.closest ? e.target.closest('.fx-preset-chip') : null;
      if (!chip) return;
      const usdVal = parseFloat(chip.getAttribute('data-usd'));
      if (!isNaN(usdVal) && usdVal > 0) {
        handleFxPresetClick(usdVal);
      }
    });
  }

  if (transferBtn) {
    transferBtn.addEventListener('click', (e) => {
      e.preventDefault();
      handleFxTransferAction();
    });
  }

  // Click-outside dismissal
  document.addEventListener('click', (e) => {
    if (!popover || popover.classList.contains('hidden')) return;
    const fxGroup = document.getElementById('header-fx-group');
    if (fxGroup && !fxGroup.contains(e.target)) {
      toggleFxCalculatorPopover(false);
    }
  });

  // Escape key listener
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popover && !popover.classList.contains('hidden')) {
      toggleFxCalculatorPopover(false);
      if (tickerBtn && typeof tickerBtn.focus === 'function') {
        tickerBtn.focus();
      }
    }
  });
}

/**
 * Initializes the Header Balance Privacy Eye Toggle
 */
function initWalletEyeToggle() {
  const eyeBtn = document.getElementById('wallet-eye-btn');
  if (!eyeBtn) return;

  renderWalletBalance();

  eyeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    isBalanceHidden = !isBalanceHidden;
    renderWalletBalance();
  });
}

/**
 * Synchronizes the wallet balance from /api/db into the header pill
 */
async function syncWalletHeader() {
  if (typeof document === 'undefined' || !document.getElementById) return;
  try {
    const res = await fetch('/api/db');
    if (!res.ok) return;
    const db = await res.json();
    if (db && db.user && typeof db.user.balance === 'number') {
      currentWalletBalance = db.user.balance;
    }
    if (db && db.exchange_rate && typeof db.exchange_rate.iqd_per_usd === 'number') {
      iqdPerUsdRate = db.exchange_rate.iqd_per_usd;
      exchangeRateConfig = db.exchange_rate;
      updateFxTickerTelemetry();
    }
    renderWalletBalance();
    updateQuickTransferChips();
    updateQuickTransferInputVal();
  } catch (err) {
    // Graceful fallback to default in HTML
    renderWalletBalance();
  }
}

/**
 * Recent Transactions Drawer System (سجل المعاملات الأخيرة)
 * Slides in from left to right with live stats, filters, and real-time db sync
 */
let cachedTransactions = [];
let currentTransactionFilter = 'all';

function formatArabicDate(dateStr) {
  if (!dateStr) return '';
  const today = new Date().toISOString().split('T')[0];
  if (dateStr === today) return 'اليوم';

  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const months = [
      'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
      'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'
    ];
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    const y = parts[0];
    if (months[m]) return `${d} ${months[m]} ${y}`;
  }
  return dateStr;
}

function formatAmountIQD(amt) {
  const n = Number(amt) || 0;
  return `${n.toLocaleString('en-US')} د.ع`;
}

function openTransactionsDrawer() {
  const drawer = document.getElementById('transactions-drawer');
  const backdrop = document.getElementById('transactions-backdrop');
  const toggleBtn = document.getElementById('transactions-toggle-btn');
  if (drawer) drawer.classList.add('is-open');
  if (backdrop) backdrop.classList.add('is-open');
  if (toggleBtn) toggleBtn.classList.add('is-active');
  fetchAndRenderTransactions();
}

function closeTransactionsDrawer() {
  const drawer = document.getElementById('transactions-drawer');
  const backdrop = document.getElementById('transactions-backdrop');
  const toggleBtn = document.getElementById('transactions-toggle-btn');
  if (drawer) drawer.classList.remove('is-open');
  if (backdrop) backdrop.classList.remove('is-open');
  if (toggleBtn) toggleBtn.classList.remove('is-active');
}

/**
 * Renders sleek pulsating skeleton shimmer placeholders for the transactions drawer
 * @param {number} count - Number of skeleton rows to render
 * @returns {string} The rendered HTML
 */
function renderTransactionsSkeleton(count = 4) {
  let html = '';
  for (let i = 0; i < count; i++) {
    const titleWidth = (i % 2 === 0) ? '68%' : '52%';
    const subWidth = (i % 2 === 0) ? '42%' : '35%';
    html += `
      <div class="skeleton-trx-card" aria-hidden="true">
        <div class="skeleton-trx-lead">
          <div class="skeleton-shimmer skeleton-trx-avatar"></div>
          <div class="skeleton-trx-lines">
            <div class="skeleton-shimmer skeleton-line title" style="width: ${titleWidth}"></div>
            <div class="skeleton-shimmer skeleton-line subtitle" style="width: ${subWidth}"></div>
            <div class="skeleton-shimmer skeleton-line date" style="width: 28%"></div>
          </div>
        </div>
        <div class="skeleton-shimmer skeleton-trx-amount"></div>
      </div>
    `;
  }
  if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
    const listContainer = document.getElementById('drawer-transactions-list');
    if (listContainer) {
      listContainer.innerHTML = html;
    }
  }
  return html;
}

function renderTransactionsList() {
  const listContainer = document.getElementById('drawer-transactions-list');
  if (!listContainer) return;

  const filtered = cachedTransactions.filter((trx) => {
    if (currentTransactionFilter === 'all') return true;
    return trx.type === currentTransactionFilter;
  });

  if (filtered.length === 0) {
    listContainer.innerHTML = `
      <div class="transactions-empty-state">
        <div class="empty-title">لا توجد معاملات مطابقة</div>
        <div class="empty-desc">أي عملية تحويل أموال أو دفع فاتورة تقوم بها ستظهر فورياً هنا.</div>
      </div>
    `;
    return;
  }

  let html = '';
  for (const trx of filtered) {
    const isTransfer = (trx.type === 'TRANSFER');
    const isSuccess = (trx.status === 'SUCCESS' || trx.status === 'paid');

    const title = isTransfer
      ? `تحويل إلى ${escapeHtml(trx.recipient || 'مستلم')}`
      : `دفع فاتورة: ${escapeHtml(trx.biller || 'خدمة')}`;

    const subtitle = isTransfer
      ? `رقم الهاتف: ${escapeHtml(trx.phone || 'غير مسجل')}`
      : `رقم الحساب: ${escapeHtml(trx.account_number || 'غير مسجل')}`;

    const iconSvg = isTransfer
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
           <line x1="7" y1="17" x2="17" y2="7"></line>
           <polyline points="7 7 17 7 17 17"></polyline>
         </svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
           <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
           <polyline points="14 2 14 8 20 8"></polyline>
           <line x1="16" y1="13" x2="8" y2="13"></line>
           <line x1="16" y1="17" x2="8" y2="17"></line>
         </svg>`;

    const iconClass = isTransfer ? 'transfer' : 'bill';
    const dateFormatted = formatArabicDate(trx.date);

    html += `
      <div class="transaction-item-card" data-id="${escapeHtml(trx.id || '')}">
        <div class="trx-details">
          <span class="trx-title">${title}</span>
          <span class="trx-sub">${subtitle}</span>
          <span class="trx-date">${dateFormatted}</span>
        </div>

        <div class="trx-item-left">
          <span class="trx-amount">- ${formatAmountIQD(trx.amount)}</span>
        </div>
      </div>
    `;
  }

  listContainer.innerHTML = html;
}

async function fetchAndRenderTransactions(showSpinner = false) {
  if (typeof document === 'undefined' || !document.getElementById) return;
  const refreshBtn = document.getElementById('refresh-transactions-btn');
  const refreshIcon = refreshBtn ? refreshBtn.querySelector('.refresh-icon') : null;

  if (showSpinner && refreshIcon) {
    refreshIcon.classList.add('spinning');
  }

  // Display sleek pulsating skeleton shimmer placeholders during data hydration
  if (showSpinner || !cachedTransactions || cachedTransactions.length === 0) {
    renderTransactionsSkeleton(4);
  }

  try {
    const res = await fetch('/api/transactions');
    if (!res.ok) return;
    const data = await res.json();

    if (data && typeof document !== 'undefined' && document && typeof document.getElementById === 'function') {
      cachedTransactions = Array.isArray(data.transactions) ? data.transactions : [];

      // Update badge count in header
      const badgeCount = document.getElementById('transactions-badge-count');
      if (badgeCount) {
        badgeCount.textContent = cachedTransactions.length;
      }

      // Update drawer overview balance
      const drawerBalance = document.getElementById('drawer-balance-val');
      if (drawerBalance && typeof data.balance === 'number') {
        drawerBalance.textContent = `${data.balance.toLocaleString('en-US')} د.ع`;
      }

      // Update total transactions count
      const totalCount = document.getElementById('drawer-total-count');
      if (totalCount) {
        totalCount.textContent = `${data.count !== undefined ? data.count : cachedTransactions.length} عملية`;
      }

      // Update total spent
      const totalSpent = data.totalSpent !== undefined
        ? data.totalSpent
        : cachedTransactions.reduce((sum, t) => sum + Number(t.amount || 0), 0);
      const totalSpentEl = document.getElementById('drawer-total-spent');
      if (totalSpentEl) {
        totalSpentEl.textContent = `- ${totalSpent.toLocaleString('en-US')} د.ع`;
      }

      renderTransactionsList();
      if (typeof renderCompanionLedger === 'function') {
        renderCompanionLedger();
      }
      if (typeof renderCompanionContacts === 'function') {
        renderCompanionContacts();
      }
      if (typeof renderFintechPulse === 'function') {
        renderFintechPulse();
      }
    }
  } catch (err) {
    console.warn('Error fetching transactions:', err);
  } finally {
    if (showSpinner && refreshIcon) {
      setTimeout(() => {
        refreshIcon.classList.remove('spinning');
      }, 750);
    }
  }
}

function initTransactionsDrawer() {
  const toggleBtn = document.getElementById('transactions-toggle-btn');
  const drawer = document.getElementById('transactions-drawer');
  const backdrop = document.getElementById('transactions-backdrop');
  const closeBtn = document.getElementById('close-transactions-btn');
  const refreshBtn = document.getElementById('refresh-transactions-btn');
  const filterChips = document.querySelectorAll('.drawer-filter-chip');

  if (toggleBtn) {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (drawer && drawer.classList.contains('is-open')) {
        closeTransactionsDrawer();
      } else {
        openTransactionsDrawer();
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', closeTransactionsDrawer);
  }

  if (backdrop) {
    backdrop.addEventListener('click', closeTransactionsDrawer);
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fetchAndRenderTransactions(true);
      if (typeof fetchCompanionContacts === 'function') fetchCompanionContacts();
      if (typeof fetchCompanionBills === 'function') fetchCompanionBills();
    });
  }

  filterChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      filterChips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      currentTransactionFilter = chip.getAttribute('data-filter') || 'all';
      renderTransactionsList();
    });
  });

  // Close on Escape key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer && drawer.classList.contains('is-open')) {
      closeTransactionsDrawer();
    }
  });

  // Initial fetch for count badge and overview
  fetchAndRenderTransactions();
}

/**
 * Dynamic Halftone Dots Motion Canvas
 * Renders authentic, animated halftone dots strictly in the CORNERS:
 * - Top-Right Corner (wrapping around the header title and upper chat area)
 * - Bottom-Left Corner (wrapping around the send/mic buttons and prompt chips)
 * - Rest of the layout (Center, Top-Left, Bottom-Right) remains completely clean.
 * - In Dark theme: Dots are White (rgba(255, 255, 255))
 * - In Light theme: Dots are Violet (rgba(124, 58, 237))
 * - Dynamic organic traveling waves + mouse interaction
 */
function initHalftoneBackground() {
  // Ensure no outer background canvas exists (removes dots from left and right outer sides)
  const strayCanvas = document.getElementById('halftone-canvas');
  if (strayCanvas) strayCanvas.remove();

  const appCanvas = document.getElementById('app-halftone-canvas');
  const appLayout = document.getElementById('app-layout') || document.querySelector('.app-layout');

  if (!appCanvas || !appLayout) return;

  const appCtx = appCanvas.getContext('2d', { alpha: true });
  if (!appCtx) return;

  let dpr = 1;
  let animationId = null;
  let isRunning = true;

  let globalMouseX = -1000;
  let globalMouseY = -1000;
  let targetMouseX = -1000;
  let targetMouseY = -1000;

  function resizeAll() {
    dpr = window.devicePixelRatio || 1;
    const w = appLayout ? appLayout.clientWidth : window.innerWidth;
    const h = appLayout ? appLayout.clientHeight : window.innerHeight;
    if (!w || !h) return;

    appCanvas.width = Math.floor(w * dpr);
    appCanvas.height = Math.floor(h * dpr);
    appCanvas.style.width = w + 'px';
    appCanvas.style.height = h + 'px';
  }

  resizeAll();
  window.addEventListener('resize', resizeAll, { passive: true });

  window.addEventListener('mousemove', (e) => {
    targetMouseX = e.clientX;
    targetMouseY = e.clientY;
  }, { passive: true });

  window.addEventListener('mouseleave', () => {
    targetMouseX = -1000;
    targetMouseY = -1000;
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      isRunning = false;
      if (animationId) cancelAnimationFrame(animationId);
    } else {
      isRunning = true;
      animationId = requestAnimationFrame(render);
    }
  });

  /**
   * Helper to generate vertical linear gradient across the bottom Gemini zone
   */
  function createHalftoneGradient(ctx, height, isDark, alpha, controlsH) {
    const startY = Math.max(0, height - (controlsH + 130));
    const g = ctx.createLinearGradient(0, startY, 0, height);
    if (isDark) {
      // Dark Theme: Gradient from user's image (Top Lime-Green -> Emerald -> Bottom Teal)
      g.addColorStop(0, `rgba(138, 204, 68, ${alpha * 0.85})`);
      g.addColorStop(0.35, `rgba(117, 197, 76, ${alpha * 0.95})`);
      g.addColorStop(0.70, `rgba(61, 164, 108, ${alpha})`);
      g.addColorStop(1, `rgba(18, 147, 129, ${alpha})`);
    } else {
      // Light Theme: Lavender to Royal Violet
      g.addColorStop(0, `rgba(167, 139, 250, ${alpha * 0.85})`);
      g.addColorStop(0.5, `rgba(139, 92, 246, ${alpha * 0.95})`);
      g.addColorStop(1, `rgba(124, 58, 237, ${alpha})`);
    }
    return g;
  }

  /**
   * Renders the Gemini Assistant bottom halftone dots strictly at the bottom:
   * - Top and sides are 100% clean (no dots).
   * - Gentle U-curve along bottom rim matching Pic 1.
   * - Dynamically calculates reach based on floating controls so zoom (Ctrl +/-) NEVER squishes or breaks it.
   */
  function renderBottomHalftone(canvas, ctx, isDark, elapsed, mouseX, mouseY) {
    const width = appLayout ? appLayout.clientWidth : canvas.clientWidth;
    const height = appLayout ? appLayout.clientHeight : canvas.clientHeight;
    if (!width || !height) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);

    // Dynamic measurement of bottom controls height
    const inputArea = document.querySelector('.chat-input-area');
    const promptsBar = document.querySelector('.quick-prompts-bar');
    const inputH = inputArea ? inputArea.offsetHeight : 68;
    const isHeroMode = appLayout && appLayout.classList.contains('hero-mode');
    const promptsH = (isHeroMode && promptsBar && promptsBar.offsetHeight > 0) ? promptsBar.offsetHeight : 0;
    const controlsH = inputH + promptsH;

    // Airy spacing for elegant, non-dense halftone pattern
    const SPACING = 21;
    const cols = Math.ceil(width / SPACING) + 1;
    const rows = Math.ceil(height / SPACING) + 1;

    // 3 subtle alpha buckets for soft ambient shadow aesthetic
    const b1 = new Path2D(); // Soft outer feather
    const b2 = new Path2D(); // Gentle mid body
    const b3 = new Path2D(); // Soft bottom rim core

    // Hard cutoff limit well above the highest curve peak
    const maxAllowedDy = controlsH + 160;

    for (let r = 0; r < rows; r++) {
      const offsetX = (r % 2 === 1) ? SPACING * 0.5 : 0;
      const y = r * SPACING;
      const dyBot = height - y;

      if (dyBot > maxAllowedDy) continue;

      for (let c = 0; c < cols; c++) {
        const x = c * SPACING + offsetX;

        // Normalized horizontal distance from center: 0 at center, 1 at side edges
        const normX = Math.abs(x - width / 2) / (width / 2);
        const reachCurve = Math.pow(normX, 1.45);

        // Gemini bottom arch: reaches ~42px above prompt chips in center, and curves up ~135px higher at sides
        const botReach = controlsH + 42 + 95 * reachCurve;
        if (dyBot > botReach * 1.15) continue;

        const normY = dyBot / botReach;

        // Subtle organic ambient wave
        const wave = 0.10 * Math.sin(x * 0.015 - elapsed * 0.55) + 0.06 * Math.cos(x * 0.026 + elapsed * 0.38);
        const eff = normY - wave;
        if (eff >= 1.0) continue;

        const base = Math.max(0, 1.0 - eff);
        const ripple = 0.18 * Math.sin(dyBot * 0.038 - elapsed * 1.05);
        let tone = base + ripple * base;

        // Mouse hover reaction if near active bottom dots
        if (mouseX > -500 && tone > 0.02) {
          const dMouse = Math.hypot(x - mouseX, y - mouseY);
          if (dMouse < 115) {
            tone += (1 - dMouse / 115) * 0.24;
          }
        }

        if (tone <= 0.03) continue;
        if (tone > 1) tone = 1;

        // Gentle power curve: prevents dots from ever looking chunky
        const shaped = Math.pow(tone, 1.35);

        // Subtle dot radius: delicate 0.65px to 2.85px max
        const radius = 0.65 + shaped * 2.2;

        // Categorize into alpha buckets
        if (shaped < 0.28) {
          b1.moveTo(x + radius, y);
          b1.arc(x, y, radius, 0, Math.PI * 2);
        } else if (shaped < 0.62) {
          b2.moveTo(x + radius, y);
          b2.arc(x, y, radius, 0, Math.PI * 2);
        } else {
          b3.moveTo(x + radius, y);
          b3.arc(x, y, radius, 0, Math.PI * 2);
        }
      }
    }

    // Apply linear gradient fills with delicate, soft alpha levels (shadow/aura concept)
    ctx.fillStyle = createHalftoneGradient(ctx, height, isDark, 0.10, controlsH);
    ctx.fill(b1);
    ctx.fillStyle = createHalftoneGradient(ctx, height, isDark, 0.26, controlsH);
    ctx.fill(b2);
    ctx.fillStyle = createHalftoneGradient(ctx, height, isDark, 0.52, controlsH);
    ctx.fill(b3);
  }

  function render(now) {
    if (!isRunning) return;

    // Detect zoom (Ctrl + / Ctrl -) or layout shifts dynamically on every frame
    const currentDpr = window.devicePixelRatio || 1;
    const currentW = appLayout ? appLayout.clientWidth : 0;
    const currentH = appLayout ? appLayout.clientHeight : 0;

    if (Math.abs(currentDpr - dpr) > 0.01 ||
      appCanvas.width !== Math.floor(currentW * currentDpr) ||
      appCanvas.height !== Math.floor(currentH * currentDpr)) {
      resizeAll();
    }

    globalMouseX += (targetMouseX - globalMouseX) * 0.08;
    globalMouseY += (targetMouseY - globalMouseY) * 0.08;

    const elapsed = now * 0.001;
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const isDark = (currentTheme === 'dark');

    // Render Gemini bottom halftone exclusively on app canvas
    if (appCanvas && appCtx && appLayout) {
      const appRect = appLayout.getBoundingClientRect();
      const appMouseX = globalMouseX - appRect.left;
      const appMouseY = globalMouseY - appRect.top;
      renderBottomHalftone(appCanvas, appCtx, isDark, elapsed, appMouseX, appMouseY);
    }

    animationId = requestAnimationFrame(render);
  }

  animationId = requestAnimationFrame(render);
}

// ==========================================================================
// Text-To-Speech (TTS) Voice Engine (Native Browser + ElevenLabs / Google Neural Hybrid)
// ==========================================================================
let isTtsEnabled = true;
try {
  if (typeof window !== 'undefined' && window.localStorage) {
    const saved = window.localStorage.getItem('vi_tts_enabled');
    if (saved !== null) {
      isTtsEnabled = saved === 'true';
    }
  }
} catch (e) {
  console.warn('[TTS] Storage access warning:', e);
}

// User-configurable speech speed: 0.85x (بطيء), 1.05x (نص ونص / طبيعي), 1.3x (سريع)
let currentTtsSpeed = 1.05;
try {
  if (typeof window !== 'undefined' && window.localStorage) {
    const savedSpeed = window.localStorage.getItem('vi_tts_speed');
    if (savedSpeed) {
      const parsed = parseFloat(savedSpeed);
      if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 2.5) {
        currentTtsSpeed = parsed;
      }
    }
  }
} catch (e) {}

// User-configurable voice preference: 'cloud-google' (default high-fidelity) or local browser voice name
let selectedVoiceId = 'cloud-google';
try {
  if (typeof window !== 'undefined' && window.localStorage) {
    const savedVoice = window.localStorage.getItem('vi_tts_voice');
    if (savedVoice) {
      selectedVoiceId = savedVoice;
    }
  }
} catch (e) {}

let currentTtsAudio = null;
let activeTtsBtn = null;
let cachedSpeechVoices = [];
let activeTtsSessionId = 0;
let ttsAbortController = null;
let activeStreamingSession = null;

function loadTtsVoices() {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      cachedSpeechVoices = window.speechSynthesis.getVoices() || [];
    } catch (e) {
      cachedSpeechVoices = [];
    }
    populateVoiceSelectDropdown();
  }
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  loadTtsVoices();
  if (window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = loadTtsVoices;
  }
}

/**
 * Discovers the most authentic Arabic voice available in the browser.
 * Prioritizes Iraqi Arabic (ar-IQ), then regional/natural voices.
 */
function getBestArabicVoice(preferredVoiceName = null) {
  if (!cachedSpeechVoices || cachedSpeechVoices.length === 0) {
    loadTtsVoices();
  }
  if (!cachedSpeechVoices || cachedSpeechVoices.length === 0) return null;

  // 1. Direct name match if requested by user
  if (preferredVoiceName && preferredVoiceName !== 'cloud-google') {
    const matched = cachedSpeechVoices.find(v => v.name === preferredVoiceName);
    if (matched) return matched;
  }

  // 2. Exact Iraqi match
  let voice = cachedSpeechVoices.find(v => v.lang === 'ar-IQ' || v.lang === 'ar_IQ');
  if (voice) return voice;

  // 3. High-quality natural Arabic voices (Salma, Google, Microsoft Natural, Laila, Maged, Tarik, Shakir)
  const premiumKeywords = ['salma', 'natural', 'google', 'shakir', 'maged', 'tarik', 'laila', 'arabic'];
  voice = cachedSpeechVoices.find(v => {
    const lang = (v.lang || '').toLowerCase();
    const name = (v.name || '').toLowerCase();
    return lang.startsWith('ar') && premiumKeywords.some(kw => name.includes(kw));
  });
  if (voice) return voice;

  // 4. Any available Arabic voice
  voice = cachedSpeechVoices.find(v => (v.lang || '').toLowerCase().startsWith('ar'));
  return voice || null;
}

/**
 * Helper to clean and format raw system voice names into readable Arabic titles and descriptions
 */
function formatVoiceDisplay(voiceId, voiceObj = null) {
  if (voiceId === 'cloud-google' || !voiceObj) {
    return {
      title: 'صوت فاي الذكي (Google Neural)',
      desc: 'سحابي فائق • ذكاء اصطناعي وعراقي فصيح'
    };
  }
  const name = voiceObj.name || voiceId;
  const lang = voiceObj.lang || 'ar';

  let cleanTitle = name;
  if (/salma|سلمى/i.test(name)) cleanTitle = 'سلمى (Microsoft Natural)';
  else if (/shakir|شاكر/i.test(name)) cleanTitle = 'شاكر (Microsoft Natural)';
  else if (/maryam|مريم/i.test(name)) cleanTitle = 'مريم (Microsoft Natural)';
  else if (/hamed|حامد/i.test(name)) cleanTitle = 'حامد (Microsoft Natural)';
  else if (/fatima|فاطمة/i.test(name)) cleanTitle = 'فاطمة (Microsoft Natural)';
  else if (/zariyah|زرية/i.test(name)) cleanTitle = 'زرية (Microsoft Natural)';
  else if (/maged|ماجد/i.test(name)) cleanTitle = 'ماجد (Microsoft Natural)';
  else if (/tarik|طارق/i.test(name)) cleanTitle = 'طارق (Microsoft Natural)';
  else if (/laila|ليلى/i.test(name)) cleanTitle = 'ليلى (Microsoft Natural)';
  else if (/google/i.test(name)) cleanTitle = `جوجل (${name})`;
  else {
    cleanTitle = name.replace(/Microsoft/gi, '').replace(/Online \(Natural\)/gi, '').trim() || name;
  }

  const cleanDesc = `صوت محلي • ${lang}`;
  return { title: cleanTitle, desc: cleanDesc };
}

/**
 * Dynamically populates both the hidden native voice selector and the
 * luxury liquid glassy custom bubble dropdown (matching Image 2).
 */
function populateVoiceSelectDropdown() {
  if (typeof document === 'undefined') return;
  const voiceSelect = document.getElementById('tts-voice-select');
  const optionsList = document.getElementById('tts-voice-options-list');
  const triggerTitle = document.getElementById('tts-voice-bubble-title');
  const triggerDesc = document.getElementById('tts-voice-bubble-desc');

  // 1. Compile available voices
  const voiceEntries = [
    {
      id: 'cloud-google',
      title: 'صوت فاي الذكي (Google Neural)',
      desc: 'سحابي فائق • ذكاء اصطناعي وعراقي فصيح',
      voiceObj: null
    }
  ];

  const arabicVoices = (cachedSpeechVoices || []).filter(v => {
    const lang = (v.lang || '').toLowerCase();
    const name = (v.name || '').toLowerCase();
    return lang.startsWith('ar') || name.includes('arabic') || name.includes('عربي') || name.includes('salma') || name.includes('shakir') || name.includes('maryam');
  });

  arabicVoices.forEach(v => {
    const display = formatVoiceDisplay(v.name, v);
    voiceEntries.push({
      id: v.name,
      title: display.title,
      desc: display.desc,
      voiceObj: v
    });
  });

  // Keep selection valid
  const activeExists = voiceEntries.some(e => e.id === selectedVoiceId);
  if (!activeExists) {
    selectedVoiceId = 'cloud-google';
  }

  // 2. Sync Hidden Native Select for test/fallback parity
  if (voiceSelect) {
    voiceSelect.innerHTML = '';
    voiceEntries.forEach(entry => {
      const opt = document.createElement('option');
      opt.value = entry.id;
      opt.textContent = `${entry.title} - ${entry.desc}`;
      voiceSelect.appendChild(opt);
    });
    voiceSelect.value = selectedVoiceId;
  }

  // 3. Update Custom Trigger Bubble
  const currentEntry = voiceEntries.find(e => e.id === selectedVoiceId) || voiceEntries[0];
  if (triggerTitle) triggerTitle.textContent = currentEntry.title;
  if (triggerDesc) triggerDesc.textContent = currentEntry.desc;

  // 4. Render Glassy Voice Cards List (Matching Image 2 Model Selector)
  if (optionsList) {
    optionsList.innerHTML = '';
    voiceEntries.forEach(entry => {
      const isSelected = entry.id === selectedVoiceId;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tts-voice-card-item' + (isSelected ? ' active' : '');
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('data-voice-id', entry.id);

      btn.innerHTML = `
        <div class="tts-voice-card-check" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>
        <div class="tts-voice-card-text">
          <div class="tts-voice-card-title">${escapeHtml(entry.title)}</div>
          <div class="tts-voice-card-desc">${escapeHtml(entry.desc)}</div>
        </div>
      `;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedVoiceId = entry.id;
        try {
          if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.setItem('vi_tts_voice', selectedVoiceId);
          }
        } catch (err) {}

        if (voiceSelect) {
          voiceSelect.value = selectedVoiceId;
        }
        if (triggerTitle) triggerTitle.textContent = entry.title;
        if (triggerDesc) triggerDesc.textContent = entry.desc;

        const allItems = optionsList.querySelectorAll('.tts-voice-card-item');
        allItems.forEach(i => i.classList.remove('active'));
        btn.classList.add('active');

        // Close secondary voice menu bubble
        const voiceMenu = document.getElementById('tts-voice-options-menu');
        const voiceWrapper = document.getElementById('tts-voice-bubble-wrapper');
        const voiceTrigger = document.getElementById('tts-voice-bubble-trigger');
        if (voiceMenu) voiceMenu.classList.add('hidden');
        if (voiceWrapper) voiceWrapper.classList.remove('open');
        if (voiceTrigger) voiceTrigger.setAttribute('aria-expanded', 'false');
      });

      optionsList.appendChild(btn);
    });
  }
}

/**
 * Sanitizes AI response text for clear, natural, and glitch-free audio pronunciation
 * Strips internal action tags, markdown markers, and expands currency symbols.
 * @param {string} text - Raw model response
 * @returns {string} Clean readable Arabic text
 */
function cleanTextForSpeech(text) {
  if (typeof text !== 'string') return '';
  return text
    // Remove internal database action tags completely
    .replace(/<<<DB_ACTION>>>[\s\S]*?<<<END_DB_ACTION>>>/g, '')
    // Remove markdown symbols (bold, italic, code, headers)
    .replace(/[`*_~#]/g, '')
    // Replace currency symbols and abbreviations with natural Arabic words
    .replace(/\bIQD\b/gi, 'دينار عراقي')
    .replace(/د\.ع/g, 'دينار عراقي')
    // Clean bullet points and list dashes into short natural pauses
    .replace(/^\s*[-•]\s*/gm, '، ')
    .replace(/\n+/g, '، ')
    // Strip emojis and non-standard symbols that cause synthesizer glitches
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    // Normalize spacing
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Instantly finishes any in-progress typewriter text stream and reveals full content
 */
function finishActiveStream() {
  if (activeStreamingSession && typeof activeStreamingSession.skip === 'function') {
    activeStreamingSession.skip();
  }
}

let ttsAudioContext = null;
let ttsVisualizerRafId = null;
let activeTtsSourceNode = null;
let activeTtsAnalyserNode = null;
let activeSpeakingAvatarEl = null;

/**
 * Lazily retrieves or instantiates the singleton AudioContext for TTS playback
 * @returns {AudioContext|null}
 */
function getTtsAudioContext() {
  if (typeof window === 'undefined') return null;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;

  if (!ttsAudioContext || ttsAudioContext.state === 'closed') {
    try {
      ttsAudioContext = new AudioCtx();
    } catch (e) {
      return null;
    }
  }

  if (ttsAudioContext.state === 'suspended') {
    ttsAudioContext.resume().catch(() => {});
  }

  return ttsAudioContext;
}

/**
 * Computes normalized RMS amplitude (0.0 to 1.0) from time-domain byte audio data
 * @param {Uint8Array} dataArray - Byte data from AnalyserNode (0-255 centered at 128)
 * @returns {number} Normalized amplitude value between 0.0 and 1.0
 */
function computeAudioRmsIntensity(dataArray) {
  if (!dataArray || dataArray.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const norm = (dataArray[i] - 128) / 128;
    sumSquares += norm * norm;
  }
  const rms = Math.sqrt(sumSquares / dataArray.length);
  return Math.min(1.0, Math.max(0.0, rms * 3.2));
}

/**
 * Resets speech intensity CSS custom property and removes speaking states
 */
function resetSpeechIntensity() {
  if (typeof document !== 'undefined' && document.documentElement) {
    if (document.documentElement.style && typeof document.documentElement.style.setProperty === 'function') {
      document.documentElement.style.setProperty('--speech-intensity', '0');
    }
    if (document.documentElement.classList && typeof document.documentElement.classList.remove === 'function') {
      document.documentElement.classList.remove('is-speaking-tts');
    }
  }

  if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
    const speakingElements = document.querySelectorAll('.is-speaking-avatar');
    if (speakingElements && typeof speakingElements.forEach === 'function') {
      speakingElements.forEach(el => {
        if (el && el.style && typeof el.style.removeProperty === 'function') {
          el.style.removeProperty('--speech-intensity');
        }
        if (el && el.classList && typeof el.classList.remove === 'function') {
          el.classList.remove('is-speaking-avatar');
        }
      });
    }
  }

  activeSpeakingAvatarEl = null;
}

/**
 * Disconnects audio nodes, cancels visualizer animation loop and resets styles
 */
function stopTtsAudioVisualizer() {
  if (ttsVisualizerRafId) {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(ttsVisualizerRafId);
    }
    ttsVisualizerRafId = null;
  }

  if (activeTtsSourceNode) {
    try {
      activeTtsSourceNode.disconnect();
    } catch (e) {}
    activeTtsSourceNode = null;
  }

  if (activeTtsAnalyserNode) {
    try {
      activeTtsAnalyserNode.disconnect();
    } catch (e) {}
    activeTtsAnalyserNode = null;
  }

  resetSpeechIntensity();
}

/**
 * Plays TTS audio with real-time biometric ambient glow & waveform synchronization
 * Connects HTMLAudioElement to Web Audio API AnalyserNode (fftSize: 64)
 * @param {HTMLAudioElement|string} audioOrUrl - Audio element or URL to play
 * @param {Function} [onEnd] - Callback when audio ends
 * @param {Function} [onError] - Callback on error
 * @param {HTMLElement|null} [btnElement] - Optional trigger button to locate target avatar
 * @returns {Promise<HTMLAudioElement>}
 */
async function playTtsAudio(audioOrUrl, onEnd = null, onError = null, btnElement = null) {
  stopTtsAudioVisualizer();

  const audio = (typeof audioOrUrl === 'string') ? new Audio(audioOrUrl) : audioOrUrl;
  currentTtsAudio = audio;

  if (typeof currentTtsSpeed === 'number') {
    audio.playbackRate = currentTtsSpeed;
  }
  if (audio.preservesPitch !== undefined) {
    audio.preservesPitch = true;
  }

  // Locate the active bot message avatar associated with this speech
  if (typeof document !== 'undefined') {
    if (btnElement && typeof btnElement.closest === 'function') {
      const msg = btnElement.closest('.message.ai-message');
      if (msg && typeof msg.querySelector === 'function') {
        activeSpeakingAvatarEl = msg.querySelector('.msg-avatar');
        if (activeSpeakingAvatarEl && activeSpeakingAvatarEl.classList && typeof activeSpeakingAvatarEl.classList.add === 'function') {
          activeSpeakingAvatarEl.classList.add('is-speaking-avatar');
        }
      }
    }

    if (!activeSpeakingAvatarEl && typeof document.querySelectorAll === 'function') {
      const allAvatars = document.querySelectorAll('.message.ai-message .msg-avatar');
      if (allAvatars && allAvatars.length > 0) {
        activeSpeakingAvatarEl = allAvatars[allAvatars.length - 1];
        if (activeSpeakingAvatarEl && activeSpeakingAvatarEl.classList && typeof activeSpeakingAvatarEl.classList.add === 'function') {
          activeSpeakingAvatarEl.classList.add('is-speaking-avatar');
        }
      }
    }
  }

  // Connect HTMLAudioElement source to Web Audio API AnalyserNode (fftSize: 64)
  const audioCtx = getTtsAudioContext();
  let analyser = null;

  if (audioCtx) {
    try {
      const source = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;

      source.connect(analyser);
      analyser.connect(audioCtx.destination);

      activeTtsSourceNode = source;
      activeTtsAnalyserNode = analyser;
    } catch (err) {
      console.warn('[WebAudio] AnalyserNode connection:', err);
    }
  }

  // Active requestAnimationFrame loop: compute normalized RMS speech amplitude (0.0 to 1.0)
  if (analyser && typeof requestAnimationFrame === 'function') {
    const bufferLength = analyser.fftSize;
    const timeDomainData = new Uint8Array(bufferLength);

    if (typeof document !== 'undefined' && document.documentElement && document.documentElement.classList && typeof document.documentElement.classList.add === 'function') {
      document.documentElement.classList.add('is-speaking-tts');
    }

    function renderSpeechGlow() {
      if (!currentTtsAudio || currentTtsAudio.paused || currentTtsAudio.ended) {
        stopTtsAudioVisualizer();
        return;
      }

      analyser.getByteTimeDomainData(timeDomainData);
      const intensity = computeAudioRmsIntensity(timeDomainData);
      const formattedIntensity = intensity.toFixed(3);

      if (typeof document !== 'undefined' && document.documentElement && document.documentElement.style && typeof document.documentElement.style.setProperty === 'function') {
        document.documentElement.style.setProperty('--speech-intensity', formattedIntensity);
      }

      if (activeSpeakingAvatarEl && activeSpeakingAvatarEl.style && typeof activeSpeakingAvatarEl.style.setProperty === 'function') {
        activeSpeakingAvatarEl.style.setProperty('--speech-intensity', formattedIntensity);
      }

      ttsVisualizerRafId = requestAnimationFrame(renderSpeechGlow);
    }

    ttsVisualizerRafId = requestAnimationFrame(renderSpeechGlow);
  }

  audio.onended = () => {
    stopTtsAudioVisualizer();
    if (typeof onEnd === 'function') onEnd();
  };

  audio.onerror = (e) => {
    stopTtsAudioVisualizer();
    if (typeof onError === 'function') onError(e);
  };

  audio.onpause = () => {
    if (audio.ended || audio.currentTime === 0) {
      stopTtsAudioVisualizer();
    }
  };

  try {
    await audio.play();
  } catch (err) {
    stopTtsAudioVisualizer();
    if (typeof onError === 'function') onError(err);
  }

  return audio;
}

/**
 * Stops any active speech synthesis or audio playback immediately
 * and aborts any pending in-flight /api/tts network requests
 */
function stopSpeaking() {
  activeTtsSessionId++;
  if (ttsAbortController) {
    try {
      ttsAbortController.abort();
    } catch (e) {}
    ttsAbortController = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch (e) {}
  }
  if (currentTtsAudio) {
    try {
      currentTtsAudio.pause();
      currentTtsAudio.currentTime = 0;
    } catch (e) {}
    currentTtsAudio = null;
  }
  if (activeTtsBtn) {
    activeTtsBtn.classList.remove('speaking');
    activeTtsBtn = null;
  }
  const toggleBtn = (typeof document !== 'undefined' && typeof document.getElementById === 'function')
    ? document.getElementById('tts-toggle-btn')
    : null;
  if (toggleBtn) {
    toggleBtn.classList.remove('is-speaking');
  }

  // Teardown Web Audio visualizer nodes and reset speech intensity property
  stopTtsAudioVisualizer();
}

/**
 * Speaks text using user-chosen voice and speed setting.
 * Supports Google Neural Cloud stream and local browser voices.
 * Includes prefetch promise support and strict session abort guards.
 * @param {string} text - Message text
 * @param {HTMLElement|null} btnElement - Optional replay button element to animate
 * @param {Promise<string|null>|null} prefetchPromise - Optional in-flight audio URL promise
 */
async function speakText(text, btnElement = null, prefetchPromise = null) {
  if (typeof window === 'undefined') return;
  if (typeof text !== 'string' || !text.trim()) return;
  const clean = cleanTextForSpeech(text);
  if (!clean) return;

  stopSpeaking();
  const thisSessionId = ++activeTtsSessionId;
  ttsAbortController = new AbortController();

  if (btnElement) {
    activeTtsBtn = btnElement;
    btnElement.classList.add('speaking');
  }
  const toggleBtn = (typeof document !== 'undefined' && typeof document.getElementById === 'function')
    ? document.getElementById('tts-toggle-btn')
    : null;
  if (toggleBtn) {
    toggleBtn.classList.add('is-speaking');
  }

  // If user selected a specific browser offline voice, route directly to browser synthesizer
  if (selectedVoiceId && selectedVoiceId !== 'cloud-google') {
    fallbackBrowserSpeak(clean, btnElement, selectedVoiceId, thisSessionId);
    return;
  }

  // 1. High-fidelity cloud neural endpoint (/api/tts)
  if (typeof Audio !== 'undefined') {
    try {
      let audioUrl = null;

      if (prefetchPromise) {
        audioUrl = await prefetchPromise;
      }

      if (thisSessionId !== activeTtsSessionId) {
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        return;
      }

      if (!audioUrl) {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clean }),
          signal: ttsAbortController.signal
        });

        if (thisSessionId !== activeTtsSessionId) return;

        if (res.ok && res.headers.get('content-type')?.includes('audio')) {
          const audioBlob = await res.blob();
          if (thisSessionId !== activeTtsSessionId) return;
          audioUrl = URL.createObjectURL(audioBlob);
        }
      }

      if (thisSessionId !== activeTtsSessionId) {
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        return;
      }

      if (audioUrl) {
        const audio = new Audio(audioUrl);
        await playTtsAudio(audio, () => {
          URL.revokeObjectURL(audioUrl);
          if (currentTtsAudio === audio) {
            stopSpeaking();
          }
        }, () => {
          URL.revokeObjectURL(audioUrl);
          if (thisSessionId === activeTtsSessionId) {
            fallbackBrowserSpeak(clean, btnElement, null, thisSessionId);
          }
        }, btnElement);
        return;
      }
    } catch (err) {
      if (err.name === 'AbortError' || thisSessionId !== activeTtsSessionId) {
        return;
      }
      // Backend /api/tts network or service fallback
    }
  }

  // 2. Zero-Config Browser Fallback
  if (thisSessionId === activeTtsSessionId) {
    fallbackBrowserSpeak(clean, btnElement, null, thisSessionId);
  }
}

/**
 * Native offline browser speech synthesizer fallback
 * @param {string} cleanText - Sanitized text
 * @param {HTMLElement|null} btnElement - Button element to animate
 * @param {string|null} targetVoiceName - Specific voice name if chosen
 * @param {number|null} sessionId - Track session validity
 */
function fallbackBrowserSpeak(cleanText, btnElement = null, targetVoiceName = null, sessionId = null) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    stopSpeaking();
    return;
  }
  if (sessionId !== null && sessionId !== activeTtsSessionId) {
    return;
  }

  try {
    const utterance = new SpeechSynthesisUtterance(cleanText);
    const arabicVoice = getBestArabicVoice(targetVoiceName);
    if (arabicVoice) {
      utterance.voice = arabicVoice;
      utterance.lang = arabicVoice.lang;
    } else {
      console.warn('[TTS] No native Arabic voice installed on this system; skipping synthesis to prevent English accent distortion.');
      stopSpeaking();
      return;
    }

    utterance.rate = currentTtsSpeed;
    utterance.pitch = 1.0;

    utterance.onend = () => {
      stopSpeaking();
    };
    utterance.onerror = () => {
      stopSpeaking();
    };

    window.speechSynthesis.speak(utterance);
  } catch (e) {
    console.warn('[TTS] Synthesis playback error:', e);
    stopSpeaking();
  }
}

/**
 * Creates an interactive replay speech button for AI response cards
 * @param {string} text - Message text
 * @returns {HTMLButtonElement}
 */
function createSpeakButton(text) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.classList.add('feedback-btn', 'message-speak-btn');
  btn.setAttribute('aria-label', 'استمع للرد');
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
    </svg>
  `;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.classList.contains('speaking')) {
      stopSpeaking();
    } else {
      speakText(text, btn);
    }
  });

  return btn;
}

/**
 * Initializes the header TTS toggle, voice selector, speed chips, and popover controls
 */
function initTtsEngine() {
  const ttsToggleBtn = document.getElementById('tts-toggle-btn');
  const ttsSettingsBtn = document.getElementById('tts-settings-btn');
  const ttsPopover = document.getElementById('tts-settings-popover');
  const ttsPopoverClose = document.getElementById('tts-popover-close');
  const speedChips = document.querySelectorAll('#tts-speed-chips .speed-chip');
  const voiceSelect = document.getElementById('tts-voice-select');
  const testPreviewBtn = document.getElementById('tts-test-preview-btn');
  const ttsHeaderGroup = document.getElementById('tts-header-group');

  if (!ttsToggleBtn) return;

  function updateTtsUi() {
    if (isTtsEnabled) {
      ttsToggleBtn.classList.add('active');
      ttsToggleBtn.classList.remove('muted');
      ttsToggleBtn.setAttribute('aria-label', 'النطق الصوتي التلقائي مفعل - اضغط للكتم');
    } else {
      ttsToggleBtn.classList.remove('active');
      ttsToggleBtn.classList.add('muted');
      ttsToggleBtn.setAttribute('aria-label', 'النطق الصوتي التلقائي مكتوم - اضغط للتفعيل');
    }
  }

  updateTtsUi();

  // 1. Master Audio Output Mute / Unmute Toggle
  ttsToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isTtsEnabled = !isTtsEnabled;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem('vi_tts_enabled', isTtsEnabled ? 'true' : 'false');
      }
    } catch (err) {}

    if (!isTtsEnabled) {
      stopSpeaking();
    }
    updateTtsUi();
  });

  // 2. Settings Popover Toggle & Outside Click Dismiss
  if (ttsSettingsBtn && ttsPopover) {
    ttsSettingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      ttsPopover.classList.toggle('hidden');
    });

    if (ttsPopoverClose) {
      ttsPopoverClose.addEventListener('click', (e) => {
        e.stopPropagation();
        ttsPopover.classList.add('hidden');
      });
    }

    document.addEventListener('click', (e) => {
      if (ttsHeaderGroup && !ttsHeaderGroup.contains(e.target)) {
        ttsPopover.classList.add('hidden');
      }
    });

    ttsPopover.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  // 3. Speech Rate (Speed Chips: بطيء 0.85x / نص ونص 1.05x / سريع 1.3x)
  if (speedChips && speedChips.length > 0) {
    speedChips.forEach(chip => {
      const chipSpeed = parseFloat(chip.dataset.speed || '1.0');
      if (Math.abs(chipSpeed - currentTtsSpeed) < 0.08) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }

      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        speedChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const newSpeed = parseFloat(chip.dataset.speed || '1.05');
        currentTtsSpeed = newSpeed;
        try {
          if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.setItem('vi_tts_speed', newSpeed.toString());
          }
        } catch (err) {}

        if (currentTtsAudio) {
          currentTtsAudio.playbackRate = currentTtsSpeed;
        }
      });
    });
  }

  // 4. Voice Bubble Trigger & Secondary Floating Glass Menu Toggle
  populateVoiceSelectDropdown();

  const voiceTrigger = document.getElementById('tts-voice-bubble-trigger');
  const voiceMenu = document.getElementById('tts-voice-options-menu');
  const voiceWrapper = document.getElementById('tts-voice-bubble-wrapper');

  if (voiceTrigger && voiceMenu) {
    voiceTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !voiceMenu.classList.contains('hidden');
      if (isOpen) {
        voiceMenu.classList.add('hidden');
        if (voiceWrapper) voiceWrapper.classList.remove('open');
        voiceTrigger.setAttribute('aria-expanded', 'false');
      } else {
        voiceMenu.classList.remove('hidden');
        if (voiceWrapper) voiceWrapper.classList.add('open');
        voiceTrigger.setAttribute('aria-expanded', 'true');
      }
    });

    if (ttsPopover) {
      ttsPopover.addEventListener('click', (e) => {
        if (voiceWrapper && !voiceWrapper.contains(e.target)) {
          voiceMenu.classList.add('hidden');
          voiceWrapper.classList.remove('open');
          voiceTrigger.setAttribute('aria-expanded', 'false');
        }
      });
    }
  }

  if (voiceSelect) {
    voiceSelect.addEventListener('change', (e) => {
      selectedVoiceId = e.target.value;
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem('vi_tts_voice', selectedVoiceId);
        }
      } catch (err) {}
    });
  }

  // 5. Test Audio Preview Button
  if (testPreviewBtn) {
    testPreviewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      speakText('يا هلا بيك! أني فاي، مساعدك المالي الذكي. شلون أكدر أساعدك اليوم؟', testPreviewBtn);
    });
  }
}

/**
 * Global click delegation for interactive fintech confirmation card buttons
 * Provides 1-tap confirmation & cancellation with immediate state locking and micro-feedback
 */
function initFintechActionButtons() {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;

  document.addEventListener('click', (event) => {
    // 1. Check if clicked the drawer shortcut on success receipt card (pulsing checkmark crest)
    const receiptBtn = event.target && event.target.closest ? event.target.closest('.fintech-receipt-btn, .receipt-hero-crest') : null;
    if (receiptBtn) {
      triggerReceiptCelebration(receiptBtn);
      if (typeof openTransactionsDrawer === 'function') {
        openTransactionsDrawer();
      }
      return;
    }

    // 2. Check if clicked a quick-transfer button on a contact card (Apple Pay / Revolut style)
    const contactBtn = event.target && event.target.closest ? event.target.closest('.contact-quick-transfer-btn') : null;
    if (contactBtn) {
      event.preventDefault();
      const contactName = contactBtn.getAttribute('data-contact-name');
      const contactPhone = contactBtn.getAttribute('data-contact-phone') || '';
      if (typeof openQuickTransferModal === 'function') {
        openQuickTransferModal(contactName, contactPhone, '');
      } else if (contactName && userInput) {
        const textToFill = `أريد أحول 50 ألف لـ ${contactName}`;
        userInput.value = textToFill;
        userInput.focus();
        if (typeof autoResizeTextarea === 'function') autoResizeTextarea();
        const start = textToFill.indexOf('50 ألف');
        if (start !== -1 && typeof userInput.setSelectionRange === 'function') {
          userInput.setSelectionRange(start, start + 6);
        }
        if (typeof scrollToBottom === 'function') scrollToBottom();
      }
      return;
    }

    // 2b. Check if clicked a disambiguation option button (1-tap ambiguous contact choice)
    const disambigBtn = event.target && event.target.closest ? event.target.closest('.disambiguation-option-btn') : null;
    if (disambigBtn) {
      event.preventDefault();
      const choice = disambigBtn.getAttribute('data-choice');
      if (choice && typeof handleFormSubmit === 'function') {
        handleFormSubmit(choice);
      }
      return;
    }

    // 3. Check if clicked an action button (confirm or cancel)
    const btn = event.target && event.target.closest ? event.target.closest('.fintech-action-btn') : null;
    if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;

    if (isRequestInProgress) {
      console.warn('[Action Guard] Submission ignored: another request is currently in progress.');
      return;
    }

    const action = btn.getAttribute('data-action');
    if (!action) return;

    const card = btn.closest('.fintech-card');

    if (action === 'confirm') {
      btn.classList.add('btn-processing');
      const label = btn.querySelector('.btn-label');
      if (label) label.textContent = 'جارِ التأكيد...';

      // Silent submission directly to backend without adding redundant user chat bubble!
      handleFormSubmit('نعم متأكد', {
        silentUserBubble: true,
        sourceCard: card,
        actionType: 'confirm',
        triggerBtn: btn
      });
    } else if (action === 'cancel') {
      btn.classList.add('btn-processing');
      const label = btn.querySelector('.btn-label');
      if (label) label.textContent = 'جارِ الإلغاء...';

      // Silent submission directly to backend without adding redundant user chat bubble!
      handleFormSubmit('إلغاء العملية', {
        silentUserBubble: true,
        sourceCard: card,
        actionType: 'cancel',
        triggerBtn: btn
      });
    }
  });
}

/**
 * ==========================================================================
 * Tier-1 Apple Pay Style "Slide to Confirm" (اسحب لتأكيد التحويل) Interactive Slider
 * Features:
 * - Touch (touchstart, touchmove, touchend, touchcancel) & Mouse (mousedown, mousemove, mouseup) / Pointer gesture tracking
 * - Smooth gesture tracking in RTL layout with touch-action: none
 * - Tactile spring-back physics return (cubic-bezier(0.175, 0.885, 0.32, 1.275)) if released prior to 88% completion threshold
 * - Dynamic metallic shimmer sweep along track and real-time text opacity fading
 * - Past 88% threshold: snaps thumb to successful green locked state, triggers haptic vibration via navigator.vibrate([15, 30, 20]),
 *   plays ViHaptics/Apple Pay success chime, launches micro-confetti, and dispatches confirmation payload to chat API
 * - Gated high-value financial transfers (>100,000 IQD) with luxury security verification badge
 * - Full keyboard accessibility (tabindex="0", role="slider", Enter/Space triggers)
 * ==========================================================================
 */

const SLIDE_COMPLETION_THRESHOLD = 0.88;

/**
 * Extracts numeric value from Arabic / English formatted currency strings
 * e.g., '150,000 د.ع' -> 150000, '١٥٠,٠٠٠' -> 150000, '1.5 مليون' -> 1500000
 * @param {string} amountStr
 * @returns {number}
 */
function parseAmountValue(amountStr) {
  if (!amountStr || typeof amountStr !== 'string') return 0;
  // Convert Eastern Arabic numerals (٠-٩) to Western (0-9)
  const arabicNumerals = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
  let normalized = amountStr;
  arabicNumerals.forEach((d, i) => {
    normalized = normalized.split(d).join(i.toString());
  });

  if (/مليون|ملايين/i.test(normalized)) {
    const m = normalized.match(/([0-9]+(?:\.[0-9]+)?)/);
    if (m) return Math.round(parseFloat(m[1]) * 1000000);
    return 1000000;
  }

  // Clean up commas, currency symbols, whitespace
  const clean = normalized.replace(/[^0-9.]/g, '');
  const val = parseFloat(clean);
  return isNaN(val) ? 0 : val;
}

/**
 * Determines if a transaction data object or amount string constitutes a high-value transfer (>100,000 IQD)
 * @param {object|string} dataOrAmount
 * @returns {boolean}
 */
function isHighValueTransfer(dataOrAmount) {
  if (!dataOrAmount) return false;
  if (typeof dataOrAmount === 'object') {
    if (dataOrAmount.isHighValue === true) return true;
    const amtStr = dataOrAmount.amount || '';
    return parseAmountValue(amtStr) > 100000;
  }
  return parseAmountValue(dataOrAmount) > 100000;
}

let activeSlider = null;

function getEventClientX(e) {
  if (e.touches && e.touches.length > 0) return e.touches[0].clientX;
  if (e.changedTouches && e.changedTouches.length > 0) return e.changedTouches[0].clientX;
  return typeof e.clientX === 'number' ? e.clientX : 0;
}

function startSlideDrag(e) {
  if (activeSlider) return;

  const track = (e.target && typeof e.target.closest === 'function') 
    ? (e.target.classList && e.target.classList.contains && e.target.classList.contains('slide-to-confirm-track') ? e.target : e.target.closest('.slide-to-confirm-track'))
    : (e.target || null);
  if (!track) return;

  // Verify not disabled, locked, or completed
  const isDisabled = typeof track.getAttribute === 'function' ? track.getAttribute('aria-disabled') === 'true' : false;
  const isConfirmed = track.classList && typeof track.classList.contains === 'function' && track.classList.contains('is-confirmed');
  const isLocked = track.classList && typeof track.classList.contains === 'function' && track.classList.contains('btn-locked');

  if (isDisabled || isConfirmed || isLocked || isRequestInProgress) {
    return;
  }

  const thumb = track.querySelector ? track.querySelector('.slide-to-confirm-thumb') : null;
  const progressFill = track.querySelector ? track.querySelector('.slide-progress-fill') : null;
  const trackText = track.querySelector ? track.querySelector('.slide-track-text') : null;
  const shimmerText = track.querySelector ? track.querySelector('.slide-shimmer-text') : null;
  if (!thumb) return;

  // Enforce touch-action: none inline on active elements
  if (track.style) track.style.touchAction = 'none';
  if (thumb.style) thumb.style.touchAction = 'none';

  const actionsBar = (typeof track.closest === 'function') ? track.closest('.fintech-actions-bar') : null;
  if (actionsBar && actionsBar.classList && typeof actionsBar.classList.add === 'function') {
    actionsBar.classList.add('is-slider-active');
  }

  const trackRect = (typeof track.getBoundingClientRect === 'function') 
    ? track.getBoundingClientRect() 
    : { width: 280, left: 0, right: 280 };
  const fullWidth = (actionsBar && actionsBar.clientWidth) ? actionsBar.clientWidth : (trackRect.width || 280);
  const thumbWidth = thumb.offsetWidth || 40;
  const maxTravel = Math.max(0, fullWidth - thumbWidth - 8);

  const computedStyle = (typeof window !== 'undefined' && window.getComputedStyle) ? window.getComputedStyle(track) : null;
  const isRtl = !computedStyle || computedStyle.direction === 'rtl';

  const clientX = getEventClientX(e);

  activeSlider = {
    track,
    thumb,
    progressFill,
    trackText,
    shimmerText,
    card: (typeof track.closest === 'function') ? track.closest('.fintech-card') : null,
    startX: clientX,
    maxTravel,
    thumbWidth,
    isRtl,
    isDragging: true,
    completed: false,
    hasHapticTick: false,
    pointerId: e.pointerId != null ? e.pointerId : null,
    isTouch: !!(e.touches || e.changedTouches)
  };

  if (thumb && thumb.style) thumb.style.transition = 'none';
  if (progressFill && progressFill.style) progressFill.style.transition = 'none';
  if (trackText && trackText.style) trackText.style.transition = 'none';
  if (shimmerText && shimmerText.style) shimmerText.style.transition = 'none';
  track.classList.add('is-dragging');

  if (e.pointerId != null && typeof track.setPointerCapture === 'function') {
    try { track.setPointerCapture(e.pointerId); } catch (_) {}
  }
}

function onSlideDragMove(e) {
  if (!activeSlider || !activeSlider.isDragging || activeSlider.completed) return;

  if (e.cancelable) {
    try { e.preventDefault(); } catch (_) {}
  }

  // Dynamically update maxTravel if track width expanded when cancel button collapsed
  const currentTrackWidth = activeSlider.track.clientWidth || 0;
  if (currentTrackWidth > 0) {
    activeSlider.maxTravel = Math.max(0, currentTrackWidth - activeSlider.thumbWidth - 8);
  }

  const clientX = getEventClientX(e);
  const rawDelta = activeSlider.isRtl 
    ? (activeSlider.startX - clientX) 
    : (clientX - activeSlider.startX);
  const clampedDelta = Math.max(0, Math.min(activeSlider.maxTravel, rawDelta));
  const progress = activeSlider.maxTravel > 0 ? (clampedDelta / activeSlider.maxTravel) : 0;

  const sign = activeSlider.isRtl ? '-' : '';
  if (activeSlider.thumb && activeSlider.thumb.style) {
    activeSlider.thumb.style.transform = `translateX(${sign}${clampedDelta}px)`;
  }

  if (activeSlider.progressFill && activeSlider.progressFill.style) {
    activeSlider.progressFill.style.width = `${clampedDelta + (activeSlider.thumbWidth / 2)}px`;
  }
  const textOpacity = Math.max(0, 1 - (progress * 1.45)).toFixed(3);
  if (activeSlider.trackText && activeSlider.trackText.style) {
    activeSlider.trackText.style.opacity = textOpacity;
  }
  if (activeSlider.shimmerText && activeSlider.shimmerText.style) {
    activeSlider.shimmerText.style.opacity = textOpacity;
  }

  activeSlider.track.setAttribute('aria-valuenow', Math.round(progress * 100));

  // Dynamic tactile haptic tick when reaching 88% threshold during drag
  if (progress >= SLIDE_COMPLETION_THRESHOLD && !activeSlider.hasHapticTick) {
    activeSlider.hasHapticTick = true;
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try { navigator.vibrate(10); } catch (_) {}
    }
    activeSlider.thumb.classList.add('ready-to-snap');
  } else if (progress < SLIDE_COMPLETION_THRESHOLD && activeSlider.hasHapticTick) {
    activeSlider.hasHapticTick = false;
    activeSlider.thumb.classList.remove('ready-to-snap');
  }
}

function onSlideDragEnd(e) {
  if (!activeSlider || !activeSlider.isDragging || activeSlider.completed) return;

  const clientX = getEventClientX(e);
  const rawDelta = activeSlider.isRtl 
    ? (activeSlider.startX - clientX) 
    : (clientX - activeSlider.startX);
  const clampedDelta = Math.max(0, Math.min(activeSlider.maxTravel, rawDelta));
  const progress = activeSlider.maxTravel > 0 ? (clampedDelta / activeSlider.maxTravel) : 0;

  activeSlider.track.classList.remove('is-dragging');

  if (activeSlider.pointerId != null && typeof activeSlider.track.releasePointerCapture === 'function') {
    try { activeSlider.track.releasePointerCapture(activeSlider.pointerId); } catch (_) {}
  }

  if (progress >= SLIDE_COMPLETION_THRESHOLD) {
    // 88% completion threshold achieved -> Snap into successful green locked state!
    executeSlideCompletion(activeSlider);
    activeSlider = null;
  } else {
    // Released prior to reaching 88% completion threshold:
    // Restore cancel button and tactile spring-back physics return: cubic-bezier(0.175, 0.885, 0.32, 1.275) without layout jump
    const actionsBar = (activeSlider && activeSlider.track && typeof activeSlider.track.closest === 'function')
      ? activeSlider.track.closest('.fintech-actions-bar')
      : null;
    if (actionsBar && actionsBar.classList && typeof actionsBar.classList.remove === 'function' && !activeSlider.track.classList.contains('is-confirmed')) {
      actionsBar.classList.remove('is-slider-active');
    }

    const thumb = activeSlider.thumb;
    const progressFill = activeSlider.progressFill;
    const trackText = activeSlider.trackText;
    const shimmerText = activeSlider.shimmerText || (activeSlider.track ? activeSlider.track.querySelector('.slide-shimmer-text') : null);
    const track = activeSlider.track;

    thumb.classList.remove('ready-to-snap');
    if (thumb && thumb.style) {
      thumb.style.transition = 'transform 0.45s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
      thumb.style.transform = 'translateX(0px)';
    }

    if (progressFill && progressFill.style) {
      progressFill.style.transition = 'width 0.45s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
      progressFill.style.width = '0px';
    }
    if (trackText && trackText.style) {
      trackText.style.transition = 'opacity 0.35s ease';
      trackText.style.opacity = '1';
    }
    if (shimmerText && shimmerText.style) {
      shimmerText.style.transition = 'opacity 0.35s ease';
      shimmerText.style.opacity = '1';
    }

    track.setAttribute('aria-valuenow', '0');
    activeSlider = null;
  }
}

function executeSlideCompletion(slider) {
  if (!slider || slider.completed) return;
  slider.completed = true;

  const track = slider.track;
  const thumb = slider.thumb;
  const fill = slider.progressFill;
  const text = slider.trackText;
  const card = slider.card;

  const actionsBar = (track && typeof track.closest === 'function') ? track.closest('.fintech-actions-bar') : null;
  if (actionsBar && actionsBar.classList && typeof actionsBar.classList.add === 'function') {
    actionsBar.classList.add('is-slider-active', 'is-confirmed');
  }

  track.classList.remove('is-dragging');
  track.classList.add('is-confirmed', 'slide-completed', 'btn-locked');
  track.setAttribute('aria-disabled', 'true');
  track.setAttribute('aria-valuenow', '100');
  track.removeAttribute('tabindex');

  // 1. Snap thumb to 100% completion (docked on far LEFT in RTL)
  const currentTrackWidth = track.clientWidth || 0;
  if (currentTrackWidth > 0) {
    slider.maxTravel = Math.max(0, currentTrackWidth - slider.thumbWidth - 8);
  }
  const sign = slider.isRtl ? '-' : '';
  if (thumb && thumb.style) {
    thumb.style.transition = 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)';
    thumb.style.transform = `translateX(${sign}${slider.maxTravel}px)`;
  }
  thumb.classList.remove('ready-to-snap');
  thumb.classList.add('is-success');

  // Ensure thumb is docked permanently on the left
  setTimeout(() => {
    if (thumb && thumb.style && track.classList.contains('is-confirmed')) {
      thumb.style.right = 'auto';
      thumb.style.left = '4px';
      thumb.style.transform = 'none';
    }
  }, 220);

  // 2. Expand progress fill to 100%
  if (fill && fill.style) {
    fill.style.transition = 'width 0.22s cubic-bezier(0.16, 1, 0.3, 1)';
    fill.style.width = '100%';
  }

  // 3. Update track label
  const shimmerText = track.querySelector('.slide-shimmer-text');
  if (shimmerText) {
    shimmerText.textContent = 'تم التأكيد بنجاح';
  }
  if (text && text.style) {
    text.style.transition = 'opacity 0.25s ease';
    text.style.opacity = '1';
  }

  // 4. Trigger tactile haptic vibration via navigator.vibrate([15, 30, 20])
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate([15, 30, 20]);
    } catch (_) {}
  }

  // 5. Execute tactile success chime (ViHaptics Ascending Major Chord + Apple Pay Chime)
  if (typeof ViHaptics !== 'undefined' && typeof ViHaptics.playSuccessChime === 'function') {
    try { ViHaptics.playSuccessChime(); } catch (_) {}
  } else if (typeof playSuccessChime === 'function') {
    try { playSuccessChime(); } catch (_) {}
  }
  if (typeof playApplePaySuccessChime === 'function') {
    try { playApplePaySuccessChime(); } catch (_) {}
  }

  // 6. Micro-confetti burst from the thumb
  if (typeof launchMicroConfetti === 'function') {
    launchMicroConfetti(thumb);
  }

  // 7. Lock and fade sibling cancel button
  if (card) {
    const cancelBtn = card.querySelector('.fintech-btn-cancel');
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.setAttribute('aria-disabled', 'true');
      cancelBtn.classList.add('btn-locked');
      cancelBtn.style.opacity = '0.2';
      cancelBtn.style.pointerEvents = 'none';
    }
  }

  // 8. Dispatch confirmation mutation payload to chat API
  const submitFn = (typeof module !== 'undefined' && module.exports && typeof module.exports.handleFormSubmit === 'function')
    ? module.exports.handleFormSubmit
    : (typeof handleFormSubmit === 'function' ? handleFormSubmit : null);
  if (typeof submitFn === 'function') {
    submitFn('نعم متأكد', {
      silentUserBubble: true,
      sourceCard: card,
      actionType: 'confirm',
      triggerBtn: track
    });
  }
}

function handleSlideKeyboard(e) {
  const track = (e.target && typeof e.target.closest === 'function') 
    ? (e.target.classList && e.target.classList.contains && e.target.classList.contains('slide-to-confirm-track') ? e.target : e.target.closest('.slide-to-confirm-track'))
    : (e.target || null);
  if (!track) return;

  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    if (e.preventDefault) e.preventDefault();
    const isDisabled = typeof track.getAttribute === 'function' ? track.getAttribute('aria-disabled') === 'true' : false;
    const isConfirmed = track.classList && typeof track.classList.contains === 'function' && track.classList.contains('is-confirmed');
    const isLocked = track.classList && typeof track.classList.contains === 'function' && track.classList.contains('btn-locked');

    if (isDisabled || isConfirmed || isLocked || isRequestInProgress) {
      return;
    }

    const actionsBar = (track && typeof track.closest === 'function') ? track.closest('.fintech-actions-bar') : null;
    if (actionsBar && actionsBar.classList && typeof actionsBar.classList.add === 'function') {
      actionsBar.classList.add('is-slider-active');
    }

    const thumb = track.querySelector('.slide-to-confirm-thumb');
    const fill = track.querySelector('.slide-progress-fill');
    const text = track.querySelector('.slide-track-text');
    if (!thumb) return;

    const trackRect = (typeof track.getBoundingClientRect === 'function') 
      ? track.getBoundingClientRect() 
      : { width: 280, left: 0, right: 280 };
    const thumbWidth = thumb.offsetWidth || 40;
    const maxTravel = Math.max(0, (trackRect.width || 280) - thumbWidth - 8);
    const computedStyle = (typeof window !== 'undefined' && window.getComputedStyle) ? window.getComputedStyle(track) : null;
    const isRtl = !computedStyle || computedStyle.direction === 'rtl';

    const sliderState = {
      track,
      thumb,
      progressFill: fill,
      trackText: text,
      card: track.closest('.fintech-card'),
      maxTravel,
      thumbWidth,
      isRtl,
      completed: false
    };

    const sign = isRtl ? '-' : '';
    thumb.style.transition = 'transform 0.28s cubic-bezier(0.16, 1, 0.3, 1)';
    thumb.style.transform = `translateX(${sign}${maxTravel}px)`;
    if (fill) {
      fill.style.transition = 'width 0.28s cubic-bezier(0.16, 1, 0.3, 1)';
      fill.style.width = '100%';
    }
    if (text) {
      text.style.transition = 'opacity 0.2s ease';
      text.style.opacity = '0';
    }

    setTimeout(() => {
      executeSlideCompletion(sliderState);
    }, 220);
  }
}

function initSlideToConfirm() {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;

  // Pointer events (modern unified)
  if (typeof window !== 'undefined' && 'PointerEvent' in window) {
    document.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startSlideDrag(e);
    });
    document.addEventListener('pointermove', onSlideDragMove);
    document.addEventListener('pointerup', onSlideDragEnd);
    document.addEventListener('pointercancel', onSlideDragEnd);
  } else {
    // Touch events
    document.addEventListener('touchstart', startSlideDrag, { passive: true });
    document.addEventListener('touchmove', onSlideDragMove, { passive: false });
    document.addEventListener('touchend', onSlideDragEnd);
    document.addEventListener('touchcancel', onSlideDragEnd);

    // Mouse fallback
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      startSlideDrag(e);
    });
    document.addEventListener('mousemove', onSlideDragMove);
    document.addEventListener('mouseup', onSlideDragEnd);
  }

  // Keyboard accessibility
  document.addEventListener('keydown', handleSlideKeyboard);
}

/**
 * Initialize event listeners and UI components on load
 */
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('DOMContentLoaded', () => {
    // Strip any title attribute across the document to prevent native black browser tooltips
    if (typeof document.querySelectorAll === 'function') {
      document.querySelectorAll('[title]').forEach(el => el.removeAttribute('title'));
    }
    document.addEventListener('mouseover', (e) => {
      const el = e.target && e.target.closest && e.target.closest('[title]');
      if (el) el.removeAttribute('title');
    }, { capture: true, passive: true });

    // Initialize Dynamic Halftone Dots Background
    initHalftoneBackground();

    // Initialize Theme Switcher (White & Violet / Black & Emerald)
    initThemeToggle();

    // Initialize Dual-Currency Toggle & Converter Widget (IQD ⇄ USD)
    initCurrencySwitch();
    initFxCalculator();
    fetchExchangeRate();

    // Initialize Header Balance Privacy Eye Toggle & Sync
    initWalletEyeToggle();
    syncWalletHeader();

    // Initialize Voice Output Engine (TTS)
    initTtsEngine();

    // Set real-time initial timestamp
    if (welcomeTimestamp) {
      welcomeTimestamp.textContent = getCurrentFormattedTime();
    }

    // Initialize Speech Recognition feature
    initSpeechRecognition();

    // Initialize New Chat Button
    initNewChatButton();

    // Initialize AI Model Switcher (LM Studio, Gemini, Groq)
    initModelSwitcher();

    // Initialize Recent Transactions Slide-Out Drawer
    initTransactionsDrawer();

    // Initialize Desktop Workstation Companion Rail
    initCompanionRail();

    // Initialize Interactive Fintech Confirmation Action Buttons
    initFintechActionButtons();

    // Initialize Tier-1 Apple Pay "Slide to Confirm" Interactive Slider
    initSlideToConfirm();

    // Initialize Actionable Message Chips Delegation
    initBotActionChips();

    // Initialize Procedural Web Audio API Haptic Sound Synthesizer (ViHaptics)
    initHaptics();

    // Handle Form Submission
    if (chatForm) {
      chatForm.addEventListener('submit', (e) => {
        if (e && e.preventDefault) e.preventDefault();
        if (isRequestInProgress) return;
        handleFormSubmit();
      });
    }

    // Handle Enter key for submission (Shift+Enter for newline)
    if (userInput) {
      userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (isRequestInProgress) return;
          handleFormSubmit();
        }
      });

      // Auto-resize textarea height dynamically & toggle send button pop-in state
      userInput.addEventListener('input', () => {
        updateInputState();
      });
    }

    // Quick Action Prompts
    if (quickPromptsBar) {
      quickPromptsBar.addEventListener('click', (e) => {
        if (isRequestInProgress) return;
        const button = e.target.closest('.prompt-chip');
        if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
        const promptText = button.getAttribute('data-prompt');
        if (promptText) {
          if (typeof playClickSound === 'function') {
            playClickSound();
          }
          handleFormSubmit(promptText);
        }
      });
    }

    // Initialize Gemini-style voice visualizer canvas
    initVoiceVisualizerCanvas();
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => {
        initVoiceVisualizerCanvas();
      }, { passive: true });
    }
  });
}

/**
 * Updates textarea height and toggles .has-text for pop-up send button
 */
function updateInputState() {
  autoResizeTextarea();
  const hasText = userInput && userInput.value.trim().length > 0;
  if (chatForm) {
    chatForm.classList.toggle('has-text', hasText);
  }
}

/**
 * Initializes the New Chat ("شات جديد") button
 */
function initNewChatButton() {
  const newChatBtn = document.getElementById('new-chat-btn');
  if (!newChatBtn) return;

  newChatBtn.addEventListener('click', () => {
    startNewChat();
  });
}

/**
 * Display names mapping for model trigger button
 */
const MODEL_DISPLAY_NAMES = {
  local: 'LM Studio',
  gemini: 'Gemini Flash',
  groq: 'Groq'
};

/**
 * Initializes the Gemini-style smooth AI Model Switcher dropdown
 */
function initModelSwitcher() {
  const container = document.getElementById('model-menu-container');
  const trigger = document.getElementById('model-menu-trigger');
  const triggerName = document.getElementById('model-trigger-name');
  const menuItems = document.querySelectorAll('.model-dropdown-item');

  if (!container || !trigger) return;

  const currentProvider = getSelectedModelProvider();
  updateModelMenuUI(currentProvider);

  // Toggle dropdown on trigger click
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = container.classList.toggle('open');
    trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });

  // Handle item selection
  menuItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const modelKey = item.getAttribute('data-model');
      if (!modelKey) return;

      localStorage.setItem('selected_model_provider', modelKey);
      updateModelMenuUI(modelKey);
      container.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');

      console.log(`[Model Switcher] Switched to AI provider: "${modelKey}" (${MODEL_DISPLAY_NAMES[modelKey] || modelKey})`);
    });
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) {
      container.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
    }
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && container.classList.contains('open')) {
      container.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
    }
  });
}

/**
 * Updates trigger label and active checkmark on menu items
 * @param {string} provider
 */
function updateModelMenuUI(provider) {
  const triggerName = document.getElementById('model-trigger-name');
  if (triggerName) {
    triggerName.textContent = MODEL_DISPLAY_NAMES[provider] || 'LM Studio';
  }

  const menuItems = document.querySelectorAll('.model-dropdown-item');
  menuItems.forEach((item) => {
    const isTarget = item.getAttribute('data-model') === provider;
    item.classList.toggle('active', isTarget);
  });
}

/**
 * Returns currently selected AI provider ('local' | 'gemini' | 'groq')
 * @returns {string}
 */
function getSelectedModelProvider() {
  if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
    return localStorage.getItem('selected_model_provider') || 'local';
  }
  return 'local';
}

/**
 * Resets the interface back to Hero Landing Mode with smooth transition (ChatGPT / Claude style)
 */
async function startNewChat() {
  stopSpeaking();
  finishActiveStream();
  if (typeof isVoiceActive !== 'undefined' && isVoiceActive) {
    finishVoiceRecording(false);
  }
  closeTransactionsDrawer();

  const appLayout = document.getElementById('app-layout');
  const messagesContainer = document.getElementById('messages-container');

  // If in active chat mode, perform a graceful fluid exit before revealing hero
  if (appLayout && !appLayout.classList.contains('hero-mode')) {
    appLayout.classList.add('chat-resetting');
    await new Promise(resolve => setTimeout(resolve, 220));

    if (messagesContainer) {
      messagesContainer.innerHTML = '';
    }

    appLayout.classList.remove('chat-resetting');
    appLayout.classList.remove('chat-active');
    appLayout.classList.remove('hero-exiting');
    appLayout.classList.add('hero-mode');
    appLayout.classList.add('hero-entering');

    setTimeout(() => {
      appLayout.classList.remove('hero-entering');
    }, 400);
  } else {
    if (messagesContainer) {
      messagesContainer.innerHTML = '';
    }
  }

  if (userInput) {
    userInput.value = '';
    updateInputState();
    userInput.focus();
  }

  // Clear server session memory and pending operations
  const resetSessionId = getOrCreateSessionId();
  fetch('/api/reset', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': resetSessionId
    },
    body: JSON.stringify({ sessionId: resetSessionId })
  }).catch(() => {});

  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
  }, 420);
}

/**
 * Gracefully exits the initial centered Hero Landing mode and transitions to Active Chat layout
 * @returns {Promise<void>} Resolves when exit animation (~300ms) completes
 */
function exitHeroMode() {
  return new Promise((resolve) => {
    closeTransactionsDrawer();
    const appLayout = document.getElementById('app-layout');
    if (!appLayout || !appLayout.classList.contains('hero-mode')) {
      resolve();
      return;
    }

    // 1. Add hero-exiting class for graceful 300ms fade-out and slide-up of welcome elements
    appLayout.classList.add('hero-exiting');

    setTimeout(() => {
      appLayout.classList.remove('hero-mode');
      appLayout.classList.remove('hero-exiting');
      appLayout.classList.add('chat-active');
      window.dispatchEvent(new Event('resize'));
      resolve();
    }, 300);
  });
}

/**
 * Handle user message submission
 * @param {string|null} customMessage - Optional message string (e.g. from speech or quick prompt)
 */
/**
 * Handle user message submission
 * @param {string|null} customMessage - Optional message string (e.g. from speech or quick prompt)
 * @param {object} options - Optional execution controls
 * @param {boolean} options.silentUserBubble - If true, does not append user message bubble to chat
 * @param {HTMLElement|null} options.sourceCard - Confirmation card element if triggered from card button
 * @param {'confirm'|'cancel'|null} options.actionType - Action type
 * @param {HTMLElement|null} options.triggerBtn - The button clicked
 */
async function handleFormSubmit(customMessage = null, options = {}) {
  const {
    silentUserBubble = false,
    sourceCard = null,
    actionType = null,
    triggerBtn = null
  } = (typeof options === 'object' && options !== null) ? options : {};

  // 1. Synchronous in-flight guard: immediately reject if another submission is in progress
  if (isRequestInProgress) {
    console.warn('[Request Guard] Submission ignored: another request is currently in progress.');
    return;
  }

  let messageText = '';
  if (typeof customMessage === 'string' && customMessage.trim()) {
    messageText = customMessage.trim();
  } else if (userInput && typeof userInput.value === 'string') {
    messageText = userInput.value.trim();
  }

  if (!messageText) {
    if (typeof playErrorThud === 'function') {
      playErrorThud();
    }
    return;
  }
  if (typeof document === 'undefined') return;

  // Immediately stop any active voice speech and finish any active stream when user submits!
  stopSpeaking();
  finishActiveStream();

  // 2. Immediately lock state synchronously before ANY asynchronous operation or DOM transition
  isRequestInProgress = true;
  setInputState(false);

  // If triggered from a specific card, dim other sibling buttons in that card
  if (sourceCard && typeof sourceCard.querySelectorAll === 'function') {
    const cardBtns = sourceCard.querySelectorAll('.fintech-action-btn');
    cardBtns.forEach(b => {
      b.disabled = true;
      b.setAttribute('aria-disabled', 'true');
      if (b !== triggerBtn) {
        b.classList.add('btn-dimmed');
      }
    });
  }

  // Lock any active fintech confirmation buttons and slide tracks in past cards to prevent stale double clicks
  if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
    const pendingBtns = document.querySelectorAll('.fintech-action-btn:not([disabled]), .slide-to-confirm-track:not([aria-disabled="true"])');
    pendingBtns.forEach(b => {
      b.disabled = true;
      b.setAttribute('aria-disabled', 'true');
      b.classList.add('btn-locked');
      b.removeAttribute('tabindex');
    });
  }

  // 3. Clear input & reset textarea height and send button state immediately
  if (userInput) userInput.value = '';
  if (typeof updateInputState === 'function') updateInputState();

  // 4. If transitioning from welcome screen, wait for exit animation (~300ms) to finish cleanly
  const appLayout = typeof document !== 'undefined' && typeof document.getElementById === 'function' 
    ? document.getElementById('app-layout') 
    : null;
  const wasHero = appLayout && appLayout.classList && appLayout.classList.contains && appLayout.classList.contains('hero-mode');
  if (wasHero && typeof exitHeroMode === 'function') {
    await exitHeroMode();
  }

  // 5. Append User Message only if not silent!
  if (!silentUserBubble) {
    appendMessage(messageText, 'user');
  }

  // 6. Scroll to bottom & Show typing indicator
  scrollToBottom();
  showTypingIndicator(true);

  try {
    const isRealBrowser = (typeof window !== 'undefined' && typeof window.location !== 'undefined' && typeof window.location.href === 'string' && typeof document !== 'undefined');

    let streamBubbleEl = null;
    let streamContentWrapper = null;
    let streamTextSpan = null;
    let streamCursor = null;
    let streamFooterEl = null;
    let streamMessageEl = null;
    let streamFeedbackActions = null;
    let accumulatedStreamText = '';

    function ensureStreamingBubble() {
      if (streamBubbleEl || !isRealBrowser || !messagesContainer) return;
      showTypingIndicator(false);

      streamMessageEl = document.createElement('div');
      streamMessageEl.classList.add('message', 'ai-message', 'animate-fade-in');

      streamContentWrapper = document.createElement('div');
      streamContentWrapper.classList.add('msg-content-wrapper');

      streamBubbleEl = document.createElement('div');
      streamBubbleEl.classList.add('msg-bubble', 'is-streaming');
      streamBubbleEl.innerHTML = '<span class="streaming-text"></span><span class="streaming-cursor"></span>';
      streamTextSpan = streamBubbleEl.querySelector('.streaming-text');
      streamCursor = streamBubbleEl.querySelector('.streaming-cursor');

      streamFooterEl = document.createElement('div');
      streamFooterEl.classList.add('msg-footer');
      streamFooterEl.style.opacity = '0';
      streamFooterEl.style.transition = 'opacity 0.25s ease';

      const timestampEl = document.createElement('span');
      timestampEl.classList.add('msg-timestamp');
      timestampEl.textContent = getCurrentFormattedTime();
      streamFooterEl.appendChild(timestampEl);

      streamContentWrapper.appendChild(streamBubbleEl);
      streamContentWrapper.appendChild(streamFooterEl);

      const avatarEl = createBotAvatarElement();
      streamMessageEl.appendChild(avatarEl);
      streamMessageEl.appendChild(streamContentWrapper);

      messagesContainer.appendChild(streamMessageEl);
      scrollToBottom();
    }

    // 7. Send POST request to Local Backend API (with real-time streaming handlers)
    const result = await sendMessageToBackend(messageText, {
      onToken: (token) => {
        ensureStreamingBubble();
        if (streamTextSpan) {
          accumulatedStreamText += token;
          streamTextSpan.innerHTML = escapeHtml(accumulatedStreamText).replace(/\n/g, '<br>');
          scrollToBottom();
        }
      },
      onAction: (actionData) => {
        console.log('[SSE Action Received]:', actionData);
      }
    });

    const replyText = typeof result === 'object' ? result.text : result;
    showTypingIndicator(false);

    // 8. Finalize AI message display
    if (streamBubbleEl && streamMessageEl) {
      if (streamCursor) {
        streamCursor.remove();
      }
      streamBubbleEl.classList.remove('is-streaming');
      streamBubbleEl.innerHTML = formatFintechMessage(replyText, 'ai');

      const msgId = 'msg_' + Date.now();
      streamFeedbackActions = createFeedbackActions(messageText, replyText, msgId);
      streamFooterEl.appendChild(streamFeedbackActions);
      streamFooterEl.style.opacity = '1';

      // Dynamic contextual action chips (Feature: Actionable Message Chips)
      if (typeof appendActionChipsToMessage === 'function') {
        const targetWrapper = streamContentWrapper || (streamMessageEl && streamMessageEl.querySelector ? streamMessageEl.querySelector('.msg-content-wrapper') : null);
        const chips = getContextualActionChips(messageText, replyText);
        appendActionChipsToMessage(targetWrapper, chips);
      }

      scrollToBottom();

      const crest = (typeof streamBubbleEl.querySelector === 'function') ? streamBubbleEl.querySelector('.receipt-hero-crest') : null;
      if (crest) {
        triggerReceiptCelebration(crest);
      }

      if (isTtsEnabled) {
        const speakBtn = (streamFeedbackActions && typeof streamFeedbackActions.querySelector === 'function')
          ? streamFeedbackActions.querySelector('.message-speak-btn')
          : null;
        speakText(replyText, speakBtn);
      }
    } else {
      // Fallback or headless environment: render complete message
      if (typeof document !== 'undefined') {
        appendMessage(replyText, 'ai', messageText, false);
      }
    }

    // 9. Permanently resolve the confirmation card and update button states!
    const targetCard = sourceCard || (typeof document !== 'undefined' && typeof document.querySelector === 'function' ? document.querySelector('.fintech-card.confirm-card:not(.card-resolved)') : null);
    
    const isSuccessReply = replyText.includes('تم التحويل بنجاح') || 
                           replyText.includes('تم تأكيد التحويل بنجاح') || 
                           replyText.includes('تم تأكيد دفع') ||
                           replyText.includes('تم تسديد') ||
                           (replyText.includes('✅') && (replyText.includes('تحويل') || replyText.includes('تسديد')));

    const isCancelReply = replyText.includes('تم إلغاء') || 
                          replyText.includes('إلغاء العملية') || 
                          replyText.includes('تم التراجع');

    if (targetCard) {
      if (actionType === 'confirm' || isSuccessReply) {
        targetCard.classList.add('card-resolved', 'card-confirmed');
        const slideTrack = targetCard.querySelector('.slide-to-confirm-track');
        if (slideTrack) {
          slideTrack.classList.add('is-confirmed', 'slide-completed', 'btn-completed');
          const actionsBar = (typeof slideTrack.closest === 'function') ? slideTrack.closest('.fintech-actions-bar') : null;
          if (actionsBar && actionsBar.classList && typeof actionsBar.classList.add === 'function') {
            actionsBar.classList.add('is-slider-active', 'is-confirmed');
          }
          slideTrack.setAttribute('aria-disabled', 'true');
          slideTrack.removeAttribute('tabindex');
          const shimmerText = slideTrack.querySelector('.slide-shimmer-text');
          if (shimmerText) {
            shimmerText.textContent = 'تم التأكيد بنجاح';
          }
          const trackText = slideTrack.querySelector('.slide-track-text');
          if (trackText) {
            trackText.style.opacity = '1';
          }
          const thumb = slideTrack.querySelector('.slide-to-confirm-thumb');
          if (thumb) {
            thumb.classList.add('is-success');
            thumb.style.right = 'auto';
            thumb.style.left = '4px';
            thumb.style.transform = 'none';
          }
          const progressFill = slideTrack.querySelector('.slide-progress-fill');
          if (progressFill) {
            progressFill.style.width = '100%';
          }
        }
        const confirmBtn = targetCard.querySelector('.fintech-btn-confirm:not(.slide-to-confirm-track)');
        const cancelBtn = targetCard.querySelector('.fintech-btn-cancel');
        if (confirmBtn) {
          confirmBtn.classList.remove('btn-processing');
          confirmBtn.classList.add('btn-completed');
          confirmBtn.disabled = true;
          confirmBtn.setAttribute('aria-disabled', 'true');
          confirmBtn.innerHTML = `
            <span class="btn-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </span>
            <span class="btn-label">تم التأكيد بنجاح</span>
          `;
        }
        if (cancelBtn) {
          cancelBtn.style.display = 'none';
        }
      } else if (actionType === 'cancel' || isCancelReply) {
        targetCard.classList.add('card-resolved', 'card-cancelled');
        const slideTrack = targetCard.querySelector('.slide-to-confirm-track');
        if (slideTrack) {
          slideTrack.classList.add('is-cancelled', 'btn-locked');
          slideTrack.setAttribute('aria-disabled', 'true');
          slideTrack.removeAttribute('tabindex');
          slideTrack.style.display = 'none';
        }
        const confirmBtn = targetCard.querySelector('.fintech-btn-confirm');
        const cancelBtn = targetCard.querySelector('.fintech-btn-cancel');
        if (cancelBtn) {
          cancelBtn.classList.remove('btn-processing');
          cancelBtn.classList.add('btn-cancelled-final');
          cancelBtn.disabled = true;
          cancelBtn.setAttribute('aria-disabled', 'true');
          cancelBtn.innerHTML = `
            <span class="btn-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </span>
            <span class="btn-label">تم إلغاء العملية</span>
          `;
        }
        if (confirmBtn) {
          confirmBtn.style.display = 'none';
        }
      }
    }

    // 10. Update live balance in header & sync transactions drawer & companion rail
    if (typeof document !== 'undefined') {
      syncWalletHeader();
      fetchAndRenderTransactions();
      if (typeof fetchCompanionContacts === 'function') fetchCompanionContacts();
      if (typeof fetchCompanionBills === 'function') fetchCompanionBills();

      // 11. Auto-open transactions drawer if the server flagged it (e.g. user asked for recent transactions)
      if (typeof result === 'object' && result.openDrawer) {
        setTimeout(() => {
          openTransactionsDrawer();
        }, 400);
      }
    }
  } catch (error) {
    showTypingIndicator(false);
    console.error('Error communicating with AI agent:', error);
    if (triggerBtn) {
      triggerBtn.classList.remove('btn-processing');
      triggerBtn.disabled = false;
      triggerBtn.removeAttribute('aria-disabled');
      const label = triggerBtn.querySelector('.btn-label');
      if (label) {
        label.textContent = actionType === 'confirm' ? 'تأكيد وإرسال' : 'إلغاء';
      }
    }
    // Render friendly error message if server is unreachable
    if (typeof document !== 'undefined' && typeof appendErrorMessage === 'function') {
      appendErrorMessage(
        `تعذر الاتصال بالخادم المحلي (${API_CONFIG.ENDPOINT}).\nيرجى التأكد من تشغيل خادم الـ Backend المحلي أو نموذج الذكاء الاصطناعي.`
      );
    }
  } finally {
    // 11. Reliable cleanup path: unlock guard & restore controls after both successful and failed requests
    isRequestInProgress = false;
    showTypingIndicator(false);
    setInputState(true);
    if (typeof document !== 'undefined') {
      scrollToBottom();
      if (userInput && typeof userInput.focus === 'function') {
        userInput.focus();
      }
    }
  }
}

/**
 * Sends the user's message to the local backend API via fetch with SSE token streaming support
 * @param {string} userMessage - Text entered by the user
 * @param {Object} [callbacks] - Optional streaming event handlers ({ onToken, onAction, onDone })
 * @returns {Promise<{text: string, openDrawer: boolean, action?: Object}>} - Text generated by the AI and metadata
 */
async function sendMessageToBackend(userMessage, callbacks = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_CONFIG.TIMEOUT_MS);
  const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
  const sessionId = getOrCreateSessionId();

  try {
    const response = await fetch(API_CONFIG.ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream, application/json',
        'X-Request-Id': requestId,
        'X-Idempotency-Key': requestId,
        'X-Session-Id': sessionId
      },
      body: JSON.stringify({
        message: userMessage,
        provider: getSelectedModelProvider(),
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
        idempotency_key: requestId,
        stream: true
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData.error || errorData.message || `خطأ في الخادم (HTTP ${response.status})`;
      throw new Error(errorMsg);
    }

    const contentType = (response.headers && typeof response.headers.get === 'function')
      ? (response.headers.get('content-type') || '')
      : '';

    // 1. Consume Server-Sent Events (SSE) via ReadableStream with sliding-window events
    if (contentType.includes('text/event-stream') && response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let accumulatedText = '';
      let openDrawer = false;
      let finalAction = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.trim()) continue;
          let eventName = 'message';
          let dataStr = '';

          const lines = part.split('\n');
          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataStr += line.slice(5).trim();
            }
          }

          if (dataStr) {
            let parsedData = null;
            try {
              parsedData = JSON.parse(dataStr);
            } catch (_) {
              parsedData = { text: dataStr };
            }

            if (eventName === 'token') {
              const token = (parsedData && typeof parsedData.token === 'string')
                ? parsedData.token
                : (parsedData?.text || '');
              if (token) {
                accumulatedText += token;
                if (typeof callbacks.onToken === 'function') {
                  callbacks.onToken(token);
                }
              }
            } else if (eventName === 'action') {
              finalAction = parsedData;
              if (typeof callbacks.onAction === 'function') {
                callbacks.onAction(parsedData);
              }
            } else if (eventName === 'done') {
              if (parsedData?.fullResponse) {
                accumulatedText = parsedData.fullResponse;
              }
              if (parsedData?.openTransactionsDrawer) {
                openDrawer = true;
              }
              if (typeof callbacks.onDone === 'function') {
                callbacks.onDone(parsedData);
              }
            } else if (eventName === 'error') {
              throw new Error(parsedData?.error || 'حدث خطأ أثناء استلام الرد من النموذج');
            }
          }
        }
      }

      return {
        text: accumulatedText.trim(),
        openDrawer: openDrawer,
        action: finalAction
      };
    }

    // 2. Backward-compatible fallback: Standard JSON response
    const data = await response.json();
    const reply = data.response || data.reply || data.message || data.text;
    if (!reply) {
      throw new Error('لم يتم استلام نص في استجابة الخادم.');
    }

    return {
      text: reply,
      openDrawer: !!data.openTransactionsDrawer
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('انتهت مهلة انتظار الخادم المحلي (Timeout). قد يكون النموذج قيد المعالجة.');
    }
    throw err;
  }
}

/**
 * Helper to dispatch feedback (like/dislike/remove) to the backend API asynchronously
 */
function sendFeedbackToServer(type, msgId, userMessage, botResponse) {
  const currentTheme = (typeof document !== 'undefined' && document.documentElement && typeof document.documentElement.getAttribute === 'function')
    ? (document.documentElement.getAttribute('data-theme') || 'light')
    : 'light';
  fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type,
      msgId,
      userMessage: userMessage || '',
      botResponse: botResponse || '',
      theme: currentTheme
    })
  }).catch((err) => console.warn('[Feedback] Background sync note:', err));
}

/**
 * Creates Like and Dislike feedback buttons for AI message bubbles (matches Image 5)
 * Dynamically themed (Emerald Green in Dark Mode, Royal Violet in Light Mode)
 * Automatically syncs with backend/feedback_likes.json and backend/feedback_dislikes.json
 */
function createFeedbackActions(userQuery = '', botReply = '', msgId = '') {
  const actionsGroup = document.createElement('div');
  actionsGroup.classList.add('msg-feedback-actions');
  actionsGroup.setAttribute('role', 'group');
  actionsGroup.setAttribute('aria-label', 'تقييم الرد');

  const likeBtn = document.createElement('button');
  likeBtn.type = 'button';
  likeBtn.classList.add('feedback-btn', 'feedback-like');
  likeBtn.setAttribute('aria-label', 'أعجبني');
  likeBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 10v12"/>
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.5a2 2 0 0 0 1.74-.98L11 3.5a2 2 0 0 1 3.5 1.5z"/>
    </svg>
  `;

  const dislikeBtn = document.createElement('button');
  dislikeBtn.type = 'button';
  dislikeBtn.classList.add('feedback-btn', 'feedback-dislike');
  dislikeBtn.setAttribute('aria-label', 'لم يعجبني');
  dislikeBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17 14V2"/>
      <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.5a2 2 0 0 0-1.74.98L13 20.5a2 2 0 0 1-3.5-1.5z"/>
    </svg>
  `;

  likeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isAlreadyActive = likeBtn.classList.contains('active');
    const willBeActive = !isAlreadyActive;
    likeBtn.classList.toggle('active', willBeActive);
    dislikeBtn.classList.remove('active');

    sendFeedbackToServer(willBeActive ? 'like' : 'remove', msgId, userQuery, botReply);
  });

  dislikeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isAlreadyActive = dislikeBtn.classList.contains('active');
    const willBeActive = !isAlreadyActive;
    dislikeBtn.classList.toggle('active', willBeActive);
    likeBtn.classList.remove('active');

    sendFeedbackToServer(willBeActive ? 'dislike' : 'remove', msgId, userQuery, botReply);
  });

  // Replay speech button for instant message listening
  const speakBtn = createSpeakButton(botReply);
  actionsGroup.appendChild(speakBtn);
  actionsGroup.appendChild(likeBtn);
  actionsGroup.appendChild(dislikeBtn);
  return actionsGroup;
}

/**
 * Streams text progressively (letter-by-letter / chunk-by-chunk) into target bubble element
 * with smooth auto-scroll and blinking cursor, providing an instantaneous AI streaming experience.
 * @param {HTMLElement} targetEl - Chat bubble element
 * @param {string} fullText - Final complete response
 * @param {Function} onComplete - Callback executed when streaming finishes
 */
/**
 * Streams text progressively into target bubble element
 * with adaptive, high-speed neural cadence (~0.8s - 1.3s total duration),
 * organic micro-pauses, and instant-reveal on tap/click.
 * @param {HTMLElement} targetEl - Chat bubble element
 * @param {string} fullText - Final complete response
 * @param {Function} onComplete - Callback executed when streaming finishes
 */
function streamTextMessage(targetEl, fullText, onComplete) {
  if (!targetEl || !fullText) {
    if (typeof onComplete === 'function') onComplete();
    return;
  }

  // Finish any previously active stream instantly
  finishActiveStream();

  // Hide global typing indicator as soon as streaming begins
  showTypingIndicator(false);

  const isRealBrowser = (typeof window !== 'undefined' && typeof window.location !== 'undefined' && typeof window.location.href === 'string' && typeof requestAnimationFrame === 'function');

  // Headless test environments or instant fallback
  if (!isRealBrowser) {
    targetEl.innerHTML = escapeHtml(fullText).replace(/\n/g, '<br>');
    if (typeof onComplete === 'function') onComplete();
    return;
  }

  let charIndex = 0;
  const len = fullText.length;
  targetEl.classList.add('is-streaming');
  targetEl.innerHTML = '<span class="streaming-text"></span><span class="streaming-cursor"></span>';
  const textSpan = (typeof targetEl.querySelector === 'function') ? targetEl.querySelector('.streaming-text') : null;

  // Adaptive Speed: calculate step size to finish smoothly in ~650ms - 1250ms max
  const targetDurationMs = Math.min(1250, Math.max(650, len * 5.8));
  const tickDelay = 13;
  const estimatedTicks = Math.max(1, Math.round(targetDurationMs / tickDelay));
  const charsPerTick = Math.max(1, Math.ceil(len / estimatedTicks));

  let timerId = null;
  let isDone = false;

  function finish() {
    if (isDone) return;
    isDone = true;
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (targetEl) {
      targetEl.classList.remove('is-streaming');
      targetEl.removeEventListener('click', skipHandler);
      if (textSpan) {
        textSpan.innerHTML = escapeHtml(fullText).replace(/\n/g, '<br>');
      }
      const cursor = targetEl.querySelector('.streaming-cursor');
      if (cursor) cursor.remove();
    }
    if (activeStreamingSession && activeStreamingSession.targetEl === targetEl) {
      activeStreamingSession = null;
    }
    if (typeof onComplete === 'function') {
      onComplete();
    }
  }

  function skipHandler(e) {
    if (e.target && e.target.closest('button, a, .fintech-action-btn')) return;
    finish();
  }

  targetEl.addEventListener('click', skipHandler, { once: true });

  activeStreamingSession = {
    targetEl,
    skip: finish
  };

  function step() {
    if (isDone || typeof document === 'undefined') return;
    if (charIndex >= len) {
      finish();
      return;
    }

    // Advance by adaptive chunk
    const nextIndex = Math.min(len, charIndex + charsPerTick);
    const lastChar = fullText.charAt(nextIndex - 1);
    charIndex = nextIndex;

    if (textSpan) {
      textSpan.innerHTML = escapeHtml(fullText.substring(0, charIndex)).replace(/\n/g, '<br>');
    }
    scrollToBottom();

    if (charIndex >= len) {
      finish();
      return;
    }

    // Natural subtle micro-pauses for punctuation without sluggish delays
    let delay = tickDelay;
    if (lastChar === '،' || lastChar === ',') {
      delay += 16;
    } else if (lastChar === '.' || lastChar === '؟' || lastChar === '!' || lastChar === '؛' || lastChar === ':') {
      delay += 28;
    } else if (lastChar === '\n') {
      delay += 20;
    }

    timerId = setTimeout(step, delay);
  }

  step();
}

/**
 * Appends a message bubble to the chat container
 * @param {string} text - Message text
 * @param {'user'|'ai'} sender - Sender type
 * @param {string} relatedUserQuery - The user question that triggered this response (for feedback correlation)
 * @param {boolean} stream - Whether to stream the response with character-by-character animation
 */
function appendMessage(text, sender, relatedUserQuery = '', stream = true) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function' || !messagesContainer) {
    return null;
  }
  const messageEl = document.createElement('div');
  messageEl.classList.add('message', `${sender}-message`, 'animate-fade-in');

  const contentWrapper = document.createElement('div');
  contentWrapper.classList.add('msg-content-wrapper');

  const bubbleEl = document.createElement('div');
  bubbleEl.classList.add('msg-bubble');

  const footerEl = document.createElement('div');
  footerEl.classList.add('msg-footer');

  const timestampEl = document.createElement('span');
  timestampEl.classList.add('msg-timestamp');
  timestampEl.textContent = getCurrentFormattedTime();
  footerEl.appendChild(timestampEl);

  let feedbackActions = null;
  if (sender === 'ai') {
    // When an AI message arrives, stop previous speech and finish any stream
    stopSpeaking();
    finishActiveStream();

    bubbleEl.addEventListener('click', (e) => {
      if (e.target && e.target.closest('button, a, .fintech-action-btn, .receipt-hero-crest')) return;
      if (currentTtsAudio || (typeof window !== 'undefined' && window.speechSynthesis && window.speechSynthesis.speaking)) {
        stopSpeaking();
      }
    });

    const msgId = 'msg_' + Date.now();
    feedbackActions = createFeedbackActions(relatedUserQuery, text, msgId);
    footerEl.appendChild(feedbackActions);
    if (stream) {
      footerEl.style.opacity = '0';
      footerEl.style.transition = 'opacity 0.25s ease';
    }
  }

  contentWrapper.appendChild(bubbleEl);
  contentWrapper.appendChild(footerEl);

  if (sender === 'ai') {
    const avatarEl = createBotAvatarElement();
    messageEl.appendChild(avatarEl);
    messageEl.appendChild(contentWrapper);
  } else {
    messageEl.appendChild(contentWrapper);
  }

  if (messagesContainer) {
    messagesContainer.appendChild(messageEl);
  }
  scrollToBottom();

  const isRealBrowser = (typeof window !== 'undefined' && typeof window.location !== 'undefined' && typeof window.location.href === 'string' && typeof requestAnimationFrame === 'function');

  // Instant render for user messages or non-streaming environments (tests / headless)
  if (sender !== 'ai' || !stream || !isRealBrowser) {
    bubbleEl.innerHTML = formatFintechMessage(text, sender);
    if (footerEl) footerEl.style.opacity = '1';
    if (sender === 'ai' && typeof appendActionChipsToMessage === 'function') {
      const chips = getContextualActionChips(relatedUserQuery, text);
      appendActionChipsToMessage(contentWrapper, chips);
    }
    const crest = (typeof bubbleEl.querySelector === 'function') ? bubbleEl.querySelector('.receipt-hero-crest') : null;
    if (crest) {
      triggerReceiptCelebration(crest);
    }
    if (sender === 'ai' && isTtsEnabled) {
      const speakBtn = (feedbackActions && typeof feedbackActions.querySelector === 'function')
        ? feedbackActions.querySelector('.message-speak-btn')
        : null;
      speakText(text, speakBtn);
    }
    return messageEl;
  }

  // Parallel audio prefetch while the fast text stream plays to remove loading silence!
  let prefetchPromise = null;
  if (isTtsEnabled && isRealBrowser && (!selectedVoiceId || selectedVoiceId === 'cloud-google')) {
    const clean = cleanTextForSpeech(text);
    if (clean) {
      const sessionId = activeTtsSessionId;
      ttsAbortController = new AbortController();
      prefetchPromise = fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean }),
        signal: ttsAbortController.signal
      }).then(async res => {
        if (sessionId !== activeTtsSessionId) return null;
        if (res.ok && res.headers.get('content-type')?.includes('audio')) {
          const blob = await res.blob();
          if (sessionId !== activeTtsSessionId) return null;
          return URL.createObjectURL(blob);
        }
        return null;
      }).catch(() => null);
    }
  }

  // Live streaming typewriter animation for AI responses
  streamTextMessage(bubbleEl, text, () => {
    bubbleEl.innerHTML = formatFintechMessage(text, 'ai');
    footerEl.style.opacity = '1';

    if (typeof appendActionChipsToMessage === 'function') {
      const chips = getContextualActionChips(relatedUserQuery, text);
      appendActionChipsToMessage(contentWrapper, chips);
    }

    scrollToBottom();

    const crest = (typeof bubbleEl.querySelector === 'function') ? bubbleEl.querySelector('.receipt-hero-crest') : null;
    if (crest) {
      triggerReceiptCelebration(crest);
    }

    if (isTtsEnabled) {
      const speakBtn = (feedbackActions && typeof feedbackActions.querySelector === 'function')
        ? feedbackActions.querySelector('.message-speak-btn')
        : null;
      speakText(text, speakBtn, prefetchPromise);
    }
  });

  return messageEl;
}

/* ==========================================================================
   Section 8b: Dynamic Contextual Actionable Message Chips
   ========================================================================== */

/**
 * Normalizes Arabic text for flexible financial intent keyword matching
 * @param {string} text - Raw input text
 * @returns {string} Normalized text
 */
function normalizeArabicKeywords(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\u064B-\u065F]/g, '') // remove Arabic diacritics / tashkeel
    .replace(/[^\w\s\u0600-\u06FF]/g, ' ') // replace punctuation with spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derives dynamic contextual action chips based on detected financial intents or keywords
 * @param {string} userQuery - The user prompt or inquiry
 * @param {string} botReply - The assistant's textual response
 * @returns {Array<{label: string, action: string, prompt?: string}>}
 */
function getContextualActionChips(userQuery = '', botReply = '') {
  const replyStr = typeof botReply === 'string' ? botReply : '';
  const queryStr = typeof userQuery === 'string' ? userQuery : '';

  // 1. Guard against rendering duplicate or intrusive chips if confirmation or disambiguation cards exist
  if (
    replyStr.includes('confirm-card') ||
    replyStr.includes('<CONFIRMATION_REQUIRED>') ||
    replyStr.includes('fintech-confirm-card') ||
    replyStr.includes('disambiguation-card') ||
    replyStr.includes('<DISAMBIGUATION_REQUIRED>') ||
    replyStr.includes('error-bubble') ||
    replyStr.includes('⚠️ تنبيه')
  ) {
    return [];
  }

  const queryNorm = normalizeArabicKeywords(queryStr);
  const replyNorm = normalizeArabicKeywords(replyStr);
  const combined = (queryNorm + ' ' + replyNorm).trim();

  if (!combined && !replyStr) return [];

  // 2. Completed Transaction / Receipt Intent (Mutations succeeded)
  const isCompletedTx =
    replyNorm.includes('تم التحويل بنجاح') ||
    replyNorm.includes('تم تسديد') ||
    replyNorm.includes('دفعت الفاتورة') ||
    replyNorm.includes('ايصال العملية') ||
    replyNorm.includes('وصل العملية') ||
    replyNorm.includes('نجحت العملية') ||
    replyStr.includes('receipt-hero-crest');

  if (isCompletedTx) {
    return [
      { label: '📊 كم رصيدي هسة؟', action: 'prompt:كم رصيدي هسة؟' },
      { label: '📜 كشف الحساب', action: 'prompt:اعرضلي سجل الحركات الأخيرة' },
      { label: '💸 تحويل آخر', action: 'modal:quick-transfer' }
    ];
  }

  // 3. Bill Inquiries Intent
  const isBillQuery =
    queryNorm.includes('فاتوره') ||
    queryNorm.includes('فواتير') ||
    queryNorm.includes('كهرباء') ||
    queryNorm.includes('انترنت') ||
    queryNorm.includes('مولده') ||
    queryNorm.includes('تسديد') ||
    queryNorm.includes('سداد') ||
    replyNorm.includes('فواتير مستحقه') ||
    replyNorm.includes('فاتوره الكهرباء') ||
    replyNorm.includes('فاتوره الانترنت') ||
    replyNorm.includes('تسديد الفاتوره');

  if (isBillQuery) {
    return [
      { label: '💳 سداد الآن', action: 'prompt:أريد أدفع الفواتير المستحقة' },
      { label: '⚡ تسديد الإنترنت', action: 'prompt:أريد أدفع فاتورة شبكة الإنترنت' },
      { label: '💡 تسديد الكهرباء', action: 'prompt:أريد أدفع فاتورة كهرباء الكرخ' },
      { label: '📊 كم رصيدي؟', action: 'prompt:كم رصيدي هسة؟' }
    ];
  }

  // 4. Balance Inquiries Intent
  const isBalanceQuery =
    queryNorm.includes('رصيد') ||
    queryNorm.includes('فلوسي') ||
    queryNorm.includes('بالمحفظه') ||
    queryNorm.includes('محفظتي') ||
    queryNorm.includes('حسابي') ||
    replyNorm.includes('رصيدك الحالي') ||
    replyNorm.includes('رصيدك هو') ||
    replyNorm.includes('مجموع رصيدك') ||
    replyNorm.includes('رصيد المحفظه');

  if (isBalanceQuery) {
    return [
      { label: '💸 تحويل سريع', action: 'modal:quick-transfer' },
      { label: '⚡ تسديد الفواتير', action: 'prompt:شكو عندي فواتير مكسورة؟' },
      { label: '📜 كشف الحساب', action: 'prompt:اعرضلي سجل الحركات الأخيرة' }
    ];
  }

  // 5. Transactions / Mini-Ledger Inquiries
  const isLedgerQuery =
    queryNorm.includes('حركات') ||
    queryNorm.includes('سجل') ||
    queryNorm.includes('كشف') ||
    queryNorm.includes('وين راحت فلوسي') ||
    queryNorm.includes('مصاريف') ||
    replyNorm.includes('سجل الحركات') ||
    replyNorm.includes('الحركات الاخيره') ||
    replyNorm.includes('كشف حسابك');

  if (isLedgerQuery) {
    return [
      { label: '💸 تحويل سريع', action: 'modal:quick-transfer' },
      { label: '📊 فحص الرصيد', action: 'prompt:كم رصيدي هسة؟' },
      { label: '⚡ فحص الفواتير', action: 'prompt:شكو فواتير مطلوبة؟' }
    ];
  }

  // 6. Contacts / Beneficiaries Inquiries
  const isContactsQuery =
    queryNorm.includes('جهات الاتصال') ||
    queryNorm.includes('المستلمين') ||
    queryNorm.includes('دفتر') ||
    queryNorm.includes('جماعتي') ||
    replyNorm.includes('جهات الاتصال') ||
    replyNorm.includes('قائمه المستلمين');

  if (isContactsQuery) {
    return [
      { label: '💸 تحويل سريع', action: 'modal:quick-transfer' },
      { label: '💸 تحويل لأحمد', action: 'prompt:أريد أحول 50 ألف لأحمد كمال' },
      { label: '💸 تحويل لسيف', action: 'prompt:أريد أحول 25 ألف لسيف مصطفى' }
    ];
  }

  // 7. General Financial Assistant Shortcut Chips (Fallback for greetings or general queries)
  return [
    { label: '📊 فحص الرصيد', action: 'prompt:كم رصيدي هسة؟' },
    { label: '💸 تحويل سريع', action: 'modal:quick-transfer' },
    { label: '⚡ تسديد الفواتير', action: 'prompt:شكو عندي فواتير مكسورة؟' }
  ];
}

/**
 * Appends contextual action chips container beneath the bot message bubble
 * @param {HTMLElement} contentWrapper - The .msg-content-wrapper element
 * @param {Array<{label: string, action: string}>} chips - Array of action chip descriptors
 * @returns {HTMLElement|null} The created chips container or null
 */
function appendActionChipsToMessage(contentWrapper, chips) {
  if (!contentWrapper || !Array.isArray(chips) || chips.length === 0) return null;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;

  // Prevent duplicate action chip containers on the same message
  if (typeof contentWrapper.querySelector === 'function' && contentWrapper.querySelector('.bot-action-chips-container')) {
    return null;
  }

  const container = document.createElement('div');
  container.className = 'bot-action-chips-container';
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', 'إجراءات مالية سريعة');

  chips.forEach((chip) => {
    if (!chip || !chip.label) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bot-action-chip';
    btn.setAttribute('data-chip-action', chip.action || '');
    if (chip.prompt) {
      btn.setAttribute('data-chip-prompt', chip.prompt);
    }
    btn.setAttribute('aria-label', chip.label);
    btn.textContent = chip.label;
    container.appendChild(btn);
  });

  const footerEl = (typeof contentWrapper.querySelector === 'function') ? contentWrapper.querySelector('.msg-footer') : null;
  if (footerEl && footerEl.parentNode === contentWrapper && typeof contentWrapper.insertBefore === 'function') {
    contentWrapper.insertBefore(container, footerEl);
  } else if (typeof contentWrapper.appendChild === 'function') {
    contentWrapper.appendChild(container);
  }

  return container;
}

/**
 * Dispatches action corresponding to a clicked action chip
 * @param {string} action - Action descriptor (e.g., 'modal:quick-transfer', 'prompt:...')
 * @param {HTMLElement} [chipElement] - The button element that was clicked
 */
function handleBotActionChipClick(action, chipElement) {
  if (!action) return;

  if (typeof playClickSound === 'function') {
    playClickSound();
  }

  // 1. Modal trigger
  if (action === 'modal:quick-transfer' || action.startsWith('modal:quick-transfer')) {
    if (typeof openQuickTransferModal === 'function') {
      openQuickTransferModal();
    }
    return;
  }

  // 2. Direct instant bill settlement trigger
  if (action.startsWith('settle:bill:')) {
    const billName = action.replace(/^settle:bill:/, '').trim();
    if (typeof handleQuickBillPayment === 'function') {
      handleQuickBillPayment(billName);
    } else if (typeof handleFormSubmit === 'function') {
      handleFormSubmit(`أريد أسدد ${billName}`);
    }
    return;
  }

  // 3. Auto-dispatch chat prompt trigger
  if (action.startsWith('prompt:')) {
    const promptText = action.replace(/^prompt:/, '').trim();
    if (promptText && typeof handleFormSubmit === 'function') {
      handleFormSubmit(promptText);
    }
    return;
  }

  // Fallback: If action itself is formatted prompt string
  if (typeof handleFormSubmit === 'function') {
    handleFormSubmit(action);
  }
}

/**
 * Initializes event delegation on .messages-container for actionable message chips
 */
function initBotActionChips() {
  if (typeof document === 'undefined') return;
  const container = document.querySelector('.messages-container');
  if (!container || container._hasBotActionChipsListener) return;
  container._hasBotActionChipsListener = true;

  container.addEventListener('click', (event) => {
    const chip = event.target.closest('.bot-action-chip');
    if (!chip) return;

    event.preventDefault();
    event.stopPropagation();

    // Trigger micro-elevation active pulse
    chip.classList.add('is-active-pulse');
    setTimeout(() => {
      chip.classList.remove('is-active-pulse');
    }, 280);

    const action = chip.getAttribute('data-chip-action') || '';
    handleBotActionChipClick(action, chip);
  });
}

/**
 * Appends an error card message to the chat
 * @param {string} errorMessage - Error description
 */
function appendErrorMessage(errorMessage) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  const messageEl = document.createElement('div');
  messageEl.classList.add('message', 'ai-message', 'animate-fade-in');

  const contentWrapper = document.createElement('div');
  contentWrapper.classList.add('msg-content-wrapper');

  const bubbleEl = document.createElement('div');
  bubbleEl.classList.add('msg-bubble', 'error-bubble');
  bubbleEl.innerHTML = `<strong>⚠️ تنبيه الاتصال:</strong><br>${escapeHtml(errorMessage).replace(/\n/g, '<br>')}`;

  const timestampEl = document.createElement('span');
  timestampEl.classList.add('msg-timestamp');
  timestampEl.textContent = getCurrentFormattedTime();

  contentWrapper.appendChild(bubbleEl);
  contentWrapper.appendChild(timestampEl);

  const avatarEl = createBotAvatarElement();
  messageEl.appendChild(avatarEl);
  messageEl.appendChild(contentWrapper);
  if (messagesContainer) {
    messagesContainer.appendChild(messageEl);
  }
}

/**
 * Toggles the typing indicator visibility
 * @param {boolean} show - Whether to show or hide
 */
function showTypingIndicator(show) {
  if (!typingIndicator || !typingIndicator.classList) return;
  if (show) {
    typingIndicator.classList.remove('hidden');
    scrollToBottom();
  } else {
    typingIndicator.classList.add('hidden');
  }
}

/**
 * Enables or disables all interactive input controls, buttons, and suggestion chips
 * @param {boolean} enabled - UI state
 */
function setInputState(enabled) {
  if (typeof document === 'undefined') return;
  if (userInput) {
    userInput.disabled = !enabled;
    userInput.setAttribute('aria-disabled', !enabled ? 'true' : 'false');
  }
  if (sendBtn) {
    sendBtn.disabled = !enabled;
    sendBtn.setAttribute('aria-disabled', !enabled ? 'true' : 'false');
  }
  if (micBtn) {
    micBtn.disabled = !enabled;
    micBtn.setAttribute('aria-disabled', !enabled ? 'true' : 'false');
  }
  const stopBtn = document.getElementById ? document.getElementById('voice-stop-btn') : null;
  const sendVoiceBtn = document.getElementById ? document.getElementById('voice-send-btn') : null;
  if (stopBtn) {
    stopBtn.disabled = !enabled;
    stopBtn.setAttribute('aria-disabled', !enabled ? 'true' : 'false');
  }
  if (sendVoiceBtn) {
    sendVoiceBtn.disabled = !enabled;
    sendVoiceBtn.setAttribute('aria-disabled', !enabled ? 'true' : 'false');
  }
  const promptChips = document.querySelectorAll('.prompt-chip');
  promptChips.forEach(chip => {
    chip.disabled = !enabled;
    chip.setAttribute('aria-disabled', !enabled ? 'true' : 'false');
  });
  if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
    const actionBtns = document.querySelectorAll('.fintech-action-btn');
    actionBtns.forEach(btn => {
      if (!enabled) {
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
      }
    });
  }
}

/**
 * Automatically adjusts the textarea height based on content
 */
function autoResizeTextarea() {
  const inputEl = userInput || (typeof document !== 'undefined' ? document.getElementById('user-input') : null);
  if (!inputEl || !inputEl.style) return;
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight || 0, 120)}px`;
}

/**
 * Smoothly scrolls the chat window to the bottom
 */
function scrollToBottom() {
  if (!chatWindow) return;
  const rAF = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame : (cb) => setTimeout(cb, 0));
  rAF(() => {
    if (chatWindow) {
      chatWindow.scrollTop = chatWindow.scrollHeight;
    }
    setTimeout(() => {
      if (chatWindow) {
        chatWindow.scrollTop = chatWindow.scrollHeight;
      }
    }, 50);
  });
}

/**
 * Returns current formatted time in Arabic locale (e.g. 10:45 م)
 */
function getCurrentFormattedTime() {
  const now = new Date();
  return now.toLocaleTimeString('ar-IQ', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * Basic HTML escaping helper to prevent XSS
 */
function escapeHtml(string) {
  if (typeof string !== 'string') return '';
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const div = document.createElement('div');
    div.textContent = string;
    if (typeof div.innerHTML === 'string' && div.innerHTML) {
      return div.innerHTML;
    }
  }
  return string
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Parses financial transaction details (recipient, amount, biller, direction)
 * from confirmation or receipt text for visual flow rendering.
 * @param {string} rawText
 * @returns {object|null}
 */
/**
 * Parses financial transaction details (recipient, amount, biller, direction, balance)
 * from confirmation or receipt text for structured visual flow rendering.
 * @param {string} rawText
 * @param {boolean} isConfirm
 * @param {boolean} isSuccess
 * @returns {object}
 */
function parseFintechTransactionData(rawText, isConfirm, isSuccess) {
  if (!rawText) {
    return {
      isBill: false,
      isAllBills: false,
      recipient: '',
      subDetail: '',
      phoneOrAccount: '',
      amount: '',
      balanceAfter: '',
      introMessage: ''
    };
  }

  const isBill = /فاتورة|فواتير|تسديد|دفع/i.test(rawText);
  const isAllBills = /كافة الفواتير|كل الفواتير/i.test(rawText);

  // 1. Extract Amount
  let amount = '';
  const amtMatch = rawText.match(/(?:المبلغ المطلوب|المجموع الكلي|المبلغ)\s*:\s*([^\n\r]+)/i);
  if (amtMatch) {
    amount = amtMatch[1].replace(/\.+$/, '').trim();
  } else {
    const successAmtMatch = rawText.match(/(?:دزيت|بمجموع|تسديد)\s+([0-9,]+(?:\.\d+)?\s*(?:د\.ع|IQD|دينار))/i);
    if (successAmtMatch) {
      amount = successAmtMatch[1].trim();
    } else {
      const curMatch = rawText.match(/(\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:IQD|د\.ع|دينار))/i);
      if (curMatch) amount = curMatch[1].trim();
    }
  }

  // 2. Extract Balance
  let balanceAfter = '';
  const balMatch = rawText.match(/(?:الرصيد بعد التحويل|الرصيد بعد الدفع|رصيدك الحالي هسة)\s*:\s*([^\n\r]+)/i);
  if (balMatch) {
    balanceAfter = balMatch[1].replace(/\.+$/, '').trim();
  }

  // 3. Extract Recipient & Details
  let recipient = '';
  let subDetail = '';
  let phoneOrAccount = '';

  if (isBill) {
    if (isAllBills) {
      recipient = 'تسديد كافة الفواتير المستحقة';
      const countMatch = rawText.match(/عدد الفواتير\s*:\s*(\d+)/i) || rawText.match(/تسديد\s+(\d+)\s+فواتير/i);
      if (countMatch) {
        subDetail = `${countMatch[1]} فواتير مسجلة`;
      }
    } else {
      const billMatch = rawText.match(/الفاتورة\s*:\s*([^\n\r]+)/i) || rawText.match(/لحساب\s*\(([^)]+)\)/i);
      if (billMatch) {
        let bText = billMatch[1].trim();
        const accMatch = bText.match(/\(([^)]+)\)/) || bText.match(/-\s*([A-Za-z0-9_-]+)/);
        if (accMatch) {
          phoneOrAccount = accMatch[1].trim();
          bText = bText.replace(accMatch[0], '').replace(/[-()]/g, '').trim();
        }
        bText = bText.replace(/^[•\s\-_()]+|[•\s\-_()]+$/g, '').replace(/^الفاتورة\s*:\s*/i, '').trim();
        recipient = bText || 'فاتورة خدمة';
        subDetail = phoneOrAccount ? `حساب: ${phoneOrAccount}` : '';
      } else {
        recipient = 'تسديد فاتورة';
      }
    }
  } else {
    let targetStr = '';
    const recLineMatch = rawText.match(/المستلم\s*:\s*([^\n\r]+)/i);
    if (recLineMatch) {
      targetStr = recLineMatch[1].trim();
    } else {
      const succTargetMatch = rawText.match(/إلى\s+([^.]+?)(?:\.\s*رصيدك|$)/i);
      if (succTargetMatch) {
        targetStr = succTargetMatch[1].trim();
      }
    }

    if (targetStr) {
      const phoneMatch = targetStr.match(/(?:\+?964\d{8,10}|07\d{8,9})/);
      if (phoneMatch) {
        phoneOrAccount = phoneMatch[0].trim();
        targetStr = targetStr.replace(phoneMatch[0], '').replace(/\(\s*\)/g, '').trim();
      }

      const aliasMatch = targetStr.match(/\(([^)]+)\)/);
      if (aliasMatch) {
        subDetail = aliasMatch[1].trim();
        targetStr = targetStr.replace(aliasMatch[0], '').trim();
      }

      recipient = targetStr.replace(/^[•\s\-_()]+|[•\s\-_()]+$/g, '').trim();
      if (!recipient && subDetail) {
        recipient = subDetail;
        subDetail = '';
      }
    }

    if (!recipient) {
      recipient = 'حوالة مالية';
    }
  }

  // 4. Extract conversational intro if present
  let introMessage = '';
  if (isConfirm) {
    const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0 && !lines[0].startsWith('تفاصيل') && !lines[0].startsWith('•') && !lines[0].startsWith('-')) {
      introMessage = lines[0];
    }
  }

  return {
    isBill,
    isAllBills,
    recipient,
    subDetail,
    phoneOrAccount,
    amount,
    balanceAfter,
    introMessage
  };
}

/**
 * Backward compatibility alias for parseFintechTransactionData
 */
function parseFintechTransactionDetails(rawText) {
  return parseFintechTransactionData(rawText, true, false);
}

/**
 * Renders the Visual Transfer Stream widget (Source Wallet ──> Animated Flow ──> Recipient/Biller)
 * @param {object} details
 * @returns {string} HTML string
 */
function renderFintechFlowWidget(details) {
  if (!details) return '';
  const { isBill, recipient, subDetail, amount } = details;

  return `
    <div class="fintech-transfer-flow" role="region" aria-label="مسار التحويل المالي">
      <div class="flow-node flow-sender">
        <div class="flow-node-text">
          <span class="flow-node-role">المرسِل</span>
          <span class="flow-node-name">محفظتك</span>
        </div>
      </div>

      <div class="flow-connector">
        ${amount ? `
          <div class="flow-pill-capsule">
            <span class="flow-pill-amount">${escapeHtml(amount)}</span>
            <span class="flow-pill-direction" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7"/>
              </svg>
            </span>
          </div>
        ` : ''}
      </div>

      <div class="flow-node flow-receiver">
        <div class="flow-node-text">
          <span class="flow-node-role">${isBill ? 'جهة الدفع' : 'المستلم'}</span>
          <span class="flow-node-name">${escapeHtml(recipient)}</span>
          ${subDetail ? `<span class="flow-node-sub">${escapeHtml(subDetail)}</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

/**
 * Renders Interactive Glass Action Bar with Tier-1 Apple Pay "Slide to Confirm" (اسحب لتأكيد التحويل) Slider & Cancel Button
 * @param {object} [data] - Transaction details (optional)
 * @returns {string} HTML string
 */
function renderFintechActionButtons(data) {
  const isHighValue = isHighValueTransfer(data);
  const highValueAttr = isHighValue ? ' data-high-value="true"' : '';
  const highValueClass = isHighValue ? ' high-value-track' : '';
  const isBillPayment = data && (data.isBill || data.bill_id || data.type === 'BILL_PAYMENT' || data.isBulk);
  const slideActionLabel = isBillPayment ? 'اسحب لتأكيد سداد الفواتير' : 'اسحب لتأكيد التحويل';

  return `
    <div class="fintech-actions-bar" role="group" aria-label="خيارات التأكيد السريع">
      <div class="slide-to-confirm-track fintech-btn-confirm${highValueClass}" 
           role="slider" 
           tabindex="0" 
           aria-label="${slideActionLabel}" 
           aria-valuemin="0" 
           aria-valuemax="100" 
           aria-valuenow="0" 
           data-action="confirm"
           data-threshold="0.88"${highValueAttr}>
        <div class="slide-progress-fill"></div>
        <div class="slide-track-text">
          <span class="slide-shimmer-text">${slideActionLabel}</span>
          <span class="slide-track-arrow" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"></line>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
          </span>
        </div>
        <div class="slide-to-confirm-thumb" aria-hidden="true">
          <span class="thumb-icon-arrow">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"></line>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
          </span>
          <span class="thumb-icon-check">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </span>
        </div>
      </div>

      <button type="button" class="fintech-action-btn fintech-btn-cancel" data-action="cancel" aria-label="إلغاء العملية والتراجع">
        <span class="btn-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </span>
        <span class="btn-label">إلغاء</span>
      </button>
    </div>
  `;
}

/**
 * Alias for renderFintechConfirmationCard for test and external caller compatibility
 */
function renderConfirmationCard(data) {
  return renderFintechConfirmationCard(data);
}

/**
 * Renders Tier-1 Structured Confirmation Card
 * @param {object} data
 * @returns {string} HTML string
 */
function renderFintechConfirmationCard(data) {
  const isHighValue = isHighValueTransfer(data);
  const flowWidget = renderFintechFlowWidget(data);
  const actionsWidget = renderFintechActionButtons(data);

  return `
    <div class="fintech-card confirm-card${isHighValue ? ' high-value-card' : ''}" role="region" aria-label="مراجعة وتأكيد المعاملة المالية"${isHighValue ? ' data-high-value="true"' : ''}>
      ${data && data.introMessage ? `
      <div class="fintech-ai-intro">
        <span class="ai-intro-text">${escapeHtml(data.introMessage)}</span>
      </div>
      ` : ''}

      ${isHighValue ? `
      <div class="high-value-security-badge" role="status" aria-label="تحويل مالي عالي القيمة">
        <span class="security-badge-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            <path d="M9 12l2 2 4-4"></path>
          </svg>
        </span>
        <div class="security-badge-content">
          <span class="security-badge-title">تحويل عالي القيمة (&gt;100,000 د.ع)</span>
          <span class="security-badge-desc">مطلوب تأكيد أمني: اسحب المقبض بنسبة 88% لإتمام التحويل بأمان</span>
        </div>
      </div>
      ` : ''}

      ${flowWidget}

      <div class="fintech-spec-grid">
        <div class="spec-row">
          <span class="spec-label">${data && data.isBill ? 'الجهة المستفيدة' : 'المستلم'}</span>
          <span class="spec-value recipient-val">${escapeHtml((data && data.recipient) || '')} ${(data && data.subDetail) ? `<span class="spec-sub">(${escapeHtml(data.subDetail)})</span>` : ''}</span>
        </div>
        ${(data && data.phoneOrAccount) ? `
        <div class="spec-row">
          <span class="spec-label">${data.isBill ? 'رقم الحساب' : 'رقم الهاتف'}</span>
          <span class="spec-value phone-val" dir="ltr">${escapeHtml(data.phoneOrAccount)}</span>
        </div>
        ` : ''}
        <div class="spec-row highlight-amount-row${isHighValue ? ' high-value-amount' : ''}">
          <span class="spec-label">المبلغ المطلوب</span>
          <span class="spec-value spec-amount-val">${escapeHtml((data && data.amount) || '')}</span>
        </div>
        ${(data && data.balanceAfter) ? `
        <div class="spec-row">
          <span class="spec-label">الرصيد بعد العملية</span>
          <span class="spec-value spec-balance-val">${escapeHtml(data.balanceAfter)}</span>
        </div>
        ` : ''}
      </div>

      <div class="fintech-prompt-bar">
        <span>${isHighValue ? 'يرجى مراجعة التفاصيل بدقة، واسحب المقبض أدناه لتأكيد التحويل عالي القيمة:' : 'يرجى مراجعة التفاصيل، ثم الاختيار أدناه أو الرد (صوتياً أو كتابياً) بـ "تأكيد" أو "إلغاء":'}</span>
      </div>

      ${actionsWidget}
    </div>
  `;
}

/**
 * Global shared AudioContext for low-latency tactile sound effects
 */
let sharedAudioCtx = null;

function getSharedAudioContext() {
  if (typeof window === 'undefined') return null;
  const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtxClass) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    try {
      sharedAudioCtx = new AudioCtxClass();
    } catch (e) {
      return null;
    }
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

/**
 * Synthesizes an Apple Pay-style luxury metallic confirmation chime (~880Hz -> 1320Hz)
 * Zero external audio assets (100% offline mathematical synthesis via Web Audio API)
 * Strictly respects global mute guard (isTtsEnabled)
 * @returns {boolean} Whether chime was triggered
 */
function playApplePaySuccessChime() {
  if (!isTtsEnabled) return false; // Strict Mute Guard
  if (typeof window === 'undefined') return false;

  const ctx = getSharedAudioContext();
  if (!ctx) return false;

  try {
    const now = ctx.currentTime;

    // Master gain for the chime with soft exponential decay
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.0001, now);
    masterGain.gain.linearRampToValueAtTime(0.35, now + 0.015);
    masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);
    masterGain.connect(ctx.destination);

    // Primary fundamental tone: ~880Hz rising smoothly to 1320Hz (A5 -> E6)
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(880, now);
    osc1.frequency.exponentialRampToValueAtTime(1320, now + 0.11);

    // Secondary subtle metallic harmonic overtone (~1760Hz -> 2640Hz)
    const osc2 = ctx.createOscillator();
    const harmonicGain = ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(1760, now);
    osc2.frequency.exponentialRampToValueAtTime(2640, now + 0.11);

    harmonicGain.gain.setValueAtTime(0.0001, now);
    harmonicGain.gain.linearRampToValueAtTime(0.12, now + 0.015);
    harmonicGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

    osc1.connect(masterGain);
    osc2.connect(harmonicGain);
    harmonicGain.connect(masterGain);

    osc1.start(now);
    osc2.start(now);

    osc1.stop(now + 0.8);
    osc2.stop(now + 0.8);
    return true;
  } catch (err) {
    console.warn('[Audio] Failed to synthesize success chime:', err);
    return false;
  }
}

/**
 * Launches an elegant micro-confetti burst radiating outward from a target element
 * @param {HTMLElement} originElement - The crest element (.receipt-hero-crest)
 * @returns {HTMLCanvasElement|null}
 */
function launchMicroConfetti(originElement) {
  if (typeof document === 'undefined' || !originElement || typeof document.createElement !== 'function') return null;

  const prefersReducedMotion = typeof window !== 'undefined' && 
                               window.matchMedia && 
                               window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return null;

  const width = 240;
  const height = 240;

  // Create overlay canvas positioned centered on the crest
  const canvas = document.createElement('canvas');
  canvas.classList.add('crest-confetti-canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.position = 'absolute';
  canvas.style.top = '50%';
  canvas.style.left = '50%';
  canvas.style.transform = 'translate(-50%, -50%)';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '5';
  canvas.setAttribute('aria-hidden', 'true');

  if (typeof originElement.appendChild === 'function') {
    originElement.appendChild(canvas);
  }

  const ctx = (canvas && typeof canvas.getContext === 'function') ? canvas.getContext('2d') : null;
  if (!ctx) {
    if (typeof canvas.remove === 'function') canvas.remove();
    return canvas;
  }

  // Refined metallic palette: Gold (#eab308), Emerald (#10b981), and Violet (#a855f7)
  const colors = ['#eab308', '#f59e0b', '#10b981', '#059669', '#a855f7', '#8b5cf6'];
  const particleCount = 36;
  const centerX = width / 2;
  const centerY = height / 2;
  const particles = [];

  for (let i = 0; i < particleCount; i++) {
    const angle = (Math.PI * 2 * i) / particleCount + (Math.random() - 0.5) * 0.45;
    const speed = 2.8 + Math.random() * 4.6;
    const size = 3 + Math.random() * 4;
    const isCircle = Math.random() > 0.45;

    particles.push({
      x: centerX + Math.cos(angle) * 12,
      y: centerY + Math.sin(angle) * 12,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 0.8,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: size,
      isCircle: isCircle,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.25,
      alpha: 1,
      drag: 0.945,
      gravity: 0.12
    });
  }

  const startTime = (typeof performance !== 'undefined' && typeof performance.now === 'function') 
    ? performance.now() 
    : Date.now();
  const duration = 1200; // 1.2s auto-fade
  let animId = null;

  function frame(now) {
    const currentTime = (typeof now === 'number') ? now : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const elapsed = currentTime - startTime;
    const progress = Math.min(1, elapsed / duration);

    ctx.clearRect(0, 0, width, height);

    // Fade out smoothly in the second half of animation
    const globalAlpha = progress < 0.55 ? 1 : Math.max(0, 1 - (progress - 0.55) / 0.45);

    for (let p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= p.drag;
      p.vy = p.vy * p.drag + p.gravity;
      p.rotation += p.rotSpeed;

      ctx.save();
      ctx.globalAlpha = p.alpha * globalAlpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;

      if (p.isCircle) {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.size / 2, -p.size * 0.75, p.size, p.size * 1.5);
      }

      ctx.restore();
    }

    if (progress < 1) {
      if (typeof requestAnimationFrame === 'function') {
        animId = requestAnimationFrame(frame);
      }
    } else {
      if (animId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(animId);
      }
      if (typeof canvas.remove === 'function') canvas.remove();
    }
  }

  if (typeof requestAnimationFrame === 'function') {
    animId = requestAnimationFrame(frame);
  }

  // Guaranteed fallback timer to remove canvas after 1.4s even if tab loses focus
  setTimeout(() => {
    if (canvas && canvas.parentNode) {
      if (animId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(animId);
      }
      if (typeof canvas.remove === 'function') canvas.remove();
    }
  }, 1400);

  return canvas;
}

/**
 * Triggers full luxury tactile confirmation feedback:
 * 1. Apple Pay synthesized two-tone confirmation chime
 * 2. Digital metallic micro-confetti particle burst
 * @param {HTMLElement} crestEl
 * @returns {{ chime: boolean, confetti: HTMLCanvasElement|null }}
 */
function triggerReceiptCelebration(crestEl) {
  const chimeResult = playApplePaySuccessChime();
  const confettiResult = crestEl ? launchMicroConfetti(crestEl) : null;
  return { chime: chimeResult, confetti: confettiResult };
}

/**
 * Renders Tier-1 Digital Receipt Pass (Apple Wallet / Google Pay style)
 * @param {object} data
 * @returns {string} HTML string
 */
function renderFintechSuccessReceipt(data) {
  return `
    <div class="fintech-card success-card receipt-pass" role="region" aria-label="إيصال المعاملة المالية الناجحة">
      <button type="button" class="receipt-hero-crest" aria-label="عرض سجل المعاملات">
        <div class="crest-ripple-wave"></div>
        <div class="crest-icon-badge">
          <svg class="animated-check-svg" viewBox="0 0 52 52">
            <circle class="check-circle" cx="26" cy="26" r="23" fill="none"/>
            <path class="check-path" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
          </svg>
        </div>
      </button>

      <div class="receipt-hero-amount-wrap">
        <div class="receipt-hero-amount">
          <span class="amount-val">${escapeHtml(data.amount)}</span>
        </div>
        <div class="receipt-hero-sub">
          ${data.isBill ? 'تم تسديد الفاتورة بنجاح وتوثيقها' : 'تم التحويل المالي بنجاح وتحديث الرصيد'}
        </div>
      </div>

      <div class="receipt-ticket-divider" aria-hidden="true">
        <span class="notch notch-left"></span>
        <span class="ticket-dashed-line"></span>
        <span class="notch notch-right"></span>
      </div>

      <div class="fintech-spec-grid receipt-grid">
        <div class="spec-row">
          <span class="spec-label">${data.isBill ? 'الجهة المستفيدة' : 'المستلم'}</span>
          <span class="spec-value recipient-val">${escapeHtml(data.recipient)} ${data.subDetail ? `<span class="spec-sub">(${escapeHtml(data.subDetail)})</span>` : ''}</span>
        </div>
        ${data.phoneOrAccount ? `
        <div class="spec-row">
          <span class="spec-label">${data.isBill ? 'رقم الحساب' : 'رقم الهاتف'}</span>
          <span class="spec-value phone-val" dir="ltr">${escapeHtml(data.phoneOrAccount)}</span>
        </div>
        ` : ''}
        ${data.balanceAfter ? `
        <div class="spec-row">
          <span class="spec-label">الرصيد المتبقي</span>
          <span class="spec-value spec-balance-val highlight-balance">${escapeHtml(data.balanceAfter)}</span>
        </div>
        ` : ''}
        <div class="spec-row">
          <span class="spec-label">طريقة الدفع</span>
          <span class="spec-value">المحفظة الذكية (VI Wallet)</span>
        </div>
        <div class="spec-row">
          <span class="spec-label">حالة العملية</span>
          <span class="spec-value status-verified">مكتملة بنجاح ✓</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Generates dynamic initial letter for contact monogram avatar
 */
function getContactInitial(name) {
  if (!name) return '👤';
  const clean = name.replace(/^(الـ|ال)/, '').trim() || name.trim();
  return clean.charAt(0);
}

/**
 * Returns a consistent harmonious gradient for contact monogram
 */
function getContactGradient(name) {
  const gradients = [
    'linear-gradient(135deg, #10b981 0%, #059669 100%)',
    'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
    'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)',
    'linear-gradient(135deg, #ec4899 0%, #be185d 100%)',
    'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
    'linear-gradient(135deg, #06b6d4 0%, #0891b2 100%)',
    'linear-gradient(135deg, #6366f1 0%, #4338ca 100%)'
  ];
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % gradients.length;
  return gradients[idx];
}

/**
 * Parses contacts list response data from raw text
 */
function parseContactsListData(text) {
  if (!text) return null;
  const hasContactKeywords = text.includes('جهات الاتصال') || 
                             text.includes('جهات اتصال') || 
                             text.includes('قائمة اتصالي') || 
                             text.includes('قائمه اتصالي') || 
                             text.includes('الاشخاص اللي مسجلهم') ||
                             text.includes('الأسماء المسجلة') ||
                             text.includes('الاسماء المسجلة');
  const hasPhoneNumbers = /(?:\+?964\d{8,10}|07\d{8,9})/.test(text);

  if (!hasContactKeywords || !hasPhoneNumbers) return null;

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const contacts = [];
  let intro = '';
  let outro = '';

  for (const line of lines) {
    const match = line.match(/^(\d+)[\.\-–\)]\s*(.+)$/);
    if (match) {
      const rest = match[2].trim();
      let phone = '';
      let alias = '';
      let name = rest;

      const phoneMatch = rest.match(/\(?\s*(\+?964\d{8,10}|07\d{8,9})\s*\)?/);
      if (phoneMatch) {
        phone = phoneMatch[1].trim();
        name = name.replace(phoneMatch[0], '').trim();
      }

      const aliasMatch = name.match(/\(([^)]+)\)/);
      if (aliasMatch) {
        alias = aliasMatch[1].trim();
        name = name.replace(aliasMatch[0], '').trim();
      }

      name = name.replace(/^[•\s\-_()]+|[•\s\-_()]+$/g, '').trim();

      if (name && phone) {
        contacts.push({ num: match[1], name, alias, phone });
      }
    } else if (contacts.length === 0) {
      if (!intro) intro = line;
      else intro += ' ' + line;
    } else {
      if (!outro) outro = line;
      else outro += ' ' + line;
    }
  }

  if (contacts.length === 0) return null;
  return { intro, contacts, outro };
}

/**
 * Renders luxury Apple/Revolut-style contacts grid card
 */
function renderFintechContactsCard(data) {
  const { intro, contacts, outro } = data;
  return `
    <div class="fintech-card contacts-card" role="region" aria-label="قائمة جهات الاتصال المسجلة">
      <div class="contacts-card-header">
        <div class="contacts-header-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
            <circle cx="9" cy="7" r="4"></circle>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
          </svg>
        </div>
        <div class="contacts-header-text">
          <span class="contacts-header-title">${escapeHtml(intro || 'جهات الاتصال المسجلة بمحفظتك')}</span>
          <span class="contacts-header-count">${contacts.length} جهات مسجلة</span>
        </div>
      </div>

      <div class="fintech-contacts-carousel" role="list">
        ${contacts.map(c => `
          <div class="fintech-contact-item" role="listitem">
            <div class="contact-item-main">
              <div class="contact-monogram-avatar" style="background: ${getContactGradient(c.name)};" aria-hidden="true">
                <span>${escapeHtml(getContactInitial(c.name))}</span>
              </div>
              <div class="contact-item-info">
                <div class="contact-item-name-row">
                  <span class="contact-item-name">${escapeHtml(c.name)}</span>
                  ${c.alias ? `<span class="contact-item-alias">${escapeHtml(c.alias)}</span>` : ''}
                </div>
                <div class="contact-item-phone-row">
                  <span class="contact-item-phone" dir="ltr">${escapeHtml(c.phone)}</span>
                  <span class="contact-provider-chip">VI</span>
                </div>
              </div>
            </div>
            <button type="button" class="contact-quick-transfer-btn" data-contact-name="${escapeHtml(c.name)}" data-contact-phone="${escapeHtml(c.phone)}" aria-label="تحويل سريع إلى ${escapeHtml(c.name)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
              <span>تحويل</span>
            </button>
          </div>
        `).join('')}
      </div>

      ${outro ? `
      <div class="contacts-card-footer">
        <span class="contacts-footer-tip">${escapeHtml(outro)}</span>
      </div>
      ` : ''}
    </div>
  `;
}

/**
 * Parses ambiguous contact disambiguation response data
 */
function parseDisambiguationData(text) {
  if (!text || typeof text !== 'string') return null;
  const isAmbiguousPrompt = (text.includes('أكثر من جهة اتصال') || text.includes('اكثر من جهة اتصال')) &&
                            (text.includes('يا واحد منهم تقصد') || text.includes('يرجى كتابة الرقم') || text.includes('تقصد؟'));
  if (!isAmbiguousPrompt) return null;

  const nameMatch = text.match(/باسم\s*["']?([\u0621-\u064A\s]+?)["']?\s*بمحفظتك/);
  const name = nameMatch ? nameMatch[1].trim() : '';

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const options = [];
  let promptText = '';

  for (const line of lines) {
    const match = line.match(/^(\d+)[\.\-–\)]?\s+(.+)$/);
    if (match) {
      const num = match[1];
      const rest = match[2];
      let phone = '';
      let alias = '';
      let optName = rest;

      const phoneMatch = rest.match(/\(?\s*(\+?964\d{8,10}|07\d{8,9})\s*\)?/);
      if (phoneMatch) {
        phone = phoneMatch[1].trim();
        optName = optName.replace(phoneMatch[0], '').trim();
      }

      const aliasMatch = optName.match(/\(([^)]+)\)/);
      if (aliasMatch) {
        alias = aliasMatch[1].trim();
        optName = optName.replace(aliasMatch[0], '').trim();
      }

      optName = optName.replace(/^[•\s\-_()]+|[•\s\-_()]+$/g, '').trim();
      options.push({
        number: num,
        num: num,
        name: optName,
        subtitle: alias,
        alias: alias,
        phone: phone,
        raw: rest
      });
    } else if (options.length === 0) {
      if (!promptText) promptText = line;
      else promptText += ' ' + line;
    }
  }

  if (options.length >= 2) {
    return { name, promptText, options };
  }
  return null;
}

/**
 * Renders an interactive fintech disambiguation card with 1-tap contact buttons
 */
function renderDisambiguationCard(data) {
  if (!data || !Array.isArray(data.options)) return '';

  const optionsHtml = data.options.map(opt => {
    const initial = typeof getContactInitial === 'function' ? getContactInitial(opt.name) : opt.name.charAt(0);
    const grad = typeof getContactGradient === 'function' ? getContactGradient(opt.name) : 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
    const subtext = opt.subtitle || opt.alias || opt.phone || '';
    const choiceNum = opt.number || opt.num;

    return `
      <button type="button" class="disambiguation-option-btn" data-choice="${escapeHtml(choiceNum)}" data-choice-number="${escapeHtml(choiceNum)}" data-name="${escapeHtml(opt.name)}" aria-label="اختيار ${escapeHtml(opt.name)}">
        <span class="disambiguation-num-badge option-badge">${escapeHtml(choiceNum)}</span>
        <span class="disambiguation-avatar option-avatar" style="background: ${grad}">${escapeHtml(initial)}</span>
        <span class="disambiguation-info">
          <span class="disambiguation-name option-name">${escapeHtml(opt.name)}</span>
          ${subtext ? `<span class="disambiguation-subtext option-subtitle">${escapeHtml(subtext)}</span>` : ''}
        </span>
        ${opt.phone ? `<span class="disambiguation-phone option-phone">${escapeHtml(opt.phone)}</span>` : ''}
        <span class="disambiguation-action-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </span>
      </button>
    `;
  }).join('');

  return `
    <div class="fintech-disambiguation-card" role="region" aria-label="تحديد جهة الاتصال">
      <div class="disambiguation-header">
        <span class="disambiguation-header-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
            <circle cx="9" cy="7" r="4"></circle>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
          </svg>
        </span>
        <span class="disambiguation-header-text">${escapeHtml(data.promptText || 'اختر جهة الاتصال المطلوبة:')}</span>
      </div>
      <div class="disambiguation-options-grid">
        ${optionsHtml}
      </div>
      <div class="disambiguation-card-footer">
        <span>💡 اضغط على جهة الاتصال المطلوبة، أو اكتب رقمها (1 أو 2).</span>
      </div>
    </div>
  `;
}

/**
 * Formats fintech messages with rich badges, currency pills, visual transfer streams, and action cards
 * @param {string} text - Raw message string
 * @param {'user'|'ai'} sender - Sender type
 * @returns {string} - Styled HTML string
 */
function formatFintechMessage(text, sender) {
  if (sender === 'user') {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  // Check if this is an ambiguous contact disambiguation response (Tier-1 Interactive Disambiguation Card)
  const disambiguationData = parseDisambiguationData(text);
  if (disambiguationData) {
    return renderDisambiguationCard(disambiguationData);
  }

  // 1. Escape HTML first to prevent XSS
  let escaped = escapeHtml(text);

  // 2. Identify if this is a confirmation card or a success receipt card
  const isSuccess = escaped.includes('تم التحويل بنجاح') || 
                    escaped.includes('تم تأكيد التحويل بنجاح') || 
                    escaped.includes('تم تأكيد دفع') ||
                    (escaped.includes('✅') && (escaped.includes('تحويل') || escaped.includes('تسديد') || escaped.includes('دفع')));

  // Confirmation cards MUST contain actual financial transaction details AND confirmation intent
  const hasTransactionDetails = escaped.includes('تفاصيل التحويل') || 
                               escaped.includes('تفاصيل تسديد') || 
                               escaped.includes('تفاصيل دفع') || 
                               (escaped.includes('المستلم') && (escaped.includes('المبلغ') || escaped.includes('د.ع') || escaped.includes('IQD'))) ||
                               (escaped.includes('الفاتورة') && (escaped.includes('المبلغ') || escaped.includes('د.ع') || escaped.includes('IQD')));

  const hasConfirmIntent = escaped.includes('متأكد تريد') || 
                          escaped.includes('متأكد ترغب') ||
                          escaped.includes('هل تؤكد') || 
                          escaped.includes('هل انت متأكد') || 
                          escaped.includes('هل أنت متأكد') || 
                          escaped.includes('تأكيد عملية التحويل') || 
                          escaped.includes('تأكيد التحويل') ||
                          escaped.includes('تأكيد تسديد') ||
                          escaped.includes('تأكيد دفع') ||
                          escaped.includes('يرجى الرد بـ');

  const isConfirm = !isSuccess && hasTransactionDetails && hasConfirmIntent;

  // 3. Highlight currency amounts (e.g. 300,000,000 IQD or 50,000 دينار)
  escaped = escaped.replace(/(\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:IQD|دينار(?: عراقي)?|د\.ع)?)/gi, (match) => {
    if (/\d/.test(match) && (match.includes('IQD') || match.includes('دينار') || match.includes(',') || match.includes('د.ع'))) {
      return `<span class="amount-pill">${match.trim()}</span>`;
    }
    return match;
  });

  // 4. Format bullet points and numbered lists
  const lines = escaped.split('\n');
  const processedLines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
      const content = trimmed.substring(2);
      return `<div class="fintech-list-row"><span class="fintech-dot"></span><span>${content}</span></div>`;
    }
    const numMatch = trimmed.match(/^(\d+)\.\s*(.+)$/);
    if (numMatch) {
      return `<div class="fintech-list-row numbered"><span class="fintech-num-badge">${numMatch[1]}</span><span>${numMatch[2]}</span></div>`;
    }
    return line;
  });

  const joined = processedLines.join('<br>').replace(/(?:<br>)+(<div class="fintech-list-row)/g, '$1');

  if (isConfirm) {
    const data = parseFintechTransactionData(text, true, false);
    if (data.recipient || data.amount) {
      return renderFintechConfirmationCard(data);
    }
    const flowWidget = renderFintechFlowWidget(data);
    const actionsWidget = renderFintechActionButtons();
    return `<div class="fintech-card confirm-card">${flowWidget}${joined}${actionsWidget}</div>`;
  }

  if (isSuccess) {
    const data = parseFintechTransactionData(text, false, true);
    if (data.amount || data.recipient) {
      return renderFintechSuccessReceipt(data);
    }
    return `<div class="fintech-card success-card">${joined}</div>`;
  }

  // 5. Check if this is a contacts list response (Tier-1 Interactive Contacts Card)
  const contactsData = parseContactsListData(text);
  if (contactsData) {
    return renderFintechContactsCard(contactsData);
  }

  return joined;
}

/* ==========================================================================
   Section 30: Companion Rail for Desktop Workstation (Feature 6)
   ========================================================================== */
const COMPANION_RAIL_STORAGE_KEY = 'vi_companion_rail_collapsed';

let cachedCompanionContacts = [
  { name: 'أحمد كمال', alias: 'صديق الجامعة', phone: '+9647801122334' },
  { name: 'أم مصطفى', alias: 'الوالدة', phone: '+9647803344556' },
  { name: 'سيف الدين', alias: 'زميل العمل', phone: '+9647804455667' },
  { name: 'علاوي', alias: 'أخي', phone: '+9647709998877' },
  { name: 'مرتضى', alias: 'صديق العمل', phone: '+9647819919952' }
];

/**
 * Detects Iraqi fintech network provider from phone prefix or wallet metadata.
 * Prefixes:
 * - 078 / +96478 -> Zain Cash (زين كاش) - Emerald badge & dot
 * - 077 / +96477 -> AsiaPay (آسيا باي) - Violet badge & dot
 * - 075 / +96475 -> FastPay (فاست باي) - Cyan badge & dot
 * - Qi Card / كي كارد -> Qi Card - Amber/gold badge & dot
 * - Default -> VI Gold (فاي غولد) - Gold badge & dot
 * @param {Object|string} contactOrPhone
 * @returns {{ id: string, name: string, arabicName: string, color: string, badgeClass: string, dotClass: string }}
 */
function getIraqiFintechNetwork(contactOrPhone) {
  return {
    id: 'vi',
    name: 'VI Pay',
    arabicName: 'فاي باي',
    color: '#8b5cf6',
    badgeClass: 'network-badge-vi',
    dotClass: 'status-dot-violet'
  };
}

/**
 * Formats a date relative to a reference date with authentic Iraqi colloquial phrasing.
 * E.g.: 'آخر تحويل: اليوم', 'آخر تحويل: البارحة', 'قبل 4 أيام', 'جهة جديدة'.
 * @param {string|number|Date} dateInput
 * @param {Date} [referenceDate=new Date()]
 * @returns {string}
 */
function formatRelativeIraqiTimestamp(dateInput, referenceDate = new Date()) {
  if (!dateInput) return '';

  const ref = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  let d;
  if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())) {
    const parts = dateInput.trim().split('-');
    d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  } else {
    d = new Date(dateInput);
  }

  if (isNaN(d.getTime())) return '';

  const refDay = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
  const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((refDay - dDay) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    return 'آخر تحويل: اليوم';
  }
  if (diffDays === 1) {
    return 'آخر تحويل: البارحة';
  }
  if (diffDays === 2) {
    return 'قبل يومين';
  }
  if (diffDays >= 3 && diffDays <= 10) {
    return `قبل ${diffDays} أيام`;
  }
  if (diffDays > 10 && diffDays < 30) {
    return `قبل ${diffDays} يوماً`;
  }
  if (diffDays >= 30 && diffDays < 60) {
    return 'قبل شهر';
  }
  if (diffDays >= 60 && diffDays < 365) {
    return `قبل ${Math.floor(diffDays / 30)} أشهر`;
  }
  return 'قبل أكثر من سنة';
}

/**
 * Cross-references a contact with cached transactions to find the most recent transfer activity.
 * @param {Object} contact
 * @param {Array} [transactions]
 * @param {Date} [referenceDate=new Date()]
 * @returns {{ text: string, isNew: boolean, date?: string }}
 */
function getContactActivityTimestamp(contact, transactions = (typeof cachedTransactions !== 'undefined' ? cachedTransactions : []), referenceDate = new Date()) {
  if (!contact) return { text: 'جهة جديدة', isNew: true };

  const txList = Array.isArray(transactions) ? transactions : [];
  const rawContactPhone = contact.phone || '';
  const normContactPhone = String(rawContactPhone).replace(/\D/g, '').replace(/^(00964|964|0)/, '');
  const normContactName = (contact.name || '').trim().toLowerCase();

  const matchingTxs = txList.filter(trx => {
    if (!trx) return false;
    const isTransfer = (trx.type === 'TRANSFER' || trx.recipient || trx.phone);
    if (!isTransfer) return false;

    const rawTrxPhone = trx.phone || '';
    const normTrxPhone = String(rawTrxPhone).replace(/\D/g, '').replace(/^(00964|964|0)/, '');
    const normRecipient = (trx.recipient || '').trim().toLowerCase();

    // Check phone match
    if (normContactPhone && normTrxPhone) {
      if (normContactPhone === normTrxPhone || normContactPhone.endsWith(normTrxPhone) || normTrxPhone.endsWith(normContactPhone)) {
        return true;
      }
    }

    // Check name match
    if (normContactName && normRecipient) {
      if (normContactName === normRecipient || normContactName.includes(normRecipient) || normRecipient.includes(normContactName)) {
        return true;
      }
    }

    return false;
  });

  if (matchingTxs.length > 0) {
    // Sort descending by date
    matchingTxs.sort((a, b) => {
      const timeA = new Date(a.date).getTime() || 0;
      const timeB = new Date(b.date).getTime() || 0;
      return timeB - timeA;
    });

    const latest = matchingTxs[0];
    const text = formatRelativeIraqiTimestamp(latest.date, referenceDate);
    return {
      text,
      isNew: false,
      date: latest.date
    };
  }

  // Fallback to explicit contact lastTransferDate if provided
  if (contact.lastTransferDate || contact.last_transfer) {
    const text = formatRelativeIraqiTimestamp(contact.lastTransferDate || contact.last_transfer, referenceDate);
    return {
      text,
      isNew: false,
      date: contact.lastTransferDate || contact.last_transfer
    };
  }

  return { text: '', isNew: true };
}

function isCompanionRailCollapsed() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem) {
      return localStorage.getItem(COMPANION_RAIL_STORAGE_KEY) === 'true';
    }
  } catch (e) {}
  return false;
}

function setCompanionRailCollapsed(collapsed) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.setItem) {
      localStorage.setItem(COMPANION_RAIL_STORAGE_KEY, collapsed ? 'true' : 'false');
    }
  } catch (e) {}
  applyCompanionRailState(collapsed);
}

function applyCompanionRailState(collapsed) {
  if (typeof document === 'undefined') return;
  const appLayout = document.getElementById('app-layout');
  const rail = document.getElementById('companion-rail');
  const toggleBtn = document.getElementById('companion-rail-toggle');

  if (appLayout && appLayout.classList) {
    appLayout.classList.toggle('companion-collapsed', !!collapsed);
  }
  if (rail) {
    if (rail.classList) rail.classList.toggle('is-collapsed', !!collapsed);
    if (typeof rail.setAttribute === 'function') {
      rail.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
    }
  }
  if (toggleBtn) {
    if (toggleBtn.classList) toggleBtn.classList.toggle('is-collapsed', !!collapsed);
    if (typeof toggleBtn.setAttribute === 'function') {
      toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
  }
}

function toggleCompanionRail() {
  const currentlyCollapsed = isCompanionRailCollapsed();
  setCompanionRailCollapsed(!currentlyCollapsed);
  return !currentlyCollapsed;
}

function handleQuickContactTransfer(contactName, contactPhone = '', contactAlias = '') {
  if (!contactName || typeof document === 'undefined') return;
  const userInput = document.getElementById('user-input');
  if (userInput) {
    userInput.value = `أريد أحول لـ ${contactName} `;
    if (typeof updateInputState === 'function') {
      updateInputState();
    }
    if (typeof userInput.focus === 'function') {
      userInput.focus();
    }
    if (typeof userInput.selectionStart === 'number') {
      userInput.selectionStart = userInput.selectionEnd = userInput.value.length;
    }
  }
  if (typeof openQuickTransferModal === 'function') {
    openQuickTransferModal(contactName, contactPhone, contactAlias);
  }
}

let isShowingAllCompanionContacts = false;

/**
 * Renders sleek pulsating skeleton shimmer placeholders for companion contacts list
 * @param {number} count - Number of skeleton rows to render
 * @returns {string} The rendered HTML
 */
function renderCompanionContactsSkeleton(count = 4) {
  let html = '';
  for (let i = 0; i < count; i++) {
    const nameWidth = (i % 2 === 0) ? '65%' : '50%';
    html += `
      <div class="skeleton-contact-card" aria-hidden="true">
        <div class="companion-contact-lead" style="flex: 1; gap: 0.65rem;">
          <div class="skeleton-shimmer skeleton-contact-avatar"></div>
          <div class="companion-contact-info" style="flex: 1; gap: 5px;">
            <div class="skeleton-shimmer skeleton-line" style="width: ${nameWidth}; height: 12px;"></div>
            <div class="skeleton-shimmer skeleton-line" style="width: 40%; height: 9px;"></div>
          </div>
        </div>
        <div class="skeleton-shimmer skeleton-contact-btn"></div>
      </div>
    `;
  }
  if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
    const listEl = document.getElementById('companion-contacts-list');
    if (listEl) {
      listEl.innerHTML = html;
    }
  }
  return html;
}

function renderCompanionContacts() {
  if (typeof document === 'undefined') return;
  const listEl = document.getElementById('companion-contacts-list');
  const countEl = document.getElementById('companion-contacts-count');
  const moreBtn = document.getElementById('companion-contacts-more-btn');
  if (!listEl) return;

  const contacts = Array.isArray(cachedCompanionContacts) ? cachedCompanionContacts : [];
  if (countEl) {
    countEl.textContent = `${contacts.length} جهات`;
  }

  if (contacts.length === 0) {
    listEl.innerHTML = `<div class="companion-ledger-empty">لا توجد جهات اتصال مثبتة</div>`;
    if (moreBtn) moreBtn.style.display = 'none';
    return;
  }

  // Handle "المزيد" / "أقل" button visibility and label
  if (moreBtn) {
    if (contacts.length <= 4) {
      moreBtn.style.display = 'none';
    } else {
      moreBtn.style.display = 'flex';
      moreBtn.classList.toggle('is-expanded', !!isShowingAllCompanionContacts);
      moreBtn.setAttribute('aria-expanded', isShowingAllCompanionContacts ? 'true' : 'false');
      const labelSpan = moreBtn.querySelector('.more-label');
      if (labelSpan) {
        labelSpan.textContent = isShowingAllCompanionContacts ? 'عرض أقل' : 'المزيد';
      }
    }
  }

  const displayedContacts = (contacts.length > 4 && !isShowingAllCompanionContacts)
    ? contacts.slice(0, 4)
    : contacts;

  let html = '';
  for (const c of displayedContacts) {
    const name = escapeHtml(c.name || 'جهة اتصال');
    const alias = escapeHtml(c.alias || 'مسجل بالمحفظة');
    const phone = escapeHtml(c.phone || '');
    const initial = typeof getContactInitial === 'function' ? getContactInitial(c.name) : (c.name ? c.name[0] : 'ف');
    const gradient = typeof getContactGradient === 'function' ? getContactGradient(c.name) : 'linear-gradient(135deg, #059669, #06b6d4)';
    const network = typeof getIraqiFintechNetwork === 'function'
      ? getIraqiFintechNetwork(c)
      : { arabicName: 'فاي غولد', badgeClass: 'network-badge-vi', dotClass: 'status-dot-gold' };
    const activity = typeof getContactActivityTimestamp === 'function'
      ? getContactActivityTimestamp(c, cachedTransactions)
      : { text: 'جهة جديدة', isNew: true };

    html += `
      <div class="companion-contact-item" data-contact-name="${name}">
        <div class="companion-contact-lead">
          <div class="companion-contact-avatar" style="background: ${gradient}" aria-hidden="true">
            <span>${initial}</span>
            <span class="contact-status-dot ${network.dotClass}"></span>
          </div>
          <div class="companion-contact-info">
            <div class="companion-contact-name-row">
              <span class="companion-contact-name">${name}</span>
              <span class="contact-network-badge ${network.badgeClass}">${network.arabicName}</span>
            </div>
            <span class="companion-contact-alias">${alias}</span>
            ${activity && !activity.isNew && activity.text ? `
            <span class="companion-contact-timestamp">
              <svg class="timestamp-clock-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              <span>${activity.text}</span>
            </span>` : ''}
          </div>
        </div>
        <button type="button" class="companion-quick-transfer-btn" data-contact-name="${name}" data-contact-phone="${phone}" data-contact-alias="${alias}" aria-label="تحويل سريع إلى ${name}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="7" y1="17" x2="17" y2="7"></line>
            <polyline points="7 7 17 7 17 17"></polyline>
          </svg>
          <span>تحويل</span>
        </button>
      </div>
    `;
  }

  listEl.innerHTML = html;
}

/* ==========================================================================
   Section 31: Companion Rail Bills & Direct Payment Trigger
   ========================================================================== */
let cachedCompanionBills = [
  { id: 'bill_phone_01', biller: 'فاتورة خط الهاتف المحمول', account_number: '07801234567', amount: 25000, status: 'unpaid' },
  { id: 'bill_net_01', biller: 'فاتورة شبكة الإنترنت المنزلي (Fiber/4G)', account_number: 'NET-884920', amount: 40000, status: 'unpaid' },
  { id: 'bill_elec_01', biller: 'كهرباء الكرخ', account_number: '9812450012', amount: 50000, status: 'unpaid' },
  { id: 'bill_water_01', biller: 'مياه البصرة', account_number: '1234567899', amount: 35000, status: 'unpaid' }
];
let cachedBills = cachedCompanionBills;

let isShowingAllCompanionBills = false;

function getBillIconSvg(biller = '') {
  const norm = (biller || '').toLowerCase();
  if (norm.includes('انترنت') || norm.includes('net') || norm.includes('fiber') || norm.includes('واي فاي')) {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`;
  }
  if (norm.includes('خط') || norm.includes('هاتف') || norm.includes('موبايل') || norm.includes('phone') || norm.includes('زين')) {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>`;
  }
  if (norm.includes('كهرباء') || norm.includes('الكرخ') || norm.includes('power')) {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`;
  }
  if (norm.includes('مياه') || norm.includes('ماء') || norm.includes('البصرة') || norm.includes('water')) {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path></svg>`;
  }
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`;
}

/**
 * Renders sleek pulsating skeleton shimmer placeholders for companion bills cards
 * @param {number} count - Number of skeleton rows to render
 * @returns {string} The rendered HTML
 */
function renderCompanionBillsSkeleton(count = 3) {
  let html = '';
  for (let i = 0; i < count; i++) {
    const titleWidth = (i % 2 === 0) ? '70%' : '55%';
    html += `
      <div class="skeleton-bill-card" aria-hidden="true">
        <div class="companion-bill-lead" style="flex: 1; gap: 0.65rem;">
          <div class="skeleton-shimmer skeleton-bill-icon"></div>
          <div class="companion-bill-info" style="flex: 1; gap: 5px;">
            <div class="skeleton-shimmer skeleton-line" style="width: ${titleWidth}; height: 12px;"></div>
            <div class="skeleton-shimmer skeleton-line" style="width: 42%; height: 10px;"></div>
          </div>
        </div>
        <div class="skeleton-shimmer skeleton-bill-btn"></div>
      </div>
    `;
  }
  if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
    const listEl = document.getElementById('companion-bills-list');
    if (listEl) {
      listEl.innerHTML = html;
    }
  }
  return html;
}

function renderCompanionBills() {
  if (typeof document === 'undefined') return;
  const listEl = document.getElementById('companion-bills-list');
  const countEl = document.getElementById('companion-bills-count');
  const moreBtn = document.getElementById('companion-bills-more-btn');
  if (!listEl) return;

  const allBills = Array.isArray(cachedCompanionBills) ? cachedCompanionBills : [];
  const unpaidBills = allBills.filter(b => b.status === 'unpaid');

  if (countEl) {
    countEl.textContent = `${unpaidBills.length} فواتير`;
  }

  if (unpaidBills.length === 0) {
    listEl.innerHTML = `<div class="companion-ledger-empty">كل الفواتير مسددة بالكامل! ✅</div>`;
    if (moreBtn) moreBtn.style.display = 'none';
    return;
  }

  // Handle "المزيد" / "أقل" button visibility and label:
  // If unpaidBills.length <= 3, button is completely hidden (no contradiction!)
  // If > 3, show button toggling between 3 and all bills
  if (moreBtn) {
    if (unpaidBills.length <= 3) {
      moreBtn.style.display = 'none';
    } else {
      moreBtn.style.display = 'flex';
      moreBtn.classList.toggle('is-expanded', !!isShowingAllCompanionBills);
      moreBtn.setAttribute('aria-expanded', isShowingAllCompanionBills ? 'true' : 'false');
      const labelSpan = moreBtn.querySelector('.more-label');
      if (labelSpan) {
        labelSpan.textContent = isShowingAllCompanionBills ? 'عرض أقل' : 'المزيد';
      }
    }
  }

  const displayedBills = (unpaidBills.length > 3 && !isShowingAllCompanionBills)
    ? unpaidBills.slice(0, 3)
    : unpaidBills;

  let html = '';
  for (const b of displayedBills) {
    const title = escapeHtml(b.biller || 'فاتورة مستحقة');
    const account = escapeHtml(b.account_number || '');
    const amountFormatted = Number(b.amount || 0).toLocaleString('en-US');
    const iconSvg = getBillIconSvg(b.biller);

    html += `
      <div class="companion-bill-item" data-bill-id="${escapeHtml(b.id || '')}">
        <div class="companion-bill-lead">
          <div class="companion-bill-icon" aria-hidden="true">
            ${iconSvg}
          </div>
          <div class="companion-bill-info">
            <span class="companion-bill-title">${title}</span>
            <div class="companion-bill-amount-row">
              <span class="companion-bill-amount">${amountFormatted} د.ع</span>
              ${account ? `<span class="companion-bill-account">(${account})</span>` : ''}
            </div>
          </div>
        </div>
        <button type="button" class="companion-quick-pay-btn" data-bill-id="${escapeHtml(b.id || '')}" data-bill-name="${title}" aria-label="تسديد ${title}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>تسديد</span>
        </button>
      </div>
    `;
  }

  listEl.innerHTML = html;
}

function handleQuickBillPayment(billName) {
  if (!billName) return;
  const promptText = `أريد أسدد ${billName}`;
  handleFormSubmit(promptText);
}

async function fetchCompanionBills(showSkeleton = false) {
  if (typeof fetch !== 'function') return;
  if (showSkeleton || !cachedCompanionBills || cachedCompanionBills.length === 0) {
    renderCompanionBillsSkeleton(3);
  }
  try {
    const res = await fetch('/api/bills');
    if (!res.ok) return;
    const data = await res.json();
    if (data && Array.isArray(data.bills) && data.bills.length > 0) {
      cachedCompanionBills = data.bills;
      cachedBills = data.bills;
      renderCompanionBills();
      renderFintechPulse();
    }
  } catch (err) {
    // Non-blocking fallback
  }
}

function renderCompanionLedger() {
  if (typeof document === 'undefined') return;
  const listEl = document.getElementById('companion-ledger-list');
  if (!listEl) return;

  const trxs = (Array.isArray(cachedTransactions) ? cachedTransactions : []).slice(0, 3);
  if (trxs.length === 0) {
    listEl.innerHTML = `
      <div class="companion-ledger-empty">
        <span>لا توجد حركات مالية حديثة</span>
      </div>
    `;
    return;
  }

  let html = '';
  for (const trx of trxs) {
    const isTransfer = (trx.type === 'TRANSFER');
    const title = isTransfer
      ? `تحويل إلى ${escapeHtml(trx.recipient || 'مستلم')}`
      : `دفع: ${escapeHtml(trx.biller || 'فاتورة')}`;
    const dateFormatted = typeof formatArabicDate === 'function' ? formatArabicDate(trx.date) : (trx.date || 'اليوم');
    const iconClass = isTransfer ? 'transfer' : 'bill';

    const iconSvg = isTransfer
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`;

    html += `
      <div class="companion-ledger-item" data-id="${escapeHtml(trx.id || '')}">
        <div class="companion-ledger-lead">
          <div class="companion-ledger-icon ${iconClass}" aria-hidden="true">
            ${iconSvg}
          </div>
          <div class="companion-ledger-info">
            <span class="companion-ledger-title">${title}</span>
            <span class="companion-ledger-date">${dateFormatted}</span>
          </div>
        </div>
        <span class="companion-ledger-amount">- ${Number(trx.amount || 0).toLocaleString('en-US')} د.ع</span>
      </div>
    `;
  }

  listEl.innerHTML = html;
}

async function fetchCompanionContacts(showSkeleton = false) {
  if (typeof fetch !== 'function') return;
  if (showSkeleton || !cachedCompanionContacts || cachedCompanionContacts.length === 0) {
    renderCompanionContactsSkeleton(4);
  }
  try {
    const res = await fetch('/api/contacts');
    if (!res.ok) return;
    const data = await res.json();
    if (data && Array.isArray(data.contacts) && data.contacts.length > 0) {
      cachedCompanionContacts = data.contacts;
      renderCompanionContacts();
    }
  } catch (err) {
    // Non-blocking fallback to default contacts
  }
}

/* ==========================================================================
   Section 31.5: Fintech Pulse (نبض المحفظة) Visual Analytics & Micro-Donut
   ========================================================================== */
let activeFintechPulseSegment = 'balance'; // 'balance' | 'transfers' | 'bills'
let activeFintechPulsePerspective = 'expenses'; // 'expenses' | 'obligations'

function getFintechPulsePerspective() {
  return activeFintechPulsePerspective;
}

function setFintechPulsePerspective(perspective) {
  if (typeof playClickSound === 'function') {
    playClickSound();
  }
  activeFintechPulsePerspective = (perspective === 'obligations') ? 'obligations' : 'expenses';
  if (typeof document !== 'undefined' && document && typeof document.getElementById === 'function') {
    const expensesBtn = document.getElementById('pulse-mode-expenses-btn');
    const obligationsBtn = document.getElementById('pulse-mode-obligations-btn');
    const card = document.getElementById('companion-pulse-card');
    const actions = document.getElementById('pulse-obligations-actions');

    const isOblig = (activeFintechPulsePerspective === 'obligations');
    if (expensesBtn) {
      expensesBtn.classList.toggle('is-active', !isOblig);
      expensesBtn.setAttribute('aria-selected', !isOblig ? 'true' : 'false');
    }
    if (obligationsBtn) {
      obligationsBtn.classList.toggle('is-active', isOblig);
      obligationsBtn.setAttribute('aria-selected', isOblig ? 'true' : 'false');
    }
    if (card) {
      card.classList.toggle('is-obligations-mode', isOblig);
    }
    if (actions) {
      actions.classList.toggle('hidden', !isOblig);
    }
    renderFintechPulse();
  }
}

/**
 * Calculates distribution statistics and percentages for the Fintech Pulse widget (Expenses mode).
 * Segments:
 * 1. Bills Payment (دفع الفواتير)
 * 2. Transfers (التحويلات الشخصية)
 * 3. Remaining Balance (الرصيد المتبقي)
 */
function calculateFintechPulseData(transactions = cachedTransactions, balance = currentWalletBalance) {
  const trxs = Array.isArray(transactions) ? transactions : [];
  let billsSpent = 0;
  let transfersSpent = 0;

  for (const t of trxs) {
    const amt = Math.max(0, Number(t.amount || 0));
    if (t.type === 'TRANSFER' || t.recipient) {
      transfersSpent += amt;
    } else if (t.type === 'BILL' || t.type === 'BILL_PAYMENT' || t.biller) {
      billsSpent += amt;
    } else {
      billsSpent += amt;
    }
  }

  const currentBal = Math.max(0, Number(balance !== undefined && balance !== null ? balance : (typeof currentWalletBalance === 'number' ? currentWalletBalance : 3000000)));
  const totalPool = billsSpent + transfersSpent + currentBal;

  let billsPct = 0;
  let transfersPct = 0;
  let balancePct = 100;

  if (totalPool > 0) {
    billsPct = Math.round((billsSpent / totalPool) * 100);
    transfersPct = Math.round((transfersSpent / totalPool) * 100);
    balancePct = Math.max(0, 100 - billsPct - transfersPct);
  }

  const insightText = getFintechPulseInsight({
    billsSpent,
    transfersSpent,
    currentBal,
    totalPool,
    billsPct,
    transfersPct,
    balancePct
  }, 'expenses');

  return {
    perspective: 'expenses',
    billsSpent,
    transfersSpent,
    balance: currentBal,
    totalPool,
    billsPct,
    transfersPct,
    balancePct,
    insightText
  };
}

/**
 * Calculates obligations statistics from unpaid bills against current wallet balance
 * @param {Array} bills - List of bills to analyze (defaults to cachedBills / cachedCompanionBills)
 * @param {number} balance - User wallet balance
 * @returns {object} Obligations data model
 */
function calculateFintechPulseObligationsData(bills = (typeof cachedBills !== 'undefined' ? cachedBills : cachedCompanionBills), balance = currentWalletBalance) {
  const list = Array.isArray(bills) ? bills : (Array.isArray(cachedCompanionBills) ? cachedCompanionBills : []);
  const unpaidBills = list.filter(b => b && (b.status === 'unpaid' || !b.status));
  const totalObligations = unpaidBills.reduce((acc, b) => acc + Math.max(0, Number(b.amount || 0)), 0);
  const currentBal = Math.max(0, Number(balance !== undefined && balance !== null ? balance : (typeof currentWalletBalance === 'number' ? currentWalletBalance : 3000000)));

  let obligationsPct = 0;
  let freeBalancePct = 100;

  if (currentBal > 0) {
    obligationsPct = Math.min(100, Math.round((totalObligations / currentBal) * 100));
    freeBalancePct = Math.max(0, 100 - obligationsPct);
  } else if (totalObligations > 0) {
    obligationsPct = 100;
    freeBalancePct = 0;
  }

  const freeBalance = Math.max(0, currentBal - totalObligations);

  const insightText = getFintechPulseInsight({
    totalObligations,
    obligationsPct,
    freeBalance,
    freeBalancePct,
    currentBal,
    unpaidCount: unpaidBills.length,
    isObligations: true
  }, 'obligations');

  return {
    perspective: 'obligations',
    totalObligations,
    freeBalance,
    balance: currentBal,
    totalBase: currentBal,
    unpaidCount: unpaidBills.length,
    obligationsPct,
    freeBalancePct,
    unpaidBills,
    insightText
  };
}

/**
 * Returns a contextual, proactive Iraqi Arabic AI financial guidance tip
 */
function getFintechPulseInsight(data, perspective = (activeFintechPulsePerspective || 'expenses')) {
  if (!data) return 'عاشت إيدك! مصاريفك هذا الشهر أقل بـ 15% من الشهر الفات';

  // Obligations Mode Contextual Iraqi Insights
  if (perspective === 'obligations' || data.isObligations) {
    const totalDue = Number(data.totalObligations || 0);
    const pct = Number(data.obligationsPct || 0);
    const count = Number(data.unpaidCount || 0);

    if (totalDue === 0) {
      return 'عاشت إيدك! ما عندك أي فواتير مستحقة حالياً، التزاماتك مصفية كلها ومحد يطلبك فلس 🌟';
    }
    if (pct >= 50) {
      return `دير بالك! الفواتير المستحقة تطلب أكثر من نص رصيدك (${totalDue.toLocaleString('en-US')} د.ع)، سددها دفعة وحدة لتجنب تراكم الغرامات ⚠️`;
    }
    if (pct >= 25) {
      return `التزاماتك وفواتيرك المستحقة تشكل ${pct}% من رصيدك (${totalDue.toLocaleString('en-US')} د.ع)، الأفضل تسددها دفعة وحدة حتى تريح بالك! ⚡`;
    }
    return `عندك ${count > 0 ? count + ' فواتير مستحقة' : 'فواتير مستحقة'} بقيمة ${totalDue.toLocaleString('en-US')} د.ع (${pct}% من رصيدك)، سددهن هسة دفعة وحدة حتى تريح بالك! ⚡`;
  }

  // Existing Historical Expenses Insights (100% backward compatible)
  if (data.billsSpent === 0 && data.transfersSpent === 0) {
    return 'عاشت إيدك! رصيدك كامل ومصاريفك هذا الشهر أقل بـ 15% من الشهر الفات، ومحافظ على كامل رصيدك 💎';
  }

  if (data.balancePct >= 75) {
    return 'عاشت إيدك! مصاريفك هذا الشهر أقل بـ 15% من الشهر الفات، ومحافظ على نسبة أمان عالية 👏';
  }

  if (data.billsSpent > data.transfersSpent && data.billsPct >= 30) {
    return 'أغلب مصاريفك هالفترة راحت لتسديد فواتير أساسية، التزامك بالمواعيد ممتاز ⚡';
  }

  if (data.transfersSpent >= data.billsSpent && data.transfersPct >= 30) {
    return 'التحويلات المالية الشخصية تشكل النسبة الأكبر من مصاريفك، أمورك بالتمام 💸';
  }

  return 'عاشت إيدك! مصاريفك هذا الشهر متزنة وأقل بـ 15% من معدل الصرف المعتاد ✨';
}

function getFintechPulseActiveSegment() {
  return activeFintechPulseSegment;
}

function setFintechPulseActiveSegment(segment) {
  activeFintechPulseSegment = (segment === 'transfers' || segment === 'bills') ? segment : 'balance';
  if (typeof document !== 'undefined' && document && typeof document.getElementById === 'function') {
    renderFintechPulse();
  }
}

/**
 * Executes 1-tap settlement of all pending utility obligations
 */
function handlePayAllBillsAction() {
  if (typeof isRequestInProgress !== 'undefined' && isRequestInProgress) return;
  if (typeof playClickSound === 'function') {
    playClickSound();
  }
  const promptText = 'سدد كل الفواتير دفعة وحدة';
  const submitFn = (typeof module !== 'undefined' && module.exports && typeof module.exports.handleFormSubmit === 'function')
    ? module.exports.handleFormSubmit
    : (typeof handleFormSubmit === 'function' ? handleFormSubmit : null);
  if (typeof submitFn === 'function') {
    submitFn(promptText);
  }
}

/**
 * Renders the interactive SVG micro-donut chart and updates live percentages and insight badge
 */
function renderFintechPulse() {
  const isObligations = (activeFintechPulsePerspective === 'obligations');
  const data = isObligations ? calculateFintechPulseObligationsData() : calculateFintechPulseData();

  if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') {
    return data;
  }

  const segBalance = document.getElementById('pulse-seg-balance');
  const segTransfers = document.getElementById('pulse-seg-transfers');
  const segBills = document.getElementById('pulse-seg-bills');

  const centerPct = document.getElementById('pulse-center-pct');
  const centerLabel = document.getElementById('pulse-center-label');

  const pctBalance = document.getElementById('pulse-pct-balance');
  const amountBalance = document.getElementById('pulse-amount-balance');
  const pctTransfers = document.getElementById('pulse-pct-transfers');
  const amountTransfers = document.getElementById('pulse-amount-transfers');
  const pctBills = document.getElementById('pulse-pct-bills');
  const amountBills = document.getElementById('pulse-amount-bills');

  const titleBalance = document.getElementById('pulse-title-balance');
  const titleTransfers = document.getElementById('pulse-title-transfers');
  const titleBills = document.getElementById('pulse-title-bills');

  const insightEl = document.getElementById('pulse-ai-insight-text');
  const card = document.getElementById('companion-pulse-card');
  const obligationsActions = document.getElementById('pulse-obligations-actions');

  // SVG Donut Calculations (r=46, Circumference ≈ 289.03)
  const C = 289.0265;

  // Currency formatting helper
  const isUsd = (typeof activeCurrency !== 'undefined' && activeCurrency === 'USD');
  const formatAmt = (valIqd) => {
    if (isUsd) {
      const rate = (typeof iqdPerUsdRate === 'number' && iqdPerUsdRate > 0) ? iqdPerUsdRate : 1530;
      return `$${(valIqd / rate).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}`;
    }
    return `${Number(valIqd || 0).toLocaleString('en-US')} د.ع`;
  };

  if (isObligations) {
    // === OBLIGATIONS PERSPECTIVE ===
    if (card && card.classList) {
      if (typeof card.classList.toggle === 'function') {
        card.classList.toggle('is-obligations-mode', true);
      } else if (typeof card.classList.add === 'function') {
        card.classList.add('is-obligations-mode');
      }
    }
    if (obligationsActions && obligationsActions.classList) {
      const showActions = (data.totalObligations > 0);
      if (typeof obligationsActions.classList.toggle === 'function') {
        obligationsActions.classList.toggle('hidden', !showActions);
      } else if (showActions && typeof obligationsActions.classList.remove === 'function') {
        obligationsActions.classList.remove('hidden');
      } else if (!showActions && typeof obligationsActions.classList.add === 'function') {
        obligationsActions.classList.add('hidden');
      }
    }

    const lenObligations = (data.obligationsPct / 100) * C;
    const lenFree = (data.freeBalancePct / 100) * C;

    // In obligations mode, segBills represents the amber warning stroke (#f59e0b)
    if (segBills) {
      segBills.setAttribute('stroke', '#f59e0b');
      segBills.setAttribute('stroke-dasharray', `${lenObligations.toFixed(2)} ${(C - lenObligations).toFixed(2)}`);
      segBills.setAttribute('stroke-dashoffset', '0');
    }

    if (segBalance) {
      segBalance.setAttribute('stroke-dasharray', `${lenFree.toFixed(2)} ${(C - lenFree).toFixed(2)}`);
      segBalance.setAttribute('stroke-dashoffset', (-lenObligations).toFixed(2));
    }

    if (segTransfers) {
      segTransfers.setAttribute('stroke-dasharray', `0 ${C.toFixed(2)}`);
      segTransfers.setAttribute('stroke-dashoffset', '0');
    }

    // Center Donut
    if (centerPct) centerPct.textContent = `${data.obligationsPct}%`;
    if (centerLabel) centerLabel.textContent = 'نسبة الفواتير';

    // Legend Chips
    if (titleBalance) titleBalance.textContent = 'رصيد حر متبقي';
    if (pctBalance) pctBalance.textContent = `${data.freeBalancePct}%`;
    if (amountBalance) amountBalance.textContent = formatAmt(data.freeBalance);

    if (titleTransfers) titleTransfers.textContent = 'غير مدفوعة';
    if (pctTransfers) pctTransfers.textContent = `${data.unpaidCount}`;
    if (amountTransfers) amountTransfers.textContent = `${data.unpaidCount} فواتير`;

    if (titleBills) titleBills.textContent = 'فواتير مطلوبة';
    if (pctBills) pctBills.textContent = `${data.obligationsPct}%`;
    if (amountBills) amountBills.textContent = formatAmt(data.totalObligations);

    if (insightEl && data.insightText) {
      insightEl.textContent = data.insightText;
    }
  } else {
    // === HISTORICAL EXPENSES PERSPECTIVE ===
    if (card && card.classList) {
      if (typeof card.classList.toggle === 'function') {
        card.classList.toggle('is-obligations-mode', false);
      } else if (typeof card.classList.remove === 'function') {
        card.classList.remove('is-obligations-mode');
      }
    }
    if (obligationsActions && obligationsActions.classList) {
      if (typeof obligationsActions.classList.toggle === 'function') {
        obligationsActions.classList.toggle('hidden', true);
      } else if (typeof obligationsActions.classList.add === 'function') {
        obligationsActions.classList.add('hidden');
      }
    }

    const lenBalance = (data.balancePct / 100) * C;
    const lenTransfers = (data.transfersPct / 100) * C;
    const lenBills = (data.billsPct / 100) * C;

    if (segBalance) {
      segBalance.setAttribute('stroke-dasharray', `${lenBalance.toFixed(2)} ${(C - lenBalance).toFixed(2)}`);
      segBalance.setAttribute('stroke-dashoffset', '0');
    }

    if (segTransfers) {
      segTransfers.setAttribute('stroke-dasharray', `${lenTransfers.toFixed(2)} ${(C - lenTransfers).toFixed(2)}`);
      segTransfers.setAttribute('stroke-dashoffset', (-lenBalance).toFixed(2));
    }

    if (segBills) {
      segBills.setAttribute('stroke', 'url(#pulse-grad-bills)');
      segBills.setAttribute('stroke-dasharray', `${lenBills.toFixed(2)} ${(C - lenBills).toFixed(2)}`);
      segBills.setAttribute('stroke-dashoffset', (-(lenBalance + lenTransfers)).toFixed(2));
    }

    if (titleBalance) titleBalance.textContent = 'الرصيد المتاح';
    if (titleTransfers) titleTransfers.textContent = 'تحويلات مالية';
    if (titleBills) titleBills.textContent = 'دفع فواتير';

    // Update Legend Chips
    if (pctBalance) pctBalance.textContent = `${data.balancePct}%`;
    if (amountBalance) amountBalance.textContent = formatAmt(data.balance);

    if (pctTransfers) pctTransfers.textContent = `${data.transfersPct}%`;
    if (amountTransfers) amountTransfers.textContent = formatAmt(data.transfersSpent);

    if (pctBills) pctBills.textContent = `${data.billsPct}%`;
    if (amountBills) amountBills.textContent = formatAmt(data.billsSpent);

    // Update Center Donut according to active segment
    if (centerPct && centerLabel) {
      if (activeFintechPulseSegment === 'transfers') {
        centerPct.textContent = `${data.transfersPct}%`;
        centerLabel.textContent = 'التحويلات';
      } else if (activeFintechPulseSegment === 'bills') {
        centerPct.textContent = `${data.billsPct}%`;
        centerLabel.textContent = 'الفواتير';
      } else {
        centerPct.textContent = `${data.balancePct}%`;
        centerLabel.textContent = 'الرصيد المتاح';
      }
    }

    if (insightEl && data.insightText) {
      insightEl.textContent = data.insightText;
    }
  }

  // Synchronize active chip styles & segment highlights
  if (typeof document.querySelectorAll === 'function') {
    const chips = document.querySelectorAll('.pulse-legend-chip');
    chips.forEach((chip) => {
      const seg = chip.getAttribute('data-segment');
      if (seg === activeFintechPulseSegment) {
        chip.classList.add('is-active');
      } else {
        chip.classList.remove('is-active');
      }
    });

    const donutWrap = (typeof document.querySelector === 'function')
      ? document.querySelector('.pulse-donut-wrapper')
      : null;
    if (donutWrap && donutWrap.classList) {
      donutWrap.classList.toggle('has-highlight', !isObligations && activeFintechPulseSegment !== 'balance');
    }
  }

  [
    { el: segBalance, seg: 'balance' },
    { el: segTransfers, seg: 'transfers' },
    { el: segBills, seg: 'bills' }
  ].forEach(({ el, seg }) => {
    if (el && el.classList && typeof el.classList.toggle === 'function') {
      el.classList.toggle('is-highlighted', !isObligations && seg === activeFintechPulseSegment);
    }
  });

  return data;
}

/**
 * Initializes interactive listeners on the Fintech Pulse donut segments, perspective tabs, and action button
 */
function initFintechPulseInteractions() {
  if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return;

  // Perspective Toggle Buttons (المصروف الفعلي vs الالتزامات المستحقة)
  const expensesBtn = document.getElementById('pulse-mode-expenses-btn');
  const obligationsBtn = document.getElementById('pulse-mode-obligations-btn');
  const payAllBtn = document.getElementById('pulse-pay-all-btn');

  if (expensesBtn) {
    expensesBtn.addEventListener('click', (e) => {
      e.preventDefault();
      setFintechPulsePerspective('expenses');
    });
  }

  if (obligationsBtn) {
    obligationsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      setFintechPulsePerspective('obligations');
    });
  }

  if (payAllBtn) {
    payAllBtn.addEventListener('click', (e) => {
      e.preventDefault();
      handlePayAllBillsAction();
    });
  }

  if (typeof document.querySelectorAll === 'function') {
    const chips = document.querySelectorAll('.pulse-legend-chip');
    chips.forEach((chip) => {
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        const seg = chip.getAttribute('data-segment');
        if (seg) {
          setFintechPulseActiveSegment(seg);
        }
      });

      chip.addEventListener('mouseenter', () => {
        const seg = chip.getAttribute('data-segment');
        if (seg) {
          setFintechPulseActiveSegment(seg);
        }
      });
    });
  }

  // SVG segments interactivity
  const segMap = [
    { id: 'pulse-seg-balance', seg: 'balance' },
    { id: 'pulse-seg-transfers', seg: 'transfers' },
    { id: 'pulse-seg-bills', seg: 'bills' }
  ];

  segMap.forEach(({ id, seg }) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        setFintechPulseActiveSegment(seg);
      });
      el.addEventListener('mouseenter', () => {
        setFintechPulseActiveSegment(seg);
      });
    }
  });
}

/* ==========================================================================
   Section 32: Quick Transfer Wheel & Custom Amount Modal
   ========================================================================== */
let currentTransferContact = {
  name: 'أحمد كمال',
  alias: 'صديق الجامعة',
  phone: '+9647801122334'
};
let currentTransferAmount = 50000;

function updateQuickTransferTargetCard(contact) {
  if (typeof document === 'undefined' || !contact) return;
  const nameEl = document.getElementById('quick-transfer-name');
  const aliasEl = document.getElementById('quick-transfer-alias');
  const initialEl = document.getElementById('quick-transfer-avatar-initial');
  const avatarEl = document.getElementById('quick-transfer-avatar');
  const providerEl = document.getElementById('quick-transfer-provider');
  const statusDotEl = document.getElementById('quick-transfer-status-dot');
  const timestampEl = document.getElementById('quick-transfer-timestamp');

  const network = typeof getIraqiFintechNetwork === 'function'
    ? getIraqiFintechNetwork(contact)
    : { arabicName: 'فاي باي', badgeClass: 'network-badge-vi', dotClass: 'status-dot-violet' };

  if (nameEl) nameEl.textContent = contact.name;
  if (aliasEl) aliasEl.textContent = contact.alias || 'مسجل بالمحفظة';
  if (initialEl) initialEl.textContent = typeof getContactInitial === 'function' ? getContactInitial(contact.name) : (contact.name ? contact.name.charAt(0) : 'ف');
  if (avatarEl) avatarEl.style.background = typeof getContactGradient === 'function' ? getContactGradient(contact.name) : 'linear-gradient(135deg, #059669 0%, #06b6d4 100%)';

  if (providerEl) {
    providerEl.textContent = network.arabicName;
    providerEl.className = `quick-transfer-provider contact-network-badge ${network.badgeClass}`;
  }

  if (statusDotEl) {
    statusDotEl.className = `contact-status-dot ${network.dotClass}`;
  }

  if (timestampEl) {
    const activity = typeof getContactActivityTimestamp === 'function'
      ? getContactActivityTimestamp(contact, cachedTransactions)
      : { text: '', isNew: true };
    const showTs = activity && !activity.isNew && activity.text && activity.text !== 'جهة جديدة';
    if (!showTs) {
      timestampEl.style.display = 'none';
      const sep = document.querySelector('.quick-transfer-separator');
      if (sep) sep.style.display = 'none';
    } else {
      timestampEl.style.display = '';
      timestampEl.textContent = activity.text;
      timestampEl.className = 'quick-transfer-timestamp';
      const sep = document.querySelector('.quick-transfer-separator');
      if (sep) sep.style.display = '';
    }
  }
}

function getQuickTransferAvailableContacts() {
  const list = [];
  const seen = new Set();

  if (Array.isArray(cachedCompanionContacts)) {
    for (const c of cachedCompanionContacts) {
      if (c && c.name && !seen.has(c.name.trim())) {
        seen.add(c.name.trim());
        list.push({
          name: c.name.trim(),
          alias: c.alias || 'مسجل بالمحفظة',
          phone: c.phone || ''
        });
      }
    }
  }

  const defaults = [
    { name: 'أحمد كمال', alias: 'صديق الجامعة', phone: '+9647801122334' },
    { name: 'أم مصطفى', alias: 'الوالدة', phone: '+9647803344556' },
    { name: 'سيف الدين', alias: 'زميل العمل', phone: '+9647804455667' },
    { name: 'علاوي', alias: 'أخي', phone: '+9647709998877' },
    { name: 'مرتضى', alias: 'صديق العمل', phone: '+9647819919952' }
  ];

  for (const d of defaults) {
    if (!seen.has(d.name)) {
      seen.add(d.name);
      list.push(d);
    }
  }

  return list;
}

function renderQuickTransferContactPicker() {
  if (typeof document === 'undefined') return;
  const listEl = document.getElementById('quick-transfer-picker-list');
  if (!listEl) return;

  const contacts = getQuickTransferAvailableContacts();
  const currentName = currentTransferContact && currentTransferContact.name ? currentTransferContact.name.trim() : '';

  let html = '';
  contacts.forEach(c => {
    const isSelected = (c.name === currentName);
    const initial = typeof getContactInitial === 'function' ? getContactInitial(c.name) : (c.name ? c.name.charAt(0) : 'ف');
    const gradient = typeof getContactGradient === 'function' ? getContactGradient(c.name) : 'linear-gradient(135deg, #059669 0%, #06b6d4 100%)';
    const network = typeof getIraqiFintechNetwork === 'function'
      ? getIraqiFintechNetwork(c)
      : { arabicName: 'فاي باي', badgeClass: 'network-badge-vi', dotClass: 'status-dot-violet' };

    html += `
      <div class="qt-picker-item ${isSelected ? 'is-selected' : ''}" 
           role="option" 
           aria-selected="${isSelected ? 'true' : 'false'}"
           tabindex="0"
           data-contact-name="${escapeHtml(c.name)}"
           data-contact-phone="${escapeHtml(c.phone || '')}"
           data-contact-alias="${escapeHtml(c.alias || '')}">
        <div class="qt-picker-item-lead">
          <div class="qt-picker-avatar" style="background: ${gradient}" aria-hidden="true">
            <span>${initial}</span>
            <span class="contact-status-dot ${network.dotClass}"></span>
          </div>
          <div class="qt-picker-info">
            <span class="qt-picker-name">${escapeHtml(c.name)}</span>
            <span class="qt-picker-alias">${escapeHtml(c.alias)}</span>
          </div>
        </div>
        <div class="qt-picker-item-end">
          <span class="contact-network-badge ${network.badgeClass}">${network.arabicName}</span>
          ${isSelected ? `
            <span class="qt-picker-check-icon" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </span>
          ` : ''}
        </div>
      </div>
    `;
  });

  listEl.innerHTML = html;

  const items = listEl.querySelectorAll('.qt-picker-item');
  items.forEach(item => {
    const onSelect = () => {
      const name = item.getAttribute('data-contact-name');
      const phone = item.getAttribute('data-contact-phone');
      const alias = item.getAttribute('data-contact-alias');
      selectQuickTransferContact({ name, phone, alias });
    };

    item.addEventListener('click', onSelect);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect();
      }
    });
  });
}

function toggleQuickTransferContactPicker(forceOpen = null) {
  if (typeof document === 'undefined') return;
  const menu = document.getElementById('quick-transfer-picker-menu');
  const card = document.getElementById('quick-transfer-target-card');
  if (!menu || !card) return;

  const isCurrentlyOpen = !menu.classList.contains('hidden');
  const shouldOpen = (forceOpen !== null) ? forceOpen : !isCurrentlyOpen;

  if (shouldOpen) {
    renderQuickTransferContactPicker();
    menu.classList.remove('hidden');
    card.classList.add('is-open');
    card.setAttribute('aria-expanded', 'true');
    if (typeof playClickSound === 'function') playClickSound();
  } else {
    menu.classList.add('hidden');
    card.classList.remove('is-open');
    card.setAttribute('aria-expanded', 'false');
  }
}

function closeQuickTransferPicker() {
  toggleQuickTransferContactPicker(false);
}

function selectQuickTransferContact(contact) {
  if (!contact || !contact.name) return;
  currentTransferContact = {
    name: contact.name,
    phone: contact.phone || '',
    alias: contact.alias || ''
  };

  updateQuickTransferTargetCard(currentTransferContact);
  closeQuickTransferPicker();
  if (typeof playClickSound === 'function') playClickSound();

  const userInput = document.getElementById('user-input');
  if (userInput && userInput.value && userInput.value.startsWith('أريد أحول لـ')) {
    userInput.value = `أريد أحول لـ ${contact.name} `;
  }
}

function openQuickTransferModal(name, phone = '', alias = '', amount = null) {
  if (typeof document === 'undefined') return;

  let chosenName = name || 'أحمد كمال';
  let chosenPhone = phone || '';
  let chosenAlias = alias || '';

  if ((!chosenPhone || !chosenAlias) && chosenName) {
    const contacts = getQuickTransferAvailableContacts();
    const matched = contacts.find(c => c.name === chosenName.trim() || c.name.includes(chosenName.trim()) || chosenName.trim().includes(c.name));
    if (matched) {
      if (!chosenPhone) chosenPhone = matched.phone || '';
      if (!chosenAlias) chosenAlias = matched.alias || '';
    }
  }

  currentTransferContact = {
    name: chosenName,
    phone: chosenPhone,
    alias: chosenAlias
  };

  if (typeof amount === 'number' && amount > 0) {
    currentTransferAmount = amount;
  } else {
    currentTransferAmount = 50000;
  }

  const modal = document.getElementById('quick-transfer-modal');
  const backdrop = document.getElementById('quick-transfer-backdrop');
  const inputEl = document.getElementById('quick-transfer-amount-input');

  closeQuickTransferPicker();
  updateQuickTransferTargetCard(currentTransferContact);

  if (inputEl) {
    inputEl.value = (activeCurrency === 'USD')
      ? (currentTransferAmount / iqdPerUsdRate).toFixed(2)
      : Number(currentTransferAmount).toLocaleString('en-US');
  }

  updateCurrencyTogglePills();
  updateQuickTransferChips();
  updateQuickTransferInputVal();

  // Activate matching chip
  const chips = (typeof document.querySelectorAll === 'function')
    ? document.querySelectorAll('.amount-wheel-chip')
    : [];
  chips.forEach(chip => {
    if (chip && chip.getAttribute && chip.classList) {
      const chipAmt = parseInt(chip.getAttribute('data-amount'), 10);
      chip.classList.toggle('active', chipAmt === currentTransferAmount);
    }
  });

  if (modal) modal.classList.remove('hidden');
  if (backdrop) backdrop.classList.remove('hidden');

  if (typeof validateQuickTransferCeiling === 'function') {
    validateQuickTransferCeiling(currentTransferAmount);
  }

  // Scroll active chip into center view
  if (modal && typeof modal.querySelector === 'function') {
    const activeChip = modal.querySelector('.amount-wheel-chip.active');
    if (activeChip && typeof activeChip.scrollIntoView === 'function') {
      activeChip.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }
}

function closeQuickTransferModal() {
  if (typeof document === 'undefined') return;
  closeQuickTransferPicker();
  const modal = document.getElementById('quick-transfer-modal');
  const backdrop = document.getElementById('quick-transfer-backdrop');
  if (modal) modal.classList.add('hidden');
  if (backdrop) backdrop.classList.add('hidden');
}

function submitQuickTransfer() {
  if (!currentTransferContact || !currentTransferContact.name) {
    if (typeof playErrorThud === 'function') playErrorThud();
    return;
  }
  const inputEl = document.getElementById('quick-transfer-amount-input');
  let amountIqd = currentTransferAmount;
  if (inputEl) {
    const rawVal = inputEl.value.replace(/[^\d.]/g, '');
    const num = parseFloat(rawVal);
    if (!isNaN(num) && num > 0) {
      if (activeCurrency === 'USD') {
        amountIqd = Math.round(num * iqdPerUsdRate);
      } else {
        amountIqd = Math.round(num);
      }
    } else {
      if (typeof playErrorThud === 'function') playErrorThud();
      return;
    }
  }

  if (isNaN(amountIqd) || amountIqd <= 0) {
    if (typeof playErrorThud === 'function') playErrorThud();
    return;
  }

  if (typeof validateQuickTransferCeiling === 'function') {
    const ceilingCheck = validateQuickTransferCeiling(amountIqd);
    if (ceilingCheck.isExceeded) {
      if (typeof playErrorThud === 'function') playErrorThud();
      return;
    }
  }

  closeQuickTransferModal();

  // Always formulate in pristine IQD base currency for zero rounding loss in ledger
  const promptText = `أريد أحول ${amountIqd.toLocaleString('en-US')} دينار إلى ${currentTransferContact.name}`;
  handleFormSubmit(promptText);
}

function initQuickTransferModal() {
  if (typeof document === 'undefined') return;

  const closeBtn = document.getElementById('quick-transfer-close-btn');
  const cancelBtn = document.getElementById('quick-transfer-cancel-btn');
  const backdrop = document.getElementById('quick-transfer-backdrop');
  const submitBtn = document.getElementById('quick-transfer-submit-btn');
  const wheelTrack = document.getElementById('quick-transfer-wheel-track');
  const stepMinus = document.getElementById('amount-step-minus');
  const stepPlus = document.getElementById('amount-step-plus');
  const amountInput = document.getElementById('quick-transfer-amount-input');

  if (closeBtn) closeBtn.addEventListener('click', closeQuickTransferModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeQuickTransferModal);
  if (backdrop) backdrop.addEventListener('click', closeQuickTransferModal);

  // Contact Picker Interaction
  const targetCard = document.getElementById('quick-transfer-target-card');
  const targetWrapper = document.getElementById('quick-transfer-target-wrapper');

  if (targetCard) {
    targetCard.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleQuickTransferContactPicker();
    });

    targetCard.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleQuickTransferContactPicker();
      } else if (e.key === 'Escape') {
        closeQuickTransferPicker();
      }
    });
  }

  // Close contact picker on outside click
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('click', (e) => {
      if (targetWrapper && !targetWrapper.contains(e.target)) {
        closeQuickTransferPicker();
      }
    });
  }

  // Wheel chips click & continuous horizontal momentum drag-to-scroll
  if (wheelTrack) {
    let isDown = false;
    let startX = 0;
    let scrollLeftStart = 0;
    let hasDragged = false;
    let lastX = 0;
    let lastTime = 0;
    let velocity = 0;
    let momentumRaf = null;

    // Mouse-wheel horizontal panning
    wheelTrack.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0 || e.deltaX !== 0) {
        e.preventDefault();
        wheelTrack.scrollLeft += (e.deltaX || e.deltaY);
      }
    }, { passive: false });

    // Drag-to-scroll handling
    wheelTrack.addEventListener('mousedown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      isDown = true;
      hasDragged = false;
      wheelTrack.classList.add('is-dragging');
      startX = e.pageX || e.clientX;
      scrollLeftStart = wheelTrack.scrollLeft;
      lastX = startX;
      lastTime = Date.now();
      velocity = 0;
      if (momentumRaf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(momentumRaf);
      }
    });

    const onGlobalMouseMove = (e) => {
      if (!isDown) return;
      const currentX = e.pageX || e.clientX;
      const dist = currentX - startX;
      if (Math.abs(dist) > 5) {
        hasDragged = true;
      }
      wheelTrack.scrollLeft = scrollLeftStart - (dist * 1.15);

      const now = Date.now();
      const dt = now - lastTime;
      if (dt > 0) {
        velocity = (currentX - lastX) / dt;
      }
      lastX = currentX;
      lastTime = now;
    };

    const onGlobalMouseUp = () => {
      if (!isDown) return;
      isDown = false;
      wheelTrack.classList.remove('is-dragging');

      if (Math.abs(velocity) > 0.25 && typeof requestAnimationFrame === 'function') {
        let currentVel = velocity * 12;
        const glide = () => {
          if (Math.abs(currentVel) > 0.5) {
            wheelTrack.scrollLeft -= currentVel;
            currentVel *= 0.92;
            momentumRaf = requestAnimationFrame(glide);
          }
        };
        momentumRaf = requestAnimationFrame(glide);
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', onGlobalMouseMove);
      window.addEventListener('mouseup', onGlobalMouseUp);
    }

    wheelTrack.addEventListener('click', (e) => {
      if (hasDragged) {
        e.preventDefault();
        e.stopPropagation();
        hasDragged = false;
        return;
      }
      const chip = e.target.closest('.amount-wheel-chip');
      if (chip) {
        e.preventDefault();
        const amt = parseInt(chip.getAttribute('data-amount'), 10);
        if (!isNaN(amt)) {
          if (typeof playClickSound === 'function') {
            playClickSound();
          }
          currentTransferAmount = amt;
          if (amountInput) {
            amountInput.value = (activeCurrency === 'USD')
              ? (amt / iqdPerUsdRate).toFixed(2)
              : amt.toLocaleString('en-US');
          }
          updateQuickTransferInputVal();
          const chips = wheelTrack.querySelectorAll('.amount-wheel-chip');
          chips.forEach(c => c.classList.toggle('active', c === chip));
          if (typeof chip.scrollIntoView === 'function') {
            chip.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          }
        }
      }
    });
  }

  // Stepper buttons
  if (stepMinus) {
    stepMinus.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof playClickSound === 'function') {
        playClickSound();
      }
      currentTransferAmount = Math.max(250, currentTransferAmount - 5000);
      if (amountInput) {
        amountInput.value = (activeCurrency === 'USD')
          ? (currentTransferAmount / iqdPerUsdRate).toFixed(2)
          : currentTransferAmount.toLocaleString('en-US');
      }
      updateQuickTransferInputVal();
      syncWheelChips();
    });
  }

  if (stepPlus) {
    stepPlus.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof playClickSound === 'function') {
        playClickSound();
      }
      currentTransferAmount = currentTransferAmount + 5000;
      if (amountInput) {
        amountInput.value = (activeCurrency === 'USD')
          ? (currentTransferAmount / iqdPerUsdRate).toFixed(2)
          : currentTransferAmount.toLocaleString('en-US');
      }
      updateQuickTransferInputVal();
      syncWheelChips();
    });
  }

  // Input editing
  if (amountInput) {
    amountInput.addEventListener('input', () => {
      const rawVal = amountInput.value.replace(/[^\d.]/g, '');
      const num = parseFloat(rawVal);
      if (!isNaN(num) && num > 0) {
        if (activeCurrency === 'USD') {
          currentTransferAmount = Math.round(num * iqdPerUsdRate);
        } else {
          currentTransferAmount = Math.round(num);
        }
      }
      updateQuickTransferInputVal();
      syncWheelChips();
    });

    amountInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitQuickTransfer();
      }
    });
  }

  function syncWheelChips() {
    const chips = (typeof document.querySelectorAll === 'function')
      ? document.querySelectorAll('.amount-wheel-chip')
      : [];
    chips.forEach(c => {
      if (c && c.getAttribute && c.classList) {
        const amt = parseInt(c.getAttribute('data-amount'), 10);
        const isActive = (amt === currentTransferAmount);
        c.classList.toggle('active', isActive);
        if (isActive && typeof c.scrollIntoView === 'function') {
          c.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      }
    });
  }

  if (submitBtn) {
    submitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      submitQuickTransfer();
    });
  }
}

function initCompanionRail() {
  if (typeof document === 'undefined') return;

  const toggleBtn = document.getElementById('companion-rail-toggle');
  const closeBtn = document.getElementById('companion-rail-close-btn');
  const openDrawerBtn = document.getElementById('companion-open-drawer-btn');
  const contactsListEl = document.getElementById('companion-contacts-list');
  const moreBtn = document.getElementById('companion-contacts-more-btn');
  const billsListEl = document.getElementById('companion-bills-list');
  const billsMoreBtn = document.getElementById('companion-bills-more-btn');
  const ledgerListEl = document.getElementById('companion-ledger-list');

  // Load and apply initial state from localStorage
  const initialCollapsed = isCompanionRailCollapsed();
  applyCompanionRailState(initialCollapsed);

  if (toggleBtn) {
    toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleCompanionRail();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setCompanionRailCollapsed(true);
    });
  }

  if (openDrawerBtn) {
    openDrawerBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof openTransactionsDrawer === 'function') {
        openTransactionsDrawer();
      }
    });
  }

  // Toggle expanded contacts ("المزيد" / "أقل")
  if (moreBtn) {
    moreBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isShowingAllCompanionContacts = !isShowingAllCompanionContacts;
      renderCompanionContacts();
    });
  }

  // 1-Click transfer button & card click delegation
  if (contactsListEl) {
    contactsListEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.companion-quick-transfer-btn');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const contactName = btn.getAttribute('data-contact-name');
        const contactPhone = btn.getAttribute('data-contact-phone') || '';
        const contactAlias = btn.getAttribute('data-contact-alias') || '';
        if (contactName) {
          handleQuickContactTransfer(contactName, contactPhone, contactAlias);
        }
        return;
      }
      const item = e.target.closest('.companion-contact-item');
      if (item) {
        const contactName = item.getAttribute('data-contact-name');
        if (contactName) {
          const matchedContact = (Array.isArray(cachedCompanionContacts) ? cachedCompanionContacts : []).find(c => c.name === contactName);
          handleQuickContactTransfer(contactName, matchedContact?.phone || '', matchedContact?.alias || '');
        }
      }
    });
  }

  // Bills list click delegation -> triggers 1-click bill payment prompt
  if (billsListEl) {
    billsListEl.addEventListener('click', (e) => {
      const payBtn = e.target.closest('.companion-quick-pay-btn');
      if (payBtn) {
        e.preventDefault();
        e.stopPropagation();
        const billName = payBtn.getAttribute('data-bill-name');
        if (billName) {
          handleQuickBillPayment(billName);
        }
      }
    });
  }

  // Toggle expanded bills ("المزيد" / "أقل")
  if (billsMoreBtn) {
    billsMoreBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isShowingAllCompanionBills = !isShowingAllCompanionBills;
      renderCompanionBills();
    });
  }

  // Mini-ledger click delegation (fallback if ledger container exists)
  if (ledgerListEl) {
    ledgerListEl.addEventListener('click', (e) => {
      const item = e.target.closest('.companion-ledger-item');
      if (item && typeof openTransactionsDrawer === 'function') {
        openTransactionsDrawer();
      }
    });
  }

  // Initialize Quick Transfer Modal interactions
  initQuickTransferModal();

  // Render initial contacts and bills
  renderCompanionContacts();
  renderCompanionBills();
  renderCompanionLedger();
  renderFintechPulse();
  initFintechPulseInteractions();
  fetchCompanionContacts();
  fetchCompanionBills();

  // Auto-sync companion rail when window regains focus (e.g. user modified DB externally)
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => {
      fetchCompanionContacts();
      fetchCompanionBills();
      fetchAndRenderTransactions();
      syncWalletHeader();
    });
  }

  // Periodic passive sync every 15s when page is active
  if (typeof setInterval === 'function') {
    setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && !isRequestInProgress) {
        fetchCompanionContacts();
        fetchCompanionBills();
      }
    }, 15000);
  }
}

/* ==========================================================================
   Section 34: Lightweight Zero-Dependency Procedural Web Audio API Haptic Sound Synthesizer (ViHaptics)
   Zero external audio files, instant zero-latency harmonic soundscapes
   ========================================================================== */
const SOUND_EFFECTS_STORAGE_KEY = 'vi_sound_effects_enabled';
let soundEffectsEnabled = true;
let hapticAudioCtx = null;

function initSoundEffectsState() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = window.localStorage.getItem(SOUND_EFFECTS_STORAGE_KEY);
      if (stored === 'false') {
        soundEffectsEnabled = false;
      } else {
        soundEffectsEnabled = true;
      }
    }
  } catch (e) {
    soundEffectsEnabled = true;
  }
}
initSoundEffectsState();

function isSoundEffectsEnabled() {
  return soundEffectsEnabled;
}

function setSoundEffectsEnabled(enabled) {
  soundEffectsEnabled = Boolean(enabled);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(SOUND_EFFECTS_STORAGE_KEY, String(soundEffectsEnabled));
    }
  } catch (e) {}
  updateSoundEffectsUI();
  return soundEffectsEnabled;
}

function toggleSoundEffects() {
  const next = !soundEffectsEnabled;
  setSoundEffectsEnabled(next);
  if (next) {
    playClickSound();
  }
  return next;
}

function updateSoundEffectsUI() {
  if (typeof document === 'undefined') return;
  const btn = document.getElementById('haptic-sound-toggle-btn');
  const sw = document.getElementById('haptic-setting-switch');

  if (btn) {
    btn.setAttribute('aria-pressed', soundEffectsEnabled ? 'true' : 'false');
    btn.classList.toggle('is-muted', !soundEffectsEnabled);
    btn.classList.toggle('active', soundEffectsEnabled);
    const onIcon = btn.querySelector('.haptic-on');
    const offIcon = btn.querySelector('.haptic-off');
    if (onIcon) onIcon.classList.toggle('hidden', !soundEffectsEnabled);
    if (offIcon) offIcon.classList.toggle('hidden', soundEffectsEnabled);
  }

  if (sw) {
    sw.setAttribute('aria-checked', soundEffectsEnabled ? 'true' : 'false');
    sw.classList.toggle('active', soundEffectsEnabled);
  }
}

function getHapticAudioContext() {
  if (typeof window === 'undefined') return null;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;

  if (!hapticAudioCtx || hapticAudioCtx.state === 'closed' || (hapticAudioCtx.constructor !== AudioCtx)) {
    try {
      hapticAudioCtx = new AudioCtx();
    } catch (e) {
      return null;
    }
  }

  if (hapticAudioCtx && hapticAudioCtx.state === 'suspended' && typeof hapticAudioCtx.resume === 'function') {
    hapticAudioCtx.resume().catch(() => {});
  }

  return hapticAudioCtx;
}

/**
 * Procedural Apple-Pay-style ascending major chord (C5 - E5 - G5 - C6)
 * Synthesizes harmonic overtone crystal shimmer using exponential gain envelopes
 */
function playSuccessChime() {
  if (!isSoundEffectsEnabled()) return { played: false, reason: 'muted' };
  const ctx = getHapticAudioContext();
  if (!ctx) return { played: false, reason: 'no-audio-context' };

  const now = ctx.currentTime || 0;
  const notes = [
    { freq: 523.25, time: now, dur: 0.55, gain: 0.16, name: 'C5' },
    { freq: 659.25, time: now + 0.080, dur: 0.60, gain: 0.17, name: 'E5' },
    { freq: 783.99, time: now + 0.160, dur: 0.65, gain: 0.18, name: 'G5' },
    { freq: 1046.50, time: now + 0.240, dur: 0.85, gain: 0.22, name: 'C6' },
    { freq: 2093.00, time: now + 0.250, dur: 0.40, gain: 0.05, name: 'C7-shimmer' }
  ];

  notes.forEach(({ freq, time, dur, gain: peakGain }) => {
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, time);

      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.linearRampToValueAtTime(peakGain, time + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(time);
      osc.stop(time + dur + 0.05);
      osc.onended = () => {
        try { osc.disconnect(); gain.disconnect(); } catch (_) {}
      };
    } catch (_) {}
  });

  return { played: true, sound: 'success', notes };
}

/**
 * Crisp 8ms subtle micro-click for chips, buttons, and switches
 */
function playClickSound() {
  if (!isSoundEffectsEnabled()) return { played: false, reason: 'muted' };
  const ctx = getHapticAudioContext();
  if (!ctx) return { played: false, reason: 'no-audio-context' };

  const now = ctx.currentTime || 0;
  const dur = 0.008; // 8ms crisp micro-click

  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(2200, now);
    osc.frequency.exponentialRampToValueAtTime(1200, now + dur);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + dur + 0.01);
    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch (_) {}
    };
  } catch (_) {}

  return { played: true, sound: 'click', durationMs: 8 };
}

/**
 * Soft dual-tone thud on validation error (150 Hz & 110 Hz with decaying envelope)
 */
function playErrorThud() {
  if (!isSoundEffectsEnabled()) return { played: false, reason: 'muted' };
  const ctx = getHapticAudioContext();
  if (!ctx) return { played: false, reason: 'no-audio-context' };

  const now = ctx.currentTime || 0;
  const dur = 0.13; // 130ms soft physical thud
  const tones = [
    { freq: 150, gain: 0.16 },
    { freq: 110, gain: 0.14 }
  ];

  tones.forEach(({ freq, gain: peakGain }) => {
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.7, now + dur);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(peakGain, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + dur + 0.02);
      osc.onended = () => {
        try { osc.disconnect(); gain.disconnect(); } catch (_) {}
      };
    } catch (_) {}
  });

  return { played: true, sound: 'error', tones: [150, 110], durationMs: 130 };
}

function playToggleSound() {
  if (!isSoundEffectsEnabled()) return { played: false, reason: 'muted' };
  return playClickSound();
}

/**
 * Initializes listeners for the Haptic Sound synthesizer UI controls
 */
function initHaptics() {
  initSoundEffectsState();
  updateSoundEffectsUI();

  if (typeof document === 'undefined') return;

  const btn = document.getElementById('haptic-sound-toggle-btn');
  const sw = document.getElementById('haptic-setting-switch');

  if (btn) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSoundEffects();
    });
  }

  if (sw) {
    sw.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSoundEffects();
    });
  }
}

const ViHaptics = {
  playSuccessChime,
  playApplePaySuccessChime,
  playClickSound,
  playErrorThud,
  playToggleSound,
  isSoundEffectsEnabled,
  setSoundEffectsEnabled,
  toggleSoundEffects,
  initHaptics,
  getAudioContext: getHapticAudioContext,
  resetAudioContext: () => { hapticAudioCtx = null; }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    handleFormSubmit,
    sendMessageToBackend,
    setInputState,
    getOrCreateSessionId,
    getRequestInProgress: () => isRequestInProgress,
    setRequestInProgress: (val) => { isRequestInProgress = val; },
    formatFintechMessage,
    cleanTextForSpeech,
    getTtsEnabled: () => isTtsEnabled,
    setTtsEnabled: (val) => { isTtsEnabled = val; },
    getTtsSpeed: () => currentTtsSpeed,
    setTtsSpeed: (val) => { currentTtsSpeed = val; },
    getSelectedVoiceId: () => selectedVoiceId,
    setSelectedVoiceId: (val) => { selectedVoiceId = val; },
    streamTextMessage,
    stopSpeaking,
    speakText,
    finishActiveStream,
    createBotAvatarElement,
    getBotAvatarSrc,
    getBotFallbackAvatarUri,
    getContactInitial,
    getContactGradient,
    parseContactsListData,
    renderFintechContactsCard,
    applyTheme,
    toggleThemeWithRipple,
    playApplePaySuccessChime,
    launchMicroConfetti,
    triggerReceiptCelebration,
    getSharedAudioContext,
    updateAudioReactiveChromaticAura,
    resetAudioReactiveChromaticAura,
    COMPANION_RAIL_STORAGE_KEY,
    isCompanionRailCollapsed,
    setCompanionRailCollapsed,
    applyCompanionRailState,
    toggleCompanionRail,
    handleQuickContactTransfer,
    renderCompanionContacts,
    renderCompanionBills,
    renderCompanionLedger,
    fetchCompanionContacts,
    fetchCompanionBills,
    handleQuickBillPayment,
    openQuickTransferModal,
    closeQuickTransferModal,
    submitQuickTransfer,
    initQuickTransferModal,
    initCompanionRail,
    updateQuickTransferTargetCard,
    getQuickTransferAvailableContacts,
    renderQuickTransferContactPicker,
    toggleQuickTransferContactPicker,
    closeQuickTransferPicker,
    selectQuickTransferContact,
    getCurrentTransferContact: () => currentTransferContact,
    setCurrentTransferContact: (c) => { currentTransferContact = c; },
    getCachedCompanionContacts: () => cachedCompanionContacts,
    setCachedCompanionContacts: (val) => { cachedCompanionContacts = val; },
    getIsShowingAllCompanionContacts: () => isShowingAllCompanionContacts,
    setIsShowingAllCompanionContacts: (val) => { isShowingAllCompanionContacts = val; },
    getCachedCompanionBills: () => cachedCompanionBills,
    setCachedCompanionBills: (val) => { cachedCompanionBills = val; },
    getIsShowingAllCompanionBills: () => isShowingAllCompanionBills,
    setIsShowingAllCompanionBills: (val) => { isShowingAllCompanionBills = val; },
    getIraqiFintechNetwork,
    formatRelativeIraqiTimestamp,
    getContactActivityTimestamp,
    getCachedTransactions: () => cachedTransactions,
    setCachedTransactions: (val) => { cachedTransactions = val; },
    renderFintechActionButtons,
    renderConfirmationCard,
    renderFintechConfirmationCard,
    SLIDE_COMPLETION_THRESHOLD,
    parseAmountValue,
    isHighValueTransfer,
    initSlideToConfirm,
    executeSlideCompletion,
    startSlideDrag,
    onSlideDragMove,
    onSlideDragEnd,
    handleSlideKeyboard,
    getActiveCurrency,
    setActiveCurrency,
    toggleActiveCurrency,
    convertIqdToUsd,
    convertUsdToIqd,
    getExchangeRateValue,
    getExchangeRateConfig,
    setExchangeRateValue: (rate) => { iqdPerUsdRate = rate; if (typeof updateFxTickerTelemetry === 'function') updateFxTickerTelemetry(); },
    formatDualBalance,
    updateCurrencyTogglePills,
    updateQuickTransferChips,
    updateQuickTransferInputVal,
    validateQuickTransferCeiling,
    updateFxTickerTelemetry,
    syncFxCalculatorUsdToIqd,
    syncFxCalculatorIqdToUsd,
    toggleFxCalculatorPopover,
    handleFxPresetClick,
    handleFxTransferAction,
    initFxCalculator,
    initCurrencySwitch,
    fetchExchangeRate,
    renderTransactionsSkeleton,
    renderCompanionContactsSkeleton,
    renderCompanionBillsSkeleton,
    calculateFintechPulseData,
    calculateFintechPulseObligationsData,
    getFintechPulseInsight,
    renderFintechPulse,
    initFintechPulseInteractions,
    getFintechPulseActiveSegment,
    setFintechPulseActiveSegment,
    getFintechPulsePerspective,
    setFintechPulsePerspective,
    handlePayAllBillsAction,
    handleFormSubmit: (msg, opts) => (typeof handleFormSubmit === 'function' ? handleFormSubmit(msg, opts) : undefined),
    getCachedBills: () => (typeof cachedBills !== 'undefined' ? cachedBills : cachedCompanionBills),
    setCachedBills: (val) => { cachedBills = val; cachedCompanionBills = val; if (typeof renderFintechPulse === 'function') renderFintechPulse(); },
    parseDisambiguationData,
    renderDisambiguationCard,
    normalizeArabicKeywords,
    getContextualActionChips,
    appendActionChipsToMessage,
    handleBotActionChipClick,
    initBotActionChips,
    playTtsAudio,
    getTtsAudioContext,
    computeAudioRmsIntensity,
    resetSpeechIntensity,
    stopTtsAudioVisualizer,
    ViHaptics,
    playSuccessChime,
    playApplePaySuccessChime,
    playClickSound,
    playErrorThud,
    playToggleSound,
    isSoundEffectsEnabled,
    setSoundEffectsEnabled,
    toggleSoundEffects,
    initHaptics,
    getHapticAudioContext,
    resetAudioContext: () => { hapticAudioCtx = null; }
  };
}

