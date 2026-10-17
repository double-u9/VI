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
  const maxAllowedBars = Math.floor((width - 20) / step);
  let count = Math.min(55, Math.max(17, maxAllowedBars));
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

      const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
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
  window.dispatchEvent(new Event('resize'));
}

/**
 * Hides the voice recording bar and restores normal typing input form
 */
function hideVoiceBar() {
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
 * Returns the appropriate bot avatar image URL based on current active theme
 */
function getBotAvatarSrc() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  return currentTheme === 'light' ? 'assets/bot-violet.png' : 'assets/bot-emerald.png';
}

/**
 * Theme Management (Light White & Royal Violet <-> Dark Black & Emerald Green)
 */
function initThemeToggle() {
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const themeLabel = document.getElementById('theme-label-text');
  const badgeThemeText = document.getElementById('badge-theme-text');

  // Default theme is 'dark' (Emerald & Black as primary console look)
  const savedTheme = localStorage.getItem('fintech_theme') || 'dark';
  applyTheme(savedTheme);

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
      const targetTheme = currentTheme === 'light' ? 'dark' : 'light';
      applyTheme(targetTheme);
      localStorage.setItem('fintech_theme', targetTheme);
    });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.setAttribute('data-theme', theme);
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
      img.src = avatarSrc;
    });

    // Instantly update the centerpiece hero logo to match the theme (Emerald vs Violet)
    const heroLogoImg = document.getElementById('hero-logo-img');
    if (heroLogoImg) {
      heroLogoImg.src = theme === 'light' ? 'assets/logo-violet.png' : 'assets/logo-emerald.png';
    }

    // Instantly update resting voice visualizer theme colors
    drawRestingVoiceWaves();
  }
}

/**
 * Live Balance & Privacy Eye Toggle State
 * Default is hidden (isBalanceHidden = true) with stars per user requirement
 */
let currentWalletBalance = 3000000;
let isBalanceHidden = true;

/**
 * Updates the balance text and eye icon state in the header pill
 */
function renderWalletBalance() {
  const balanceEl = document.getElementById('wallet-balance-display');
  const eyeBtn = document.getElementById('wallet-eye-btn');
  if (!balanceEl) return;

  if (isBalanceHidden) {
    balanceEl.textContent = '*** IQD';
    if (eyeBtn) {
      eyeBtn.classList.add('is-hidden');
      eyeBtn.setAttribute('aria-label', 'إظهار الرصيد');
      eyeBtn.setAttribute('title', 'إظهار الرصيد');
    }
  } else {
    balanceEl.textContent = `${Number(currentWalletBalance).toLocaleString('en-US')} IQD`;
    if (eyeBtn) {
      eyeBtn.classList.remove('is-hidden');
      eyeBtn.setAttribute('aria-label', 'إخفاء الرصيد');
      eyeBtn.setAttribute('title', 'إخفاء الرصيد');
    }
  }
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
      renderWalletBalance();
    }
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
// Text-To-Speech (TTS) Voice Engine (Native Browser + ElevenLabs Hybrid)
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

let currentTtsAudio = null;
let activeTtsBtn = null;
let cachedSpeechVoices = [];

function loadTtsVoices() {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      cachedSpeechVoices = window.speechSynthesis.getVoices() || [];
    } catch (e) {
      cachedSpeechVoices = [];
    }
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
function getBestArabicVoice() {
  if (!cachedSpeechVoices || cachedSpeechVoices.length === 0) {
    loadTtsVoices();
  }
  if (!cachedSpeechVoices || cachedSpeechVoices.length === 0) return null;

  // 1. Exact Iraqi match
  let voice = cachedSpeechVoices.find(v => v.lang === 'ar-IQ' || v.lang === 'ar_IQ');
  if (voice) return voice;

  // 2. High-quality natural Arabic voices (Salma, Google, Microsoft Natural, Laila, Maged, Tarik)
  const premiumKeywords = ['salma', 'natural', 'google', 'shakir', 'maged', 'tarik', 'laila', 'arabic'];
  voice = cachedSpeechVoices.find(v => {
    const lang = (v.lang || '').toLowerCase();
    const name = (v.name || '').toLowerCase();
    return lang.startsWith('ar') && premiumKeywords.some(kw => name.includes(kw));
  });
  if (voice) return voice;

  // 3. Any available Arabic voice
  voice = cachedSpeechVoices.find(v => (v.lang || '').toLowerCase().startsWith('ar'));
  return voice || null;
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
 * Stops any active speech synthesis or audio playback immediately
 */
function stopSpeaking() {
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
}

/**
 * Speaks text using ElevenLabs backend streaming if available,
 * falling back effortlessly to browser SpeechSynthesis.
 * @param {string} text - Message text
 * @param {HTMLElement|null} btnElement - Optional replay button element to animate
 */
async function speakText(text, btnElement = null) {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return;
  if (typeof text !== 'string' || !text.trim()) return;
  const clean = cleanTextForSpeech(text);
  if (!clean) return;

  stopSpeaking();

  if (btnElement) {
    activeTtsBtn = btnElement;
    btnElement.classList.add('speaking');
  }
  const toggleBtn = document.getElementById('tts-toggle-btn');
  if (toggleBtn) {
    toggleBtn.classList.add('is-speaking');
  }

  // 1. Try Backend ElevenLabs endpoint
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean })
    });

    if (res.ok && res.headers.get('content-type')?.includes('audio')) {
      const audioBlob = await res.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      currentTtsAudio = audio;

      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        stopSpeaking();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(audioUrl);
        fallbackBrowserSpeak(clean, btnElement);
      };

      await audio.play();
      return;
    }
  } catch (err) {
    // If backend /api/tts fails or ElevenLabs is unconfigured, proceed to browser fallback
  }

  // 2. Zero-Config Browser Fallback
  fallbackBrowserSpeak(clean, btnElement);
}

/**
 * Native offline browser speech synthesizer fallback
 */
function fallbackBrowserSpeak(cleanText, btnElement = null) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    stopSpeaking();
    return;
  }

  try {
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'ar-IQ';
    const arabicVoice = getBestArabicVoice();
    if (arabicVoice) {
      utterance.voice = arabicVoice;
      utterance.lang = arabicVoice.lang;
    } else {
      console.warn('[TTS] No native Arabic voice installed on this system; skipping synthesis to prevent English accent distortion.');
      stopSpeaking();
      return;
    }

    utterance.rate = 1.0;
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
  btn.setAttribute('title', 'استمع للرد الصوتي');
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
 * Initializes the header TTS toggle button and synchronizes with localStorage
 */
function initTtsEngine() {
  const ttsToggleBtn = document.getElementById('tts-toggle-btn');
  if (!ttsToggleBtn) return;

  function updateTtsUi() {
    if (isTtsEnabled) {
      ttsToggleBtn.classList.add('active');
      ttsToggleBtn.classList.remove('muted');
      ttsToggleBtn.setAttribute('title', 'النطق الصوتي التلقائي (مفعل)');
      ttsToggleBtn.setAttribute('aria-label', 'النطق الصوتي التلقائي مفعل - اضغط للكتم');
    } else {
      ttsToggleBtn.classList.remove('active');
      ttsToggleBtn.classList.add('muted');
      ttsToggleBtn.setAttribute('title', 'النطق الصوتي التلقائي (مكتوم)');
      ttsToggleBtn.setAttribute('aria-label', 'النطق الصوتي التلقائي مكتوم - اضغط للتفعيل');
    }
  }

  updateTtsUi();

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
}

/**
 * Initialize event listeners and UI components on load
 */
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('DOMContentLoaded', () => {
    // Initialize Dynamic Halftone Dots Background
    initHalftoneBackground();

    // Initialize Theme Switcher (White & Violet / Black & Emerald)
    initThemeToggle();

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
async function handleFormSubmit(customMessage = null) {
  // 1. Synchronous in-flight guard: immediately reject if another submission is in progress
  if (isRequestInProgress) {
    console.warn('[Request Guard] Submission ignored: another request is currently in progress.');
    return;
  }

  let messageText = '';
  if (typeof customMessage === 'string' && customMessage.trim()) {
    messageText = customMessage.trim();
  } else {
    messageText = userInput.value.trim();
  }

  if (!messageText) return;

  // 2. Immediately lock state synchronously before ANY asynchronous operation or DOM transition
  isRequestInProgress = true;
  setInputState(false);

  // 3. Clear input & reset textarea height and send button state immediately
  userInput.value = '';
  updateInputState();

  // 4. If transitioning from welcome screen, wait for exit animation (~300ms) to finish cleanly
  const appLayout = document.getElementById('app-layout');
  const wasHero = appLayout && appLayout.classList.contains('hero-mode');
  if (wasHero) {
    await exitHeroMode();
  }

  // 5. Append User Message to UI (slides up smoothly from bottom with zero overlap)
  appendMessage(messageText, 'user');

  // 6. Scroll to bottom & Show typing indicator
  scrollToBottom();
  showTypingIndicator(true);

  try {
    const startTime = Date.now();

    // 7. Send POST request to Local Backend API
    const result = await sendMessageToBackend(messageText);
    const replyText = typeof result === 'object' ? result.text : result;

    // Natural deliberative thinking duration:
    // Ensure the wave animation is visible for at least ~1.35s
    // to give the impression of a thoughtful, calculating AI rather than an instant robotic snap
    const minThinkingMs = 1350;
    const elapsed = Date.now() - startTime;
    if (elapsed < minThinkingMs) {
      await new Promise(resolve => setTimeout(resolve, minThinkingMs - elapsed));
    }

    // Hide typing indicator right before showing AI response
    showTypingIndicator(false);

    // 8. Append AI Response (associated with the user query for accurate feedback logging)
    appendMessage(replyText, 'ai', messageText);

    // 9. Update live balance in header & sync transactions drawer
    syncWalletHeader();
    fetchAndRenderTransactions();

    // 10. Auto-open transactions drawer if the server flagged it (e.g. user asked for recent transactions)
    if (typeof result === 'object' && result.openDrawer) {
      setTimeout(() => {
        openTransactionsDrawer();
      }, 400);
    }
  } catch (error) {
    showTypingIndicator(false);
    console.error('Error communicating with AI agent:', error);
    // Render friendly error message if server is unreachable
    appendErrorMessage(
      `تعذر الاتصال بالخادم المحلي (${API_CONFIG.ENDPOINT}).\nيرجى التأكد من تشغيل خادم الـ Backend المحلي أو نموذج الذكاء الاصطناعي.`
    );
  } finally {
    // 11. Reliable cleanup path: unlock guard & restore controls after both successful and failed requests
    isRequestInProgress = false;
    showTypingIndicator(false);
    setInputState(true);
    scrollToBottom();
    if (userInput && typeof userInput.focus === 'function') {
      userInput.focus();
    }
  }
}

/**
 * Sends the user's message to the local backend API via fetch
 * @param {string} userMessage - Text entered by the user
 * @returns {Promise<{text: string, openDrawer: boolean}>} - Text generated by the AI and openDrawer flag
 */
async function sendMessageToBackend(userMessage) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_CONFIG.TIMEOUT_MS);
  const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
  const sessionId = getOrCreateSessionId();

  try {
    const response = await fetch(API_CONFIG.ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
        'X-Idempotency-Key': requestId,
        'X-Session-Id': sessionId
      },
      body: JSON.stringify({
        message: userMessage,
        provider: getSelectedModelProvider(),
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
        idempotency_key: requestId
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData.error || errorData.message || `خطأ في الخادم (HTTP ${response.status})`;
      throw new Error(errorMsg);
    }

    const data = await response.json();

    // Support common response payload formats: { response: "..." } or { reply: "..." } or { message: "..." }
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
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
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
function streamTextMessage(targetEl, fullText, onComplete) {
  if (!targetEl || !fullText) {
    if (typeof onComplete === 'function') onComplete();
    return;
  }

  // Hide global typing indicator as soon as streaming begins
  showTypingIndicator(false);

  let charIndex = 0;
  const len = fullText.length;
  // Dynamic step: fast and responsive (2 to 4 chars per 16ms frame)
  const step = len > 350 ? 4 : (len > 150 ? 3 : 2);
  const intervalMs = 15;

  targetEl.innerHTML = '<span class="streaming-text"></span><span class="streaming-cursor"></span>';
  const textSpan = (typeof targetEl.querySelector === 'function') ? targetEl.querySelector('.streaming-text') : null;

  const timer = setInterval(() => {
    if (typeof document === 'undefined') {
      clearInterval(timer);
      return;
    }
    charIndex += step;
    if (charIndex >= len) {
      charIndex = len;
      clearInterval(timer);
      if (typeof onComplete === 'function') {
        onComplete();
      }
      return;
    }

    const currentSlice = fullText.substring(0, charIndex);
    if (textSpan) {
      textSpan.innerHTML = escapeHtml(currentSlice).replace(/\n/g, '<br>');
    }
    scrollToBottom();
  }, intervalMs);
}

/**
 * Appends a message bubble to the chat container
 * @param {string} text - Message text
 * @param {'user'|'ai'} sender - Sender type
 * @param {string} relatedUserQuery - The user question that triggered this response (for feedback correlation)
 * @param {boolean} stream - Whether to stream the response with character-by-character animation
 */
function appendMessage(text, sender, relatedUserQuery = '', stream = true) {
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
    const avatarEl = document.createElement('div');
    avatarEl.classList.add('msg-avatar');
    const imgEl = document.createElement('img');
    imgEl.classList.add('avatar-img');
    imgEl.src = getBotAvatarSrc();
    imgEl.alt = 'المساعد المالي';
    avatarEl.appendChild(imgEl);
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
    if (sender === 'ai' && isTtsEnabled) {
      const speakBtn = (feedbackActions && typeof feedbackActions.querySelector === 'function')
        ? feedbackActions.querySelector('.message-speak-btn')
        : null;
      speakText(text, speakBtn);
    }
    return messageEl;
  }

  // Live streaming typewriter animation for AI responses
  streamTextMessage(bubbleEl, text, () => {
    bubbleEl.innerHTML = formatFintechMessage(text, 'ai');
    footerEl.style.opacity = '1';
    scrollToBottom();

    if (isTtsEnabled) {
      const speakBtn = (feedbackActions && typeof feedbackActions.querySelector === 'function')
        ? feedbackActions.querySelector('.message-speak-btn')
        : null;
      speakText(text, speakBtn);
    }
  });

  return messageEl;
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

  const avatarEl = document.createElement('div');
  avatarEl.classList.add('msg-avatar');
  const imgEl = document.createElement('img');
  imgEl.classList.add('avatar-img');
  imgEl.src = getBotAvatarSrc();
  imgEl.alt = 'المساعد المالي';
  avatarEl.appendChild(imgEl);

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
  const stopBtn = document.getElementById('voice-stop-btn');
  const sendVoiceBtn = document.getElementById('voice-send-btn');
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
}

/**
 * Automatically adjusts the textarea height based on content
 */
function autoResizeTextarea() {
  userInput.style.height = 'auto';
  userInput.style.height = `${Math.min(userInput.scrollHeight, 120)}px`;
}

/**
 * Smoothly scrolls the chat window to the bottom
 */
function scrollToBottom() {
  const rAF = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame : (cb) => setTimeout(cb, 0));
  rAF(() => {
    chatWindow.scrollTop = chatWindow.scrollHeight;
    setTimeout(() => {
      chatWindow.scrollTop = chatWindow.scrollHeight;
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
  const div = document.createElement('div');
  div.textContent = string;
  return typeof div.innerHTML === 'string' && div.innerHTML ? div.innerHTML : string
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Formats fintech messages with rich badges, currency pills, and cards
 * @param {string} text - Raw message string
 * @param {'user'|'ai'} sender - Sender type
 * @returns {string} - Styled HTML string
 */
function formatFintechMessage(text, sender) {
  if (sender === 'user') {
    return escapeHtml(text).replace(/\n/g, '<br>');
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
    return `<div class="fintech-card confirm-card">${joined}</div>`;
  }
  if (isSuccess) {
    return `<div class="fintech-card success-card">${joined}</div>`;
  }

  return joined;
}

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
    stopSpeaking,
    speakText
  };
}

