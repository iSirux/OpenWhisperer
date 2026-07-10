"""Moonshine v2 streaming transcription server speaking the Vosk WebSocket protocol.

OpenWhisperer's Vosk realtime provider can point at this server unchanged
(Settings -> Real-time -> provider Vosk, endpoint ws://localhost:2702).

Protocol (matches the app's VoskSession in src-tauri/src/realtime.rs):
  client -> server:
    text   {"config": {"sample_rate": 16000}}   optional, sent before audio
    binary mono PCM, 16-bit signed little-endian at the configured rate
    text   {"eof": 1}                           finalize the utterance
  server -> client:
    {"partial": "..."}   in-progress text for the current line
    {"text": "..."}      completed line (and the finalize response)

Moonshine's line events map directly onto Vosk semantics:
  on_line_text_changed -> {"partial"}, on_line_completed -> {"text"}.

NOTE: prototype. The moonshine-voice API surface (Transcriber.add_audio vs a
Stream object) is asserted at startup; if the package changes, fix add_audio()
below.
"""

import asyncio
import json
import os

import numpy as np
import websockets
from moonshine_voice import Transcriber, TranscriptEventListener, get_model_for_language

LANG = os.environ.get("MOONSHINE_LANG", "en")
PORT = int(os.environ.get("PORT", "2702"))
# How many pre-built transcribers to keep warm. 2 covers the app's usual
# handoff pattern (open-mic session closing while a recording session opens).
POOL_TARGET = int(os.environ.get("MOONSHINE_POOL_SIZE", "2"))

# Resolved once at startup (downloads on first use if not baked into the image).
MODEL_PATH, MODEL_ARCH = get_model_for_language(LANG)

# ── Transcriber pool ─────────────────────────────────────────────────────────
#
# Constructing a Transcriber loads model weights and stopping one joins its
# worker thread — both are blocking calls that must never run on the event
# loop, or every pending WebSocket handshake stalls behind them (this was the
# ~1s connect latency the app saw on every recording start).
#
# Each connection takes a FRESH pre-built transcriber from the pool and
# discards it afterwards; a maintainer task rebuilds replacements in a thread.
# Instances are never reused across utterances, so nothing here depends on
# moonshine-voice reset semantics.

pool: asyncio.Queue = asyncio.Queue()
pool_low = asyncio.Event()


def build_transcriber() -> Transcriber:
    return Transcriber(model_path=MODEL_PATH, model_arch=MODEL_ARCH)


async def pool_maintainer() -> None:
    loop = asyncio.get_running_loop()
    while True:
        if pool.qsize() < POOL_TARGET:
            transcriber = await loop.run_in_executor(None, build_transcriber)
            pool.put_nowait(transcriber)
        else:
            pool_low.clear()
            await pool_low.wait()


async def acquire_transcriber() -> Transcriber:
    try:
        transcriber = pool.get_nowait()
        pool_low.set()
        return transcriber
    except asyncio.QueueEmpty:
        # Pool drained (reconnects faster than rebuilds) — build one for this
        # connection in a thread so other connections keep working meanwhile.
        pool_low.set()
        return await asyncio.get_running_loop().run_in_executor(None, build_transcriber)


async def retire_transcriber(transcriber: Transcriber) -> None:
    def _stop() -> None:
        try:
            transcriber.stop()
        except Exception:
            pass

    await asyncio.get_running_loop().run_in_executor(None, _stop)


class LineListener(TranscriptEventListener):
    """Forwards moonshine line events into the connection's asyncio queue.

    Callbacks fire on the transcriber's worker thread, hence
    call_soon_threadsafe.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue):
        self.loop = loop
        self.queue = queue

    def _put(self, item: dict) -> None:
        self.loop.call_soon_threadsafe(self.queue.put_nowait, item)

    def on_line_started(self, event) -> None:
        pass

    def on_line_text_changed(self, event) -> None:
        self._put({"partial": event.line.text})

    def on_line_completed(self, event) -> None:
        self._put({"text": event.line.text})


async def handle(ws) -> None:
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    sample_rate = 16000

    transcriber = await acquire_transcriber()
    transcriber.add_listener(LineListener(loop, queue))
    # start() spawns the worker thread; run it off-loop like the other
    # potentially blocking transcriber calls.
    await loop.run_in_executor(None, transcriber.start)

    # Text of the current (not yet completed) line; the finalize response
    # flushes it as the final {"text"} frame, mirroring Vosk's eof behavior.
    last_partial = ""

    async def pump() -> None:
        nonlocal last_partial
        while True:
            item = await queue.get()
            last_partial = item.get("partial", "")
            await ws.send(json.dumps(item))

    pump_task = asyncio.create_task(pump())

    def add_audio(samples: np.ndarray) -> None:
        # moonshine expects float32 mono; incoming frames are i16 LE
        floats = samples.astype(np.float32) / 32768.0
        transcriber.add_audio(floats, sample_rate)

    try:
        async for message in ws:
            if isinstance(message, (bytes, bytearray)):
                add_audio(np.frombuffer(message, dtype=np.int16))
                continue

            try:
                obj = json.loads(message)
            except json.JSONDecodeError:
                continue

            if "config" in obj:
                sample_rate = int(obj["config"].get("sample_rate", sample_rate))
            elif obj.get("eof"):
                # Take over the queue from the pump and fold everything still
                # in flight — queued completed lines plus the current partial —
                # into ONE final frame (Vosk semantics: eof gets exactly one
                # reply, and the client stops reading at the first {"text"}).
                # The transcriber keeps running while we drain so audio it is
                # still processing can finish; we wait for ~0.35s of event
                # quiescence, capped at 1.5s.
                pump_task.cancel()
                try:
                    await pump_task
                except asyncio.CancelledError:
                    pass
                tail_parts = []
                deadline = loop.time() + 1.5
                last_event = loop.time()
                while loop.time() < deadline and loop.time() - last_event < 0.35:
                    try:
                        item = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        await asyncio.sleep(0.05)
                        continue
                    last_event = loop.time()
                    if "text" in item:
                        tail_parts.append(item["text"])
                        last_partial = ""
                    else:
                        last_partial = item.get("partial", "")
                if last_partial:
                    tail_parts.append(last_partial)
                tail = " ".join(p for p in tail_parts if p).strip()
                await ws.send(json.dumps({"text": tail}))
                break
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        pump_task.cancel()
        await retire_transcriber(transcriber)


async def main() -> None:
    assert hasattr(Transcriber, "add_audio"), (
        "moonshine-voice API changed: Transcriber.add_audio missing - "
        "update server.py to use the Stream API"
    )
    # Warm the pool before accepting connections so the first session doesn't
    # pay the model load either.
    loop = asyncio.get_running_loop()
    while pool.qsize() < POOL_TARGET:
        pool.put_nowait(await loop.run_in_executor(None, build_transcriber))
    maintainer = asyncio.create_task(pool_maintainer())

    try:
        async with websockets.serve(handle, "0.0.0.0", PORT, max_size=None):
            print(
                f"moonshine ({LANG}, {MODEL_ARCH}) listening on ws://0.0.0.0:{PORT} "
                f"(pool of {POOL_TARGET} warm transcribers)",
                flush=True,
            )
            await asyncio.Future()
    finally:
        maintainer.cancel()


if __name__ == "__main__":
    asyncio.run(main())
