# =============================================================================
# Stage 1: Dependencies (cached separately from code)
# =============================================================================
FROM node:20-alpine AS deps

WORKDIR /app

# Copy ONLY package files first (better cache)
COPY package*.json ./

# Install dependencies (cached if package-lock.json unchanged)
RUN npm ci

# =============================================================================
# Stage 2: Builder
# =============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./

# Copy source code (changes frequently)
COPY . .

# Build the application
# Note: VITE_* variables will be injected at runtime via env.js
RUN npm run build

# =============================================================================
# Stage 3: Production image
# =============================================================================
FROM nginx:alpine

# Apply Alpine security fixes not yet shipped in the upstream nginx:alpine image
# (e.g. CVE-2026-85091, zlib 1.3.2-r0 -> 1.3.2-r1)
RUN apk upgrade --no-cache

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Dossier du proxy /api optionnel (rempli par entrypoint.sh si API_PROXY_URL est définie)
RUN mkdir -p /etc/nginx/api-proxy

# Copy built files from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy entrypoint script for runtime env injection
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose port
EXPOSE 80

# Use entrypoint to generate env.js at startup
ENTRYPOINT ["/entrypoint.sh"]
