#!/bin/bash
# Image client unique : nginx (front, port 80) et l'API (uvicorn, 127.0.0.1:8000) dans un conteneur.
# Lancé par tini (PID 1), qui transmet les signaux à ce script et récolte les zombies.
# Si l'un des deux processus s'arrête, l'autre est arrêté et le conteneur sort en erreur :
# la politique de redémarrage (restart: unless-stopped) relance alors le tout, au lieu d'un
# nginx qui répondrait 502 indéfiniment.
set -euo pipefail

API_PORT_LOCAL=8000

# env.js et proxy /api vers l'API locale (script partagé avec l'image frontend).
# API_PROXY_URL est imposée : l'API n'écoute que sur la boucle locale du conteneur.
API_PROXY_URL="http://127.0.0.1:${API_PORT_LOCAL}" /runtime-config.sh

# Migrations alembic puis uvicorn (entrypoint de l'image backend, avec la commande en argument)
cd /app
/app/entrypoint.sh uvicorn src.main:app --host 127.0.0.1 --port "$API_PORT_LOCAL" \
  --timeout-graceful-shutdown 5 &
api_pid=$!

nginx -g "daemon off;" &
nginx_pid=$!

stopping=0
stop() {
  stopping=1
  # uvicorn : arrêt propre sur SIGTERM ; nginx : SIGQUIT = arrêt propre (SIGTERM = arrêt immédiat)
  kill -TERM "$api_pid" 2>/dev/null || true
  kill -QUIT "$nginx_pid" 2>/dev/null || true
}
trap stop TERM INT

# Attend la fin du premier des deux processus (ou un signal, qui interrompt wait)
code=0
wait -n "$api_pid" "$nginx_pid" || code=$?

if [ "$stopping" = 1 ]; then
  wait "$api_pid" "$nginx_pid" 2>/dev/null || true
  exit 0
fi

if kill -0 "$api_pid" 2>/dev/null; then dead=nginx; else dead=api; fi
echo "Processus $dead arrêté (code $code) : arrêt du conteneur" >&2
stop
wait "$api_pid" "$nginx_pid" 2>/dev/null || true
# Un arrêt sans erreur reste anormal ici : le conteneur doit sortir en erreur pour être relancé
[ "$code" -ne 0 ] || code=1
exit "$code"
