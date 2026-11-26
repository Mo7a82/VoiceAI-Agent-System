const startBtn = document.getElementById("start");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const textForm = document.getElementById("textForm");
const textInput = document.getElementById("textInput");

const userId = "local-user";
const sessionId = "s-" + Math.random().toString(36).slice(2, 10);

let ws = null;
let micCtx = null, micStream = null, recorderNode = null;
let playerCtx = null, playerNode = null;
let current = { user: null, agent: null }; // bubbles being filled in

function setStatus(t) { statusEl.textContent = t; }

function bubble(role, text) {
  const el = document.createElement("div");
  el.className = "msg " + role;
  el.dir = "auto";
  if (role !== "sys") {
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = role === "user" ? "You" : "Agent";
    el.appendChild(who);
  }
  el.appendChild(document.createTextNode(text));
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}

function appendTo(role, text) {
  if (!current[role]) current[role] = bubble(role, "");
  current[role].lastChild.textContent += text;
  logEl.scrollTop = logEl.scrollHeight;
}

async function startPlayer() {
  playerCtx = new AudioContext({ sampleRate: 24000 });
  await playerCtx.audioWorklet.addModule("/static/pcm-player-processor.js");
  playerNode = new AudioWorkletNode(playerCtx, "pcm-player-processor");
  playerNode.connect(playerCtx.destination);
}

async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  micCtx = new AudioContext({ sampleRate: 16000 });
  await micCtx.audioWorklet.addModule("/static/pcm-recorder-processor.js");
  const source = micCtx.createMediaStreamSource(micStream);
  recorderNode = new AudioWorkletNode(micCtx, "pcm-recorder-processor");
  recorderNode.port.onmessage = (e) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(e.data);
  };
  source.connect(recorderNode);
}

function connect() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/${userId}/${sessionId}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
    ws.onclose = () => { setStatus("Disconnected"); stop(false); };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        if (playerNode) playerNode.port.postMessage(e.data, [e.data]);
        return;
      }
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case "user_transcript":
          current.agent = null;
          appendTo("user", msg.text);
          if (msg.final) current.user = null;
          break;
        case "agent_transcript":
          current.user = null;
          appendTo("agent", msg.text);
          if (msg.final) current.agent = null;
          break;
        case "interrupted":
          if (playerNode) playerNode.port.postMessage({ command: "clear" });
          current.agent = null;
          break;
        case "turn_complete":
          current = { user: null, agent: null };
          break;
        case "error":
          bubble("sys", "Error: " + msg.text);
          break;
      }
    };
  });
}

async function start() {
  startBtn.disabled = true;
  setStatus("Connecting...");
  try {
    await startPlayer();
    await connect();
    await startMic();
    startBtn.textContent = "Stop";
    startBtn.classList.add("live");
    setStatus("Listening");
  } catch (err) {
    bubble("sys", "Could not start: " + (err.message || err));
    stop(true);
  } finally {
    startBtn.disabled = false;
  }
}

function stop(closeSocket = true) {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (micCtx) micCtx.close();
  if (playerCtx) playerCtx.close();
  micStream = micCtx = recorderNode = playerCtx = playerNode = null;
  if (closeSocket && ws) ws.close();
  ws = null;
  startBtn.textContent = "Start talking";
  startBtn.classList.remove("live");
  if (statusEl.textContent !== "Disconnected") setStatus("Idle");
}

startBtn.addEventListener("click", () => (ws ? stop(true) : start()));

textForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "text", text }));
  current = { user: null, agent: null };
  bubble("user", text);
  current.user = null;
  textInput.value = "";
});
