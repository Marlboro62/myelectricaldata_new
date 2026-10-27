# =============================================================================
# Image client unique : front (nginx, port 80) et API (uvicorn, 127.0.0.1:8000)
# dans un seul conteneur. nginx sert le front et transmet /api à l'API.
#
# Contextes nommés (aucun .dockerignore à la racine du dépôt) :
#   docker buildx build -f apps/client/Dockerfile \
#     --build-context web=apps/web --build-context api=apps/api apps/client
# Seuls les fichiers copiés ci-dessous sont envoyés au builder (pas de node_modules ni .venv).
# =============================================================================

# -----------------------------------------------------------------------------
# Front : dépendances puis build (comme apps/web/Dockerfile)
# -----------------------------------------------------------------------------
FROM node:20-alpine AS web-deps

WORKDIR /app
COPY --from=web package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS web-build

WORKDIR /app
COPY --from=web-deps /app/node_modules ./node_modules
COPY --from=web package.json package-lock.json index.html vite.config.ts tsconfig.json tsconfig.node.json postcss.config.js tailwind.config.js ./
COPY --from=web public ./public
COPY --from=web src ./src
# Variables VITE_* injectées au démarrage par env.js
RUN npm run build

# -----------------------------------------------------------------------------
# API : dépendances Python (comme apps/api/Dockerfile)
# -----------------------------------------------------------------------------
FROM python:3.12-slim AS api-deps

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*
COPY --from=api pyproject.toml README.md ./
RUN pip install --no-cache-dir .

# -----------------------------------------------------------------------------
# Image finale : Python + nginx + tini
# -----------------------------------------------------------------------------
FROM python:3.12-slim

# Correctifs de sécurité Debian pas encore dans l'image amont, puis nginx, tini et tzdata.
# nginx Debian : site par défaut retiré (le front est dans conf.d), journaux vers la sortie
# du conteneur (comme nginx:alpine), page d'accueil Debian remplacée par le front.
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends nginx tini tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default \
    && ln -sf /dev/stdout /var/log/nginx/access.log \
    && ln -sf /dev/stderr /var/log/nginx/error.log \
    && rm -rf /usr/share/nginx/html/* \
    && mkdir -p /etc/nginx/api-proxy /app/data

ENV TZ=Europe/Paris \
    PYTHONUNBUFFERED=1 \
    DATABASE_URL=sqlite+aiosqlite:////app/data/myelectricaldata.db
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# API
COPY --from=api-deps /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=api-deps /usr/local/bin /usr/local/bin
WORKDIR /app
COPY --from=api pyproject.toml README.md alembic.ini entrypoint.sh ./
COPY --from=api alembic ./alembic
COPY --from=api migrations ./migrations
COPY --from=api scripts ./scripts
COPY --from=api static ./static
COPY --from=api src ./src

# Front
COPY --from=web nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web runtime-config.sh /runtime-config.sh
COPY --from=web-build /app/dist /usr/share/nginx/html

# Superviseur
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /app/entrypoint.sh /runtime-config.sh

EXPOSE 80

# Santé de bout en bout : nginx puis l'API
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1/api/ping', timeout=5)"]

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
