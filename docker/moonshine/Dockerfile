# Moonshine v2 streaming ASR server speaking the Vosk WebSocket protocol.
#
# Point OpenWhisperer's Vosk realtime provider at ws://localhost:2702 —
# no app changes needed (see server.py for the protocol mapping).
#
# Build:  docker build -t open-whisperer-moonshine .
# Run:    docker run -d --restart unless-stopped --name moonshine -p 2702:2702 open-whisperer-moonshine
#
# Model selection: get_model_for_language() picks the default streaming model
# for MOONSHINE_LANG. CPU-only by design — Moonshine v2 streams faster than
# real time on CPU (that's its whole point).
FROM python:3.12-slim

# libgomp1 is required by onnxruntime (moonshine-voice dependency)
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir moonshine-voice websockets numpy

ENV MOONSHINE_LANG=en \
    PORT=2702

# Bake the model into the image so first startup is instant. If this download
# invocation breaks on a future moonshine-voice release, it can be removed —
# get_model_for_language() in server.py downloads on first run instead.
RUN python -m moonshine_voice.download --stt --language ${MOONSHINE_LANG}

WORKDIR /app
COPY server.py /app/server.py

EXPOSE 2702

CMD ["python", "/app/server.py"]
