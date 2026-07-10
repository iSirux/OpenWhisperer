# sherpa-onnx streaming ASR WebSocket server (streaming Zipformer, English).
#
# Speaks the protocol OpenWhisperer's SherpaOnnx realtime provider already
# implements: binary float32 samples in, {"text", "is_final"} JSON out,
# text frame "Done" to finalize. Default port 6006.
#
# Build:  docker build -t open-whisperer-sherpa-onnx .
# Run:    docker run -d --restart unless-stopped --name sherpa-onnx -p 6006:6006 open-whisperer-sherpa-onnx
#
# CPU-only by design: the streaming Zipformer runs far faster than real time
# on CPU (RTF ~0.02), so no CUDA image is provided.
FROM python:3.12-slim

# Pin the sherpa-onnx version; the server script is fetched from the matching
# repo tag since it ships in the repo, not the pip package.
ARG SHERPA_ONNX_VERSION=1.13.4
# English streaming Zipformer. For the lightweight variant use
# sherpa-onnx-streaming-zipformer-en-20M-2023-02-17 (and int8 model files).
ARG MODEL=sherpa-onnx-streaming-zipformer-en-2023-06-26

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl bzip2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir sherpa-onnx==${SHERPA_ONNX_VERSION} websockets numpy

WORKDIR /app

ADD https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v${SHERPA_ONNX_VERSION}/python-api-examples/streaming_server.py /app/streaming_server.py

RUN curl -SL https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL}.tar.bz2 \
    | tar -xj -C /app

# streaming_server.py imports its sibling http_server.py (serves the demo web
# page; stdlib-only) — the server crashes on start without it. Kept after the
# model layer so adding it doesn't bust that cache.
ADD https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v${SHERPA_ONNX_VERSION}/python-api-examples/http_server.py /app/http_server.py

ENV MODEL_DIR=/app/${MODEL}

# The server's HttpServer eagerly reads a fixed list of demo-page assets from
# --doc-root at startup and crashes if any is missing. We only use the
# WebSocket side, so empty placeholders satisfy it.
RUN mkdir -p /app/web/css /app/web/js \
    && touch /app/web/index.html /app/web/nav-partial.html \
        /app/web/offline_record.html /app/web/streaming_record.html \
        /app/web/upload.html /app/web/k2-logo.png \
        /app/web/css/bootstrap.min.css /app/web/css/bootstrap.min.css.map \
        /app/web/js/bootstrap.min.js /app/web/js/bootstrap.min.js.map \
        /app/web/js/jquery-3.6.0.min.js /app/web/js/offline_record.js \
        /app/web/js/popper.min.js /app/web/js/popper.min.js.map \
        /app/web/js/streaming_record.js /app/web/js/upload.js

EXPOSE 6006

CMD python3 /app/streaming_server.py \
    --encoder ${MODEL_DIR}/encoder-epoch-99-avg-1-chunk-16-left-128.onnx \
    --decoder ${MODEL_DIR}/decoder-epoch-99-avg-1-chunk-16-left-128.onnx \
    --joiner ${MODEL_DIR}/joiner-epoch-99-avg-1-chunk-16-left-128.onnx \
    --tokens ${MODEL_DIR}/tokens.txt \
    --doc-root /app/web \
    --port 6006
