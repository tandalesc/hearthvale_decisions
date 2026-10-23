FROM node:22-bookworm-slim AS node
FROM python:3.12-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch==2.7.1 --index-url https://download.pytorch.org/whl/cpu && pip install --no-cache-dir numpy==2.2.6
WORKDIR /app
COPY package.json ./
COPY public/students/manifest.json ./public/students/manifest.json
COPY src ./src
COPY server ./server
COPY scripts ./scripts
COPY cloudflare/decision.js cloudflare/learning.js ./cloudflare/
COPY cloudflare/training ./cloudflare/training
ENV CUDA_VISIBLE_DEVICES="" OMP_NUM_THREADS=4 MKL_NUM_THREADS=4
CMD ["node", "cloudflare/training/runner.js"]
