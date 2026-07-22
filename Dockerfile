FROM node:22-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    libglib2.0-0 \
    libgomp1 \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN python3 -m venv /opt/venv

ENV VIRTUAL_ENV=/opt/venv
ENV PNPM_HOME=/pnpm
ENV PATH=$VIRTUAL_ENV/bin:$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

FROM base AS deps

WORKDIR /app/web_ui
COPY web_ui/package.json web_ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS builder

WORKDIR /app
COPY web_ui ./web_ui

WORKDIR /app/web_ui
RUN pnpm run build

FROM base AS runner

WORKDIR /app

ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu124

COPY requirements.txt ./requirements.txt

RUN python3 -m pip install --no-cache-dir --upgrade pip \
  && python3 -m pip install --no-cache-dir \
    "torch>=2.1.0" \
    "torchvision>=0.16.0" \
    --index-url "${TORCH_INDEX_URL}" \
  && python3 -m pip install --no-cache-dir -r requirements.txt

COPY car_img_get ./car_img_get
COPY --from=deps /app/web_ui/node_modules ./web_ui/node_modules
COPY web_ui/package.json web_ui/pnpm-lock.yaml ./web_ui/
COPY web_ui/api ./web_ui/api
COPY --from=builder /app/web_ui/dist ./web_ui/dist

ENV NODE_ENV=production
ENV PORT=53378
ENV CRAWLER_PYTHON=python3
ENV CRAWLER_PROJECT_ROOT=/app
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility

EXPOSE 53378

WORKDIR /app/web_ui

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:53378/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "api/server.ts"]
