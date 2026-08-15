# Minimal, stable runtime for the standalone dedup agent. Our code (server.mjs, console.html, tools/) is
# bind-mounted from the NAS at runtime, so this image almost never needs rebuilding — and it is completely
# independent of the Immich image, so Immich rebuilds can never break the dedup agent.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        imagemagick \
        libheif1 \
        libimage-exiftool-perl \
        python3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Baked-in copy so the container runs even without the bind-mount; compose bind-mounts ./app over it for
# zero-rebuild iteration on the console/proxy/tools.
COPY app/ /app/

ENV PORT=8095
EXPOSE 8095
CMD ["node", "/app/server.mjs"]
