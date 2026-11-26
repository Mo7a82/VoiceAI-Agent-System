"""FastAPI server that bridges a browser WebSocket to ADK live streaming.

Browser -> server:
  binary frame  = raw PCM16 mono audio at 16 kHz from the mic
  text frame    = JSON, e.g. {"type": "text", "text": "hello"}
Server -> browser:
  binary frame  = raw PCM16 mono audio at 24 kHz to play
  text frame    = JSON events: transcripts, interrupted, turn_complete, error
"""

import asyncio
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from google.adk.agents import LiveRequestQueue  # noqa: E402
from google.adk.agents.run_config import RunConfig, StreamingMode  # noqa: E402
from google.adk.runners import Runner  # noqa: E402
from google.adk.sessions import InMemorySessionService  # noqa: E402
from google.genai import types  # noqa: E402

from .agent import root_agent  # noqa: E402

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("voice-agent")

APP_NAME = "bilingual-voice-agent"
STATIC_DIR = Path(__file__).parent / "static"

session_service = InMemorySessionService()
runner = Runner(app_name=APP_NAME, agent=root_agent, session_service=session_service)

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


def build_run_config() -> RunConfig:
    voice = os.getenv("VOICE_AGENT_VOICE", "Puck")
    return RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=[types.Modality.AUDIO],
        # No language_code: native audio models detect the spoken language,
        # which is what lets the agent follow Arabic/English switching.
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        # Keeps long conversations alive past the default context limit.
        context_window_compression=types.ContextWindowCompressionConfig(
            trigger_tokens=100_000,
            sliding_window=types.SlidingWindow(target_tokens=80_000),
        ),
    )


@app.websocket("/ws/{user_id}/{session_id}")
async def ws_endpoint(websocket: WebSocket, user_id: str, session_id: str):
    await websocket.accept()
    log.info("client connected user=%s session=%s", user_id, session_id)

    session = await session_service.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id
    )
    if session is None:
        await session_service.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=session_id
        )

    queue = LiveRequestQueue()

    async def upstream():
        """Browser -> model."""
        while True:
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                raise WebSocketDisconnect()
            if msg.get("bytes"):
                queue.send_realtime(
                    types.Blob(mime_type="audio/pcm;rate=16000", data=msg["bytes"])
                )
            elif msg.get("text"):
                data = json.loads(msg["text"])
                if data.get("type") == "text" and data.get("text"):
                    queue.send_content(
                        types.Content(role="user", parts=[types.Part(text=data["text"])])
                    )

    async def downstream():
        """Model -> browser."""
        async for event in runner.run_live(
            user_id=user_id,
            session_id=session_id,
            live_request_queue=queue,
            run_config=build_run_config(),
        ):
            if event.content and event.content.parts:
                for part in event.content.parts:
                    blob = part.inline_data
                    if blob and blob.data and (blob.mime_type or "").startswith("audio/pcm"):
                        await websocket.send_bytes(blob.data)
            if event.input_transcription and event.input_transcription.text:
                await websocket.send_json({
                    "type": "user_transcript",
                    "text": event.input_transcription.text,
                    "final": bool(event.input_transcription.finished),
                    "lang": event.input_transcription.language_code,
                })
            if event.output_transcription and event.output_transcription.text:
                await websocket.send_json({
                    "type": "agent_transcript",
                    "text": event.output_transcription.text,
                    "final": bool(event.output_transcription.finished),
                })
            if event.interrupted:
                await websocket.send_json({"type": "interrupted"})
            if event.turn_complete:
                await websocket.send_json({"type": "turn_complete"})
            if event.error_message:
                await websocket.send_json({"type": "error", "text": event.error_message})

    up = asyncio.create_task(upstream())
    down = asyncio.create_task(downstream())
    try:
        done, pending = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                log.exception("stream failed", exc_info=exc)
                try:
                    await websocket.send_json({"type": "error", "text": str(exc)})
                except Exception:
                    pass
    finally:
        queue.close()
        for task in (up, down):
            task.cancel()
        log.info("client disconnected session=%s", session_id)
