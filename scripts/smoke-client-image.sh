#!/usr/bin/env bash
# Test de fumée de l'image unique « client » (front nginx + API uvicorn dans un conteneur), MED-75.
#
# Usage : scripts/smoke-client-image.sh [--static] [--frontend] [--client]   (sans option : tout)
#   --static    fichiers du dépôt : compose, CI, doc, shellcheck (aucun build)
#   --frontend  garde-fou de non-régression de l'image frontend (entrypoint.sh refactoré)
#   --client    build et exécution de l'image client
#
# Variables : CLIENT_DOCKERFILE (défaut apps/client/Dockerfile), SKIP_BUILD=1 (réutilise les images).
# Les preuves sont prises au point de consommation : ce que sert nginx, ce que voit le processus,
# l'état du conteneur, pas ce que les fichiers déclarent.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 2
CLIENT_DOCKERFILE=${CLIENT_DOCKERFILE:-apps/client/Dockerfile}
CLIENT_IMAGE=${CLIENT_IMAGE:-med75-client:smoke}
WEB_IMAGE=med75-web:smoke
RUN_ID=$$
# Compte factice, passerelle injoignable sur l'instant (port local fermé) : le démarrage de l'API
# tente une synchro des PDL qui, vers la vraie passerelle, peut attendre son délai de 60 s selon
# le réseau du moteur Docker. Le test mesure l'image, pas la passerelle.
FAKE_ACCOUNT=(-e MED_CLIENT_ID=fake -e MED_CLIENT_SECRET=fake -e MED_API_URL=http://127.0.0.1:9/api)
PASS=0
FAIL=0
CONTAINERS=()
VOLUMES=()

ok() { PASS=$((PASS + 1)); printf '  ✅ %s\n' "$1"; }
ko() { FAIL=$((FAIL + 1)); printf '  ❌ %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
check() { # check "libellé" commande...
  local label=$1
  shift
  if out=$("$@" 2>&1); then ok "$label"; else ko "$label" "$(printf '%s' "$out" | tail -3 | tr '\n' ' ' | cut -c1-240)"; fi
}
section() { printf '\n== %s\n' "$1"; }

cleanup() {
  local c v
  for c in "${CONTAINERS[@]:-}"; do [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1; done
  for v in "${VOLUMES[@]:-}"; do [ -n "$v" ] && docker volume rm -f "$v" >/dev/null 2>&1; done
}
trap cleanup EXIT

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1"; }
wait_http() { # wait_http url secondes -> 0 dès que l'URL répond 200
  for _ in $(seq 1 "$2"); do
    [ "$(http_code "$1")" = 200 ] && return 0
    sleep 1
  done
  return 1
}
host_port() { docker port "$1" 80/tcp | head -1 | sed 's/.*://'; }
start() { # start nom image [options docker...] ; publie le 80 sur un port libre de 127.0.0.1
  local name=$1 image=$2
  shift 2
  CONTAINERS+=("$name")
  docker run -d --name "$name" -p 127.0.0.1::80 "$@" "$image" >/dev/null
}
state() { docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null; }
wait_exit() { # wait_exit nom secondes -> 0 si le conteneur s'est arrêté
  for _ in $(seq 1 "$2"); do
    [ "$(state "$1")" = exited ] && return 0
    sleep 1
  done
  return 1
}
exited_nonzero() { # exited_nonzero nom secondes -> arrêté sous le délai, code de sortie non nul
  wait_exit "$1" "$2" && [ "$(docker inspect -f '{{.State.ExitCode}}' "$1")" != 0 ]
}
stopped_clean() { # stopped_clean nom durée -> arrêt en moins de 10 s, hors SIGKILL (137)
  [ "$2" -lt 10 ] && [ "$(docker inspect -f '{{.State.ExitCode}}' "$1")" != 137 ]
}
ready_with_db() { # ready_with_db nom -> /api/ping répond et la base SQLite existe
  wait_http "http://127.0.0.1:$(host_port "$1")/api/ping" 120 && docker exec "$1" test -s /app/data/myelectricaldata.db
}
pid_of() { # pid_of nom motif -> PID du processus dont la ligne de commande contient le motif (hors ce shell)
  docker exec "$1" sh -c 'for p in /proc/[0-9]*; do
      [ "${p#/proc/}" = "$$" ] && continue
      if tr "\0" " " < "$p/cmdline" 2>/dev/null | grep -q "$0"; then echo "${p#/proc/}"; exit 0; fi
    done; exit 1' "$2"
}
loopback_only() { # loopback_only nom -> 8000 refusé sur l'adresse du conteneur (et pas une erreur d'exécution)
  [ "$(docker exec "$1" python -c "
import socket, sys
try:
    socket.create_connection((socket.gethostbyname(socket.gethostname()), 8000), 2)
except OSError:
    print('refused'); sys.exit(0)
print('open')" 2>&1)" = refused ]
}

# env.js attendu pour VITE_DEFAULT_MQTT_BROKER='a"b\c', tout le reste par défaut (référence : image de main)
expected_env_js() {
  cat <<'EOF'
window.__ENV__ = {
  VITE_API_BASE_URL: "/api",
  VITE_BACKEND_URL: "/api",
  VITE_SERVER_MODE: "false",
  VITE_DEFAULT_MQTT_BROKER: "a\"b\\c",
  VITE_DEFAULT_MQTT_PORT: "1883",
  VITE_DEFAULT_TOPIC_PREFIX: "myelectricaldata",
  VITE_DEFAULT_ENTITY_PREFIX: "myelectricaldata",
  VITE_DEFAULT_DISCOVERY_PREFIX: "homeassistant",
  VITE_DEFAULT_HA_URL: "",
  VITE_DEFAULT_VM_URL: "",
};
EOF
}
MQTT_TRAP='a"b\c'

# Noms d'en-têtes de réponse (sans Date/ETag/Last-Modified/Content-Length/Server, variables d'une version à l'autre)
header_names() {
  curl -s -D - -o /dev/null --max-time 5 "$1" | sed 's/\r//' | sed -n '2,$p' | cut -d: -f1 \
    | grep -iv '^\(date\|etag\|last-modified\|content-length\|server\|connection\|accept-ranges\)$' | grep -v '^$' | sort
}

# ---------------------------------------------------------------------------------------------
test_static() {
  section "Dépôt : compose, CI, doc"
  check "docker-compose.client.yml existe" test -f docker-compose.client.yml
  check "docker-compose.client.yml : un seul service" \
    test "$(yq '.services | keys | length' docker-compose.client.yml 2>/dev/null)" = 1
  check "docker-compose.client.yml : port 8100 -> 80" \
    sh -c "yq '.services[].ports[]' docker-compose.client.yml 2>/dev/null | grep -Eq '8100.*:80\$'"
  check "docker-compose.client.yml : volume myelectricaldata_data conservé" \
    sh -c "yq '.volumes | keys | .[]' docker-compose.client.yml 2>/dev/null | grep -qx myelectricaldata_data"
  check "docker-compose.client.yml : plus de port 8181" \
    sh -c "test -f docker-compose.client.yml && ! grep -q 8181 docker-compose.client.yml"
  check "docker-compose.sqlite.yml conservé à 2 services" \
    test "$(yq '.services | keys | length' docker-compose.sqlite.yml)" = 2
  check "docker-compose.yml conservé à 2 services ou plus" \
    sh -c "test \"\$(yq '.services | keys | length' docker-compose.yml)\" -ge 2"
  check "release.yml publie l'image client" \
    sh -c "yq '.jobs[].strategy.matrix.include[].image' .github/workflows/release.yml | grep -qx client"
  check "docker-release.yml publie l'image client" \
    sh -c "yq '.jobs[].strategy.matrix.include[].image' .github/workflows/docker-release.yml | grep -qx client"
  check "release.yml garde backend et frontend" \
    sh -c "yq '.jobs[].strategy.matrix.include[].image' .github/workflows/release.yml | grep -qx backend && yq '.jobs[].strategy.matrix.include[].image' .github/workflows/release.yml | grep -qx frontend"
  check "doc : docker-compose.client.yml documenté" \
    sh -c "grep -rlq 'docker-compose.client.yml' docs/local-client README.md"
  check "doc : migration 2 conteneurs -> 1 documentée (--remove-orphans)" \
    sh -c "grep -rq -e '--remove-orphans' docs/local-client"
  check "aucun .dockerignore à la racine (contextes nommés)" test ! -e .dockerignore
  if command -v shellcheck >/dev/null 2>&1; then
    check "shellcheck des scripts de conteneur" \
      sh -c "ls apps/client/*.sh apps/web/*.sh 2>/dev/null | grep -q . && shellcheck apps/client/*.sh apps/web/*.sh"
  fi
}

# ---------------------------------------------------------------------------------------------
test_frontend_regression() {
  section "Image frontend : comportement inchangé après extraction du script partagé"
  [ "${SKIP_BUILD:-0}" = 1 ] || docker build -q -t "$WEB_IMAGE" apps/web >/dev/null || { ko "build de l'image frontend"; return; }
  local a=med75-web-a-$RUN_ID b=med75-web-b-$RUN_ID
  start "$a" "$WEB_IMAGE" -e API_PROXY_URL=http://backend:8000 -e "VITE_DEFAULT_MQTT_BROKER=$MQTT_TRAP"
  start "$b" "$WEB_IMAGE"
  sleep 3
  check "env.js identique à la référence (guillemet et antislash échappés)" \
    diff <(expected_env_js) <(docker exec "$a" cat /usr/share/nginx/html/env.js)
  local conf
  conf=$(docker exec "$a" cat /etc/nginx/api-proxy/api.conf 2>&1)
  check "proxy /api : location, upstream en variable, URI d'origine transmis" \
    sh -c "printf '%s' '$conf' | grep -q 'location /api/' && printf '%s' '$conf' | grep -q 'set \$api_upstream http://backend:8000;' && printf '%s' '$conf' | grep -q 'proxy_pass \$api_upstream;'"
  check "proxy /api : SSE sans tampon, timeout 300 s, corps 10m" \
    sh -c "printf '%s' '$conf' | grep -q 'proxy_buffering off;' && printf '%s' '$conf' | grep -q 'proxy_read_timeout 300s;' && printf '%s' '$conf' | grep -q 'client_max_body_size 10m;'"
  check "sans API_PROXY_URL : aucun proxy écrit" \
    test -z "$(docker exec "$b" sh -c 'ls /etc/nginx/api-proxy/')"
  check "route du front /tempo : index.html" \
    sh -c "curl -s http://127.0.0.1:$(host_port "$b")/tempo | grep -q 'id=\"root\"'"
  local bad=med75-web-bad-$RUN_ID
  CONTAINERS+=("$bad")
  docker run -d --name "$bad" -e 'API_PROXY_URL=http://x;evil' "$WEB_IMAGE" >/dev/null
  check "API_PROXY_URL invalide : le conteneur s'arrête en erreur" \
    sh -c "docker wait $bad | grep -qx 1"
}

# ---------------------------------------------------------------------------------------------
test_client() {
  section "Image client : build"
  if [ "${SKIP_BUILD:-0}" != 1 ]; then
    if [ ! -f "$CLIENT_DOCKERFILE" ]; then
      ko "Dockerfile de l'image client présent ($CLIENT_DOCKERFILE)"
      return
    fi
    check "build avec contextes nommés web et api" \
      docker buildx build -q --load -t "$CLIENT_IMAGE" -f "$CLIENT_DOCKERFILE" \
      --build-context web=apps/web --build-context api=apps/api apps/client
  fi
  docker image inspect "$CLIENT_IMAGE" >/dev/null 2>&1 || { ko "image $CLIENT_IMAGE absente"; return; }

  section "Image client : démarrage (sans volume, SQLite, identifiants factices)"
  local c=med75-client-$RUN_ID t0 t1 port
  t0=$(date +%s)
  start "$c" "$CLIENT_IMAGE" "${FAKE_ACCOUNT[@]}" -e "VITE_DEFAULT_MQTT_BROKER=$MQTT_TRAP"
  port=$(host_port "$c")
  if wait_http "http://127.0.0.1:$port/api/ping" 120; then
    t1=$(date +%s)
    ok "/api/ping répond 200 par nginx après $((t1 - t0)) s (budget de sonde Kubernetes : à comparer, migrations alembic comprises)"
    if [ $((t1 - t0)) -le 60 ]; then ok "démarrage natif sous 60 s"; else ko "démarrage natif sous 60 s" "$((t1 - t0)) s"; fi
  else
    ko "/api/ping répond 200 par nginx sous 120 s" "$(docker logs "$c" 2>&1 | tail -3 | tr '\n' ' ' | cut -c1-240)"
    return
  fi
  local base=http://127.0.0.1:$port
  check "/api/ping est du JSON (réponse de l'API, pas du front)" \
    sh -c "curl -sI $base/api/ping | tr -d '\r' | grep -qi '^content-type: application/json'"
  check "/ sert index.html" sh -c "curl -s $base/ | grep -q 'id=\"root\"'"
  check "/tempo (route du front, nom d'une route de l'API) sert index.html" \
    sh -c "curl -s $base/tempo | grep -q 'id=\"root\"'"
  check "/ping sans /api est une route du front, pas de l'API" \
    sh -c "curl -s $base/ping | grep -q 'id=\"root\"'"
  check "/env.js identique à celui de l'image frontend" \
    diff <(expected_env_js) <(curl -s "$base/env.js")
  local f=med75-web-h-$RUN_ID
  start "$f" "$WEB_IMAGE"
  sleep 2
  check "en-têtes de réponse identiques à l'image frontend" \
    diff <(header_names "$base/tempo") <(header_names "http://127.0.0.1:$(host_port "$f")/tempo")

  section "Image client : configuration vue par les processus"
  check "PID 1 = tini (signaux relayés, zombies récoltés)" \
    sh -c "docker exec $c cat /proc/1/comm | grep -qx tini"
  check "uvicorn écoute sur 127.0.0.1:8000" \
    docker exec "$c" python -c "import socket;socket.create_connection(('127.0.0.1',8000),2)"
  check "uvicorn n'est pas joignable hors boucle locale (8000 non exposé)" loopback_only "$c"
  check "nginx charge le proxy /api sans tampon (export SSE)" \
    sh -c "docker exec $c nginx -T 2>/dev/null | grep -q 'proxy_buffering off;' && docker exec $c nginx -T 2>/dev/null | grep -q 'proxy_read_timeout 300s;'"
  check "/app/data existe et contient la base SQLite migrée" \
    sh -c "docker exec $c test -s /app/data/myelectricaldata.db"
  check "HEALTHCHECK de l'image : nginx puis /ping de l'API" \
    sh -c "docker inspect -f '{{json .Config.Healthcheck.Test}}' $c | grep -q 'ping'"
  # Régression : avec ALLOWED_HOSTS renseigné, la sonde (Host: 127.0.0.1) ne doit pas être refusée
  local h=med75-client-h-$RUN_ID
  start "$h" "$CLIENT_IMAGE" "${FAKE_ACCOUNT[@]}" -e ALLOWED_HOSTS=exemple.test
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null)" = healthy ] && break
    sleep 2
  done
  check "conteneur healthy" test "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null)" = healthy
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$h" 2>/dev/null)" = healthy ] && break
    sleep 2
  done
  check "conteneur healthy avec ALLOWED_HOSTS renseigné" test "$(docker inspect -f '{{.State.Health.Status}}' "$h" 2>/dev/null)" = healthy

  section "Image client : un processus meurt, le conteneur s'arrête"
  local api_pid
  api_pid=$(pid_of "$c" 'src.main:app') && docker exec "$c" sh -c "kill -9 $api_pid"
  check "uvicorn tué : conteneur arrêté sous 15 s, code non nul" exited_nonzero "$c" 15

  local n=med75-client-n-$RUN_ID
  start "$n" "$CLIENT_IMAGE" "${FAKE_ACCOUNT[@]}"
  wait_http "http://127.0.0.1:$(host_port "$n")/api/ping" 120 >/dev/null
  local nginx_pid
  nginx_pid=$(pid_of "$n" 'nginx: master') && docker exec "$n" sh -c "kill -9 $nginx_pid"
  check "nginx tué : conteneur arrêté sous 15 s, code non nul" exited_nonzero "$n" 15

  section "Image client : arrêt propre et persistance du volume"
  local v=med75-vol-$RUN_ID s=med75-client-s-$RUN_ID
  VOLUMES+=("$v")
  start "$s" "$CLIENT_IMAGE" "${FAKE_ACCOUNT[@]}" -v "$v:/app/data"
  wait_http "http://127.0.0.1:$(host_port "$s")/api/ping" 120 >/dev/null
  local ts
  ts=$(date +%s)
  docker stop -t 15 "$s" >/dev/null
  check "docker stop (SIGTERM) : arrêt sous 10 s, sans SIGKILL" stopped_clean "$s" $(($(date +%s) - ts))
  docker rm -f "$s" >/dev/null
  local s2=med75-client-s2-$RUN_ID
  start "$s2" "$CLIENT_IMAGE" "${FAKE_ACCOUNT[@]}" -v "$v:/app/data"
  check "conteneur recréé sur le même volume : base conservée, démarrage OK" ready_with_db "$s2"
}

# ---------------------------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1 && [ -x "$HOME/.rd/bin/docker" ]; then PATH=$HOME/.rd/bin:$PATH; fi
modes=("$@")
[ ${#modes[@]} -eq 0 ] && modes=(--static --frontend --client)
for m in "${modes[@]}"; do
  case "$m" in
    --static) test_static ;;
    --frontend) test_frontend_regression ;;
    --client) test_client ;;
    *) echo "option inconnue : $m" >&2; exit 2 ;;
  esac
done

printf '\n== Bilan : %d ✅  %d ❌\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
