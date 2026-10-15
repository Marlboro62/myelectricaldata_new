#!/bin/sh
set -e

# Generate env.js with runtime environment variables
# This allows configuration at container startup instead of build time

# Valeur insérée entre guillemets dans env.js : antislash, guillemet et retour à la ligne échappés
# (sans quoi un « " » dans une valeur casse env.js, donc toute l'application)
js() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }'; }

cat <<EOF > /usr/share/nginx/html/env.js
window.__ENV__ = {
  VITE_API_BASE_URL: "$(js "${VITE_API_BASE_URL:-/api}")",
  VITE_BACKEND_URL: "$(js "${VITE_BACKEND_URL:-/api}")",
  VITE_SERVER_MODE: "$(js "${VITE_SERVER_MODE:-false}")",
  VITE_DEFAULT_MQTT_BROKER: "$(js "${VITE_DEFAULT_MQTT_BROKER:-}")",
  VITE_DEFAULT_MQTT_PORT: "$(js "${VITE_DEFAULT_MQTT_PORT:-1883}")",
  VITE_DEFAULT_TOPIC_PREFIX: "$(js "${VITE_DEFAULT_TOPIC_PREFIX:-myelectricaldata}")",
  VITE_DEFAULT_ENTITY_PREFIX: "$(js "${VITE_DEFAULT_ENTITY_PREFIX:-myelectricaldata}")",
  VITE_DEFAULT_DISCOVERY_PREFIX: "$(js "${VITE_DEFAULT_DISCOVERY_PREFIX:-homeassistant}")",
  VITE_DEFAULT_HA_URL: "$(js "${VITE_DEFAULT_HA_URL:-}")",
  VITE_DEFAULT_VM_URL: "$(js "${VITE_DEFAULT_VM_URL:-}")",
};
EOF

# Make env.js readable by nginx
chmod 644 /usr/share/nginx/html/env.js

# Proxy /api vers le backend, seulement si API_PROXY_URL est définie (Docker Compose).
# Sous Helm, l'ingress route déjà /api : la variable reste vide et rien n'est ajouté.
# /api est transmis tel quel, comme par l'ingress (le backend a root_path="/api").
API_PROXY_CONF_DIR=/etc/nginx/api-proxy
mkdir -p "$API_PROXY_CONF_DIR"
rm -f "$API_PROXY_CONF_DIR/api.conf"
if [ -n "${API_PROXY_URL:-}" ]; then
  # Schéma, hôte et port seulement : la valeur est écrite telle quelle dans la conf nginx
  if ! printf '%s' "$API_PROXY_URL" | grep -Eq '^https?://[A-Za-z0-9._-]+(:[0-9]{1,5})?/?$'; then
    echo "API_PROXY_URL invalide : '$API_PROXY_URL' (attendu : http://hote:port, ex. http://backend:8000)" >&2
    exit 1
  fi
  cat <<EOF > "$API_PROXY_CONF_DIR/api.conf"
location /api/ {
    proxy_pass ${API_PROXY_URL%/};
    proxy_http_version 1.1;
    proxy_set_header Host \$http_host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Connection "";
    # Export en SSE : pas de mise en tampon, flux longs
    proxy_buffering off;
    proxy_read_timeout 300s;
    client_max_body_size 10m;
}
EOF
  echo "Proxy /api -> ${API_PROXY_URL%/}"
fi

echo "Generated /usr/share/nginx/html/env.js with:"
cat /usr/share/nginx/html/env.js

# Start nginx
exec nginx -g "daemon off;"
