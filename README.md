# Bilingual voice agent

A real-time voice assistant that listens through the browser mic and talks back
in Arabic or English. It follows you when you switch language mid conversation.
Built on Google ADK live streaming and the Gemini Live API.

## How it works

```
Browser                         FastAPI server                     Gemini Live API
mic -> AudioWorklet (16 kHz)    /ws/{user}/{session}
     PCM16 binary frames  --->  LiveRequestQueue.send_realtime --->  native audio model
                                                                     (speech in, speech out)
speaker <- AudioWorklet         runner.run_live() events     <---
     (24 kHz ring buffer)  <--- audio as binary frames
transcript panel           <--- JSON: transcripts, interrupted, turn_complete
```

The browser records 16 kHz mono PCM in an AudioWorklet and sends 40 ms chunks
as binary WebSocket frames. The server pushes them into an ADK
`LiveRequestQueue`. `Runner.run_live()` keeps one bidirectional Live API
session open and yields events. Audio comes back as 24 kHz PCM and goes straight
to the browser as binary frames, so there is no base64 or JSON overhead on the
hot path. Transcripts and control events go as small JSON messages.

Barge-in works because the Live API detects speech while the agent is talking
and sends an `interrupted` event. The browser then empties its playback buffer
so the agent stops at once.

Language handling relies on the native audio model detecting the spoken
language. The server sets no `language_code`, and the agent instruction tells
it to answer in whatever language you just used.

## Run it

You need Python 3.11 or newer and a Gemini API key from Google AI Studio (or a
Vertex AI project).

```bash
python -m venv .venv
source .venv/bin/activate        # on Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # then put your key in .env
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000 in Chrome or Edge, press Start talking and allow the
mic. Use headphones if you can. Echo cancellation helps, but speakers can still
leak the agent's voice back into the mic and trigger an interruption.

If the server logs say the model was not found, the Live model name has moved
on. Set `VOICE_AGENT_MODEL` in `.env` to a current native audio model from the
Live API model list.

## Files

- `app/agent.py` holds the agent and its bilingual instruction.
- `app/main.py` is the FastAPI server and WebSocket bridge.
- `app/static/` is the browser client and the two audio worklets.

## Next steps

1. Test with a real key and tune the voice and the Arabic dialect guidance.
2. Add one or two tools (time, weather, a small knowledge lookup) to prove
   function calling works mid conversation.
3. Add session resumption so a dropped connection does not lose the chat.
4. Deploy to Cloud Run behind HTTPS, which browsers need for mic access
   anywhere other than localhost.
