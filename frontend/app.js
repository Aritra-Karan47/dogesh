const storageKeys = {
  token: "dogesh.token",
  backend: "dogesh.backend",
};

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  mode: "login",
  token: localStorage.getItem(storageKeys.token) || "",
  history: [],
  setup: {
    voiceReady: false,
    keysReady: false,
    complete: false,
  },
  voice: {
    supported: !!SpeechRecognitionCtor,
    audioCaptureSupported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioContext),
    recognition: null,
    listening: false,
    manualListening: false,
    shouldListen: false,
    awaitingCommand: false,
    isSpeaking: false,
    enrollmentInProgress: false,
    enrollmentChunks: [],
    wakeWord: "hey dogesh",
    wakeCooldownUntil: 0,
    calibrationPhrase: "",
    awaitTimer: null,
  },
};

const el = {
  backendUrl: document.getElementById("backendUrl"),
  tabLogin: document.getElementById("tabLogin"),
  tabSignup: document.getElementById("tabSignup"),
  authForm: document.getElementById("authForm"),
  authButton: document.getElementById("authButton"),
  emailInput: document.getElementById("emailInput"),
  passwordInput: document.getElementById("passwordInput"),
  authState: document.getElementById("authState"),
  setupPanel: document.getElementById("setupPanel"),
  setupState: document.getElementById("setupState"),
  voiceSetupState: document.getElementById("voiceSetupState"),
  voiceTargetSentence: document.getElementById("voiceTargetSentence"),
  apiKeysState: document.getElementById("apiKeysState"),
  startVoiceSetupBtn: document.getElementById("startVoiceSetupBtn"),
  apiKeysForm: document.getElementById("apiKeysForm"),
  groqKeyInput: document.getElementById("groqKeyInput"),
  openrouterKeyInput: document.getElementById("openrouterKeyInput"),
  nvidiaKeyInput: document.getElementById("nvidiaKeyInput"),
  fireworksKeyInput: document.getElementById("fireworksKeyInput"),
  basetenKeyInput: document.getElementById("basetenKeyInput"),
  saveKeysBtn: document.getElementById("saveKeysBtn"),
  voiceState: document.getElementById("voiceState"),
  logoutBtn: document.getElementById("logoutBtn"),
  clearBtn: document.getElementById("clearBtn"),
  messages: document.getElementById("messages"),
  chatForm: document.getElementById("chatForm"),
  queryInput: document.getElementById("queryInput"),
  micBtn: document.getElementById("micBtn"),
  sendBtn: document.getElementById("sendBtn"),
};

function backendBase() {
  const url = (el.backendUrl.value || "").trim().replace(/\/$/, "");
  return url || "http://127.0.0.1:8000";
}

function setMode(mode) {
  state.mode = mode;
  const isLogin = mode === "login";
  el.tabLogin.classList.toggle("active", isLogin);
  el.tabSignup.classList.toggle("active", !isLogin);
  el.authButton.textContent = isLogin ? "Login" : "Signup";
}

function setVoiceState(text) {
  el.voiceState.textContent = text;
}

function resetSetupState() {
  state.setup.voiceReady = false;
  state.setup.keysReady = false;
  state.setup.complete = false;
  state.voice.awaitingCommand = false;
  state.voice.enrollmentInProgress = false;
  state.voice.enrollmentChunks = [];
  state.voice.calibrationPhrase = "Say Dogesh five times";
  if (state.voice.awaitTimer) {
    clearTimeout(state.voice.awaitTimer);
    state.voice.awaitTimer = null;
  }
  el.voiceTargetSentence.textContent = 'Calibration phrase: Say "Dogesh" at least once.';
}

function updateUiGates() {
  const isAuthed = Boolean(state.token);
  el.setupPanel.classList.toggle("hidden", !isAuthed);

  const chatEnabled = isAuthed && state.setup.complete;
  el.queryInput.disabled = !chatEnabled;
  el.sendBtn.disabled = !chatEnabled;
  el.micBtn.disabled = !chatEnabled;
  if (!isAuthed) {
    el.setupState.textContent = "Login required";
    el.voiceSetupState.textContent = "Not started";
    el.apiKeysState.textContent = "Required";
    setVoiceState("Voice idle");
  } else if (state.setup.complete) {
    el.setupState.textContent = "Setup complete";
  } else {
    el.setupState.textContent = "Setup incomplete";
  }
}

function toWords(text) {
  return normalizeText(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .map((word) => word.trim())
    .filter(Boolean);
}

function dogeshCount(heard) {
  const normalized = normalizeText(heard)
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return 0;
  }

  // Normalize common ASR variants for the word "Dogesh".
  const canonical = normalized
    .replace(/\bdo\s+gesh\b/g, "dogesh")
    .replace(/\bdoge\s+sh\b/g, "dogesh")
    .replace(/\bdogish\b/g, "dogesh")
    .replace(/\bdagesh\b/g, "dogesh")
    .replace(/\bdogash\b/g, "dogesh")
    .replace(/\bdoges\b/g, "dogesh")
    .replace(/\bdogeshh\b/g, "dogesh");

  const tokens = canonical.split(" ").filter(Boolean);
  let count = 0;
  for (const token of tokens) {
    if (token === "dogesh") {
      count += 1;
      continue;
    }

    // Extra fuzzy fallback: accept close one-word recognitions beginning with "dog".
    if (token.startsWith("dog") && token.length >= 4) {
      count += 1;
    }
  }

  return count;
}

function normalizeForWake(text) {
  return normalizeText(text).replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

function containsWakeWord(text) {
  const t = normalizeForWake(text);
  return (
    t.includes("hey dogesh") ||
    t.includes("hi dogesh") ||
    t.includes("hey doge sh") ||
    t.includes("hey dogish")
  );
}

function setAuth(token) {
  state.token = token || "";
  if (state.token) {
    localStorage.setItem(storageKeys.token, state.token);
    el.authState.textContent = "Authenticated";
  } else {
    localStorage.removeItem(storageKeys.token);
    el.authState.textContent = "Not authenticated";
  }
  updateUiGates();
}

function addMessage(kind, text) {
  const bubble = document.createElement("div");
  bubble.className = `msg ${kind}`;
  bubble.textContent = text;
  el.messages.appendChild(bubble);
  el.messages.scrollTop = el.messages.scrollHeight;
}

async function callApi(path, options = {}, requiresAuth = false) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (requiresAuth) {
    if (!state.token) {
      throw new Error("You must login first.");
    }
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(`${backendBase()}${path}`, {
    ...options,
    headers,
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = body?.detail || `Request failed (${response.status})`;
    throw new Error(detail);
  }

  return body;
}

async function recordAudioBlob(durationMs) {
  if (!state.voice.audioCaptureSupported) {
    throw new Error("Audio recording is not supported in this browser.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const samples = [];

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    samples.push(new Float32Array(input));
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  await new Promise((resolve) => window.setTimeout(resolve, durationMs));

  source.disconnect();
  processor.disconnect();
  await audioContext.close();
  stream.getTracks().forEach((track) => track.stop());

  let totalLength = 0;
  for (const chunk of samples) {
    totalLength += chunk.length;
  }

  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of samples) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  const wavBuffer = encodeWav(merged, audioContext.sampleRate);
  return new Blob([wavBuffer], { type: "audio/wav" });
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset, text) {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  function floatTo16BitPCM(offset, input) {
    for (let i = 0; i < input.length; i += 1) {
      const s = Math.max(-1, Math.min(1, input[i]));
      view.setInt16(offset + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  floatTo16BitPCM(44, samples);

  return buffer;
}

async function transcribeAudioBlob(blob) {
  const formData = new FormData();
  formData.append("file", blob, "speech.webm");

  const headers = {};
  if (!state.token) {
    throw new Error("You must login first.");
  }
  headers.Authorization = `Bearer ${state.token}`;

  const response = await fetch(`${backendBase()}/assistant/transcribe`, {
    method: "POST",
    headers,
    body: formData,
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.detail || `Transcription failed (${response.status})`);
  }

  return (body?.text || "").trim();
}

function normalizeText(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function extractWakeCommand(raw) {
  const normalized = normalizeForWake(raw);
  const candidates = ["hey dogesh", "hi dogesh", "hey doge sh", "hey dogish"];
  let idx = -1;
  let match = "";
  for (const candidate of candidates) {
    const found = normalized.indexOf(candidate);
    if (found >= 0 && (idx < 0 || found < idx)) {
      idx = found;
      match = candidate;
    }
  }
  if (idx < 0) {
    return "";
  }
  const after = normalized.slice(idx + match.length).trim();
  return after.replace(/^[,.:;!?-]+\s*/, "").trim();
}

function stopWakeWordListening() {
  if (!state.voice.recognition || !state.voice.listening) {
    return;
  }
  state.voice.listening = false;
  try {
    state.voice.recognition.stop();
  } catch (_) {
    // Ignore stop races from the browser API.
  }
}

function ensureWakeWordListening() {
  if (!state.voice.supported || !state.setup.complete || !state.voice.shouldListen || state.voice.isSpeaking) {
    return;
  }
  if (!state.voice.recognition) {
    state.voice.recognition = new SpeechRecognitionCtor();
    state.voice.recognition.lang = "en-US";
    state.voice.recognition.continuous = true;
    state.voice.recognition.interimResults = true;

    state.voice.recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript || "";
        const cleaned = normalizeText(transcript);
        if (!cleaned) {
          continue;
        }

        const isFinal = event.results[i].isFinal;

        if (state.voice.awaitingCommand) {
          if (!isFinal) {
            continue;
          }
          state.voice.awaitingCommand = false;
          if (state.voice.awaitTimer) {
            clearTimeout(state.voice.awaitTimer);
            state.voice.awaitTimer = null;
          }
          sendAssistantQuery(cleaned, true);
          return;
        }

        if (containsWakeWord(cleaned)) {
          const now = Date.now();
          if (now < state.voice.wakeCooldownUntil) {
            continue;
          }
          state.voice.wakeCooldownUntil = now + 2500;

          const immediateCommand = extractWakeCommand(cleaned);
          if (immediateCommand) {
            sendAssistantQuery(immediateCommand, true);
            return;
          }

          state.voice.awaitingCommand = true;
          addMessage("assistant", "Wake word detected. Listening for your question...");
          setVoiceState("Wake word heard");
          state.voice.awaitTimer = window.setTimeout(() => {
            state.voice.awaitingCommand = false;
            addMessage("assistant", "I did not catch that. Say 'Hey Dogesh' again.");
            setVoiceState("Listening for Hey Dogesh");
          }, 7000);
          return;
        }
      }
    };

    state.voice.recognition.onend = () => {
      state.voice.listening = false;
      if (state.voice.shouldListen && !state.voice.isSpeaking && state.setup.complete) {
        ensureWakeWordListening();
      }
    };

    state.voice.recognition.onerror = () => {
      state.voice.listening = false;
      if (state.voice.shouldListen && !state.voice.isSpeaking && state.setup.complete) {
        ensureWakeWordListening();
      }
    };
  }

  if (state.voice.listening) {
    return;
  }

  try {
    state.voice.recognition.start();
    state.voice.listening = true;
    setVoiceState("Listening for Hey Dogesh");
  } catch (_) {
    // Ignore overlapping start calls.
  }
}

function speakResponse(text) {
  if (!("speechSynthesis" in window) || !text) {
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.onstart = () => {
    state.voice.isSpeaking = true;
    stopWakeWordListening();
    setVoiceState("Speaking response");
  };
  utterance.onend = () => {
    state.voice.isSpeaking = false;
    ensureWakeWordListening();
  };
  utterance.onerror = () => {
    state.voice.isSpeaking = false;
    ensureWakeWordListening();
  };

  window.speechSynthesis.speak(utterance);
}

function startManualMicCapture() {
  if (!state.voice.audioCaptureSupported) {
    addMessage("error", "Manual mic capture is not supported in this browser.");
    return;
  }
  if (state.voice.manualListening) {
    return;
  }

  stopWakeWordListening();
  state.voice.manualListening = true;
  el.micBtn.classList.add("active");
  setVoiceState("Manual dictation active");

  (async () => {
    try {
      const audioBlob = await recordAudioBlob(5000);
      const transcript = await transcribeAudioBlob(audioBlob);
      el.queryInput.value = transcript;
      if (transcript) {
        await sendAssistantQuery(transcript, true);
        el.queryInput.value = "";
      } else {
        addMessage("assistant", "No speech detected from mic input.");
      }
    } catch (error) {
      addMessage("error", error.message || "Manual dictation failed.");
    } finally {
      state.voice.manualListening = false;
      el.micBtn.classList.remove("active");
      setVoiceState(state.setup.complete ? "Listening for Hey Dogesh" : "Voice idle");
      ensureWakeWordListening();
    }
  })();
}

async function sendAssistantQuery(text, fromVoice = false) {
  const prompt = (text || "").trim();
  if (!prompt) {
    return;
  }

  addMessage("user", fromVoice ? `[voice] ${prompt}` : prompt);
  el.sendBtn.disabled = true;

  try {
    const data = await callApi(
      "/assistant/query",
      {
        method: "POST",
        body: JSON.stringify({
          text: prompt,
          history: state.history,
        }),
      },
      true
    );

    const responseText = data.response_text || "No response text.";
    addMessage("assistant", responseText);
    speakResponse(responseText);

    state.history.push({ role: "user", content: prompt });
    state.history.push({ role: "assistant", content: responseText });

    if (data.action === "open_browser" && data.action_data?.url) {
      addMessage("assistant", `Suggested action URL: ${data.action_data.url}`);
    }
  } catch (error) {
    addMessage("error", error.message);
  } finally {
    if (state.setup.complete) {
      el.sendBtn.disabled = false;
    }
  }
}

async function completeSetupIfReady() {
  if (!state.setup.voiceReady || !state.setup.keysReady || state.setup.complete) {
    updateUiGates();
    return;
  }

  state.setup.complete = true;
  state.voice.shouldListen = true;
  addMessage("assistant", "Setup complete. Say 'Hey Dogesh' and continue asking questions naturally.");
  updateUiGates();
  ensureWakeWordListening();
}

async function runVoiceEnrollment(autoTriggered = false) {
  if (!state.token) {
    return;
  }
  if (!state.voice.audioCaptureSupported) {
    addMessage("error", "This browser does not support audio recording for voice setup.");
    return;
  }
  if (state.voice.enrollmentInProgress || state.setup.voiceReady) {
    return;
  }

  state.voice.enrollmentInProgress = true;
  el.startVoiceSetupBtn.disabled = true;
  state.voice.calibrationPhrase = "Say Dogesh at least once";
  el.voiceTargetSentence.textContent = 'Calibration phrase: Say "Dogesh" at least once.';
  el.voiceSetupState.textContent = "Recording 10s...";
  addMessage(
    "assistant",
    autoTriggered
      ? 'Voice setup started automatically. Say "Dogesh" at least once within 10 seconds.'
      : 'Voice setup started. Say "Dogesh" at least once within 10 seconds.'
  );

  try {
    const audioBlob = await recordAudioBlob(10000);
    el.voiceSetupState.textContent = "Transcribing...";
    const spokenText = await transcribeAudioBlob(audioBlob);
    state.voice.enrollmentChunks = spokenText ? [spokenText] : [];
    const matchedCount = dogeshCount(spokenText);
    const liveCount = Math.min(matchedCount, 1);
    el.voiceSetupState.textContent = `Recording done (${liveCount}/1)`;
    if (matchedCount < 1) {
      throw new Error(`Calibration failed. Detected ${matchedCount}/1. Please say "Dogesh" clearly once and retry.`);
    }

    await callApi(
      "/assistant/calibrate-voice",
      {
        method: "POST",
        body: JSON.stringify({ calibrated: true }),
      },
      true
    );

    state.setup.voiceReady = true;
    el.voiceSetupState.textContent = "Ready";
    addMessage("assistant", "Voice setup verified successfully. Next: save at least one API key.");
  } catch (error) {
    addMessage("error", `Voice setup failed: ${error.message}`);
    el.voiceSetupState.textContent = "Failed";
  } finally {
    state.voice.enrollmentInProgress = false;
    if (!state.setup.voiceReady) {
      el.startVoiceSetupBtn.disabled = false;
    }
    updateUiGates();
    completeSetupIfReady();
  }
}

async function onApiKeysSubmit(event) {
  event.preventDefault();

  const keys = {
    GROQ_API_KEY: el.groqKeyInput.value.trim(),
    OPENROUTER_API_KEY: el.openrouterKeyInput.value.trim(),
    NVIDIA_API_KEY: el.nvidiaKeyInput.value.trim(),
    FIREWORKSAI_API_KEY: el.fireworksKeyInput.value.trim(),
    BASETEN_API_KEY: el.basetenKeyInput.value.trim(),
  };

  const filtered = Object.fromEntries(Object.entries(keys).filter(([, v]) => Boolean(v)));
  if (Object.keys(filtered).length === 0) {
    addMessage("error", "Provide at least one API key before proceeding.");
    return;
  }

  el.saveKeysBtn.disabled = true;
  try {
    await callApi(
      "/assistant/api-keys",
      {
        method: "PUT",
        body: JSON.stringify({ api_keys: filtered }),
      },
      true
    );

    state.setup.keysReady = true;
    el.apiKeysState.textContent = "Saved";
    addMessage("assistant", "API keys saved successfully.");
    await completeSetupIfReady();
  } catch (error) {
    addMessage("error", error.message);
  } finally {
    el.saveKeysBtn.disabled = false;
    updateUiGates();
  }
}

async function onAuthSubmit(event) {
  event.preventDefault();

  const email = el.emailInput.value.trim();
  const password = el.passwordInput.value;
  if (!email || !password) {
    addMessage("error", "Email and password are required.");
    return;
  }

  el.authButton.disabled = true;
  try {
    localStorage.setItem(storageKeys.backend, backendBase());
    const endpoint = state.mode === "login" ? "/auth/login" : "/auth/signup";
    const data = await callApi(endpoint, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });

    setAuth(data.access_token || "");
    resetSetupState();
    el.voiceSetupState.textContent = "Pending";
    el.apiKeysState.textContent = "Required";
    el.startVoiceSetupBtn.disabled = false;
    state.voice.shouldListen = false;
    stopWakeWordListening();
    updateUiGates();

    addMessage("assistant", `${state.mode === "login" ? "Logged in" : "Signed up"} as ${email}.`);
    addMessage("assistant", "Starting post-login setup now.");
    runVoiceEnrollment(true);
    el.passwordInput.value = "";
  } catch (error) {
    addMessage("error", error.message);
  } finally {
    el.authButton.disabled = false;
  }
}

async function onChatSubmit(event) {
  event.preventDefault();
  const text = el.queryInput.value.trim();
  if (!text) {
    return;
  }
  el.queryInput.value = "";
  await sendAssistantQuery(text, false);
}

function onQueryKeyDown(event) {
  if (event.key !== "Enter" || event.shiftKey) {
    return;
  }
  event.preventDefault();
  if (!el.queryInput.disabled && el.queryInput.value.trim()) {
    el.chatForm.requestSubmit();
  }
}

function boot() {
  const persistedBackend = localStorage.getItem(storageKeys.backend);
  if (persistedBackend) {
    el.backendUrl.value = persistedBackend;
  } else {
    el.backendUrl.value = "http://127.0.0.1:8000";
  }

  setMode("login");
  resetSetupState();
  setAuth(state.token);
  updateUiGates();

  el.tabLogin.addEventListener("click", () => setMode("login"));
  el.tabSignup.addEventListener("click", () => setMode("signup"));
  el.authForm.addEventListener("submit", onAuthSubmit);
  el.chatForm.addEventListener("submit", onChatSubmit);
  el.queryInput.addEventListener("keydown", onQueryKeyDown);
  el.micBtn.addEventListener("click", startManualMicCapture);
  el.startVoiceSetupBtn.addEventListener("click", () => runVoiceEnrollment(false));
  el.apiKeysForm.addEventListener("submit", onApiKeysSubmit);

  el.logoutBtn.addEventListener("click", () => {
    state.voice.shouldListen = false;
    stopWakeWordListening();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setAuth("");
    resetSetupState();
    state.history = [];
    updateUiGates();
    addMessage("assistant", "Logged out.");
  });

  el.clearBtn.addEventListener("click", () => {
    state.history = [];
    el.messages.innerHTML = "";
    addMessage("assistant", "Chat history cleared.");
  });

  addMessage("assistant", "Connect to backend, login/signup, and start chatting.");
  if (!state.voice.supported) {
    addMessage("error", "Voice wake-word requires a browser with Web Speech API support.");
  }
  if (!state.voice.audioCaptureSupported) {
    addMessage("error", "Model-based STT needs AudioContext/getUserMedia support in browser.");
  }
}

boot();
