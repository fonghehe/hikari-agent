FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 ripgrep ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /workspace
ENV HOME=/tmp TMPDIR=/tmp
