#!/bin/sh
# Tests de l'entrypoint du front (proxy /api conditionnel, MED-52)
#
# Lance le vrai nginx:alpine avec apps/web/entrypoint.sh et apps/web/nginx.conf,
# devant un faux backend qui renvoie « backend <méthode> <URI> <Host> ».
#
# Usage : apps/web/tests/entrypoint.test.sh   (depuis la racine du dépôt, Docker requis)
set -u

WEB_DIR=${WEB_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
DOCKER=${DOCKER:-docker}
NET=med-entrypoint-test-$$
# Sous WEB_DIR : Docker Desktop / Rancher Desktop ne partagent pas toujours le TMPDIR de macOS
HTML=$(mktemp -d "$WEB_DIR/.entrypoint-test.XXXXXX")
echo '<html>spa</html>' > "$HTML/index.html"
FAIL=0

cleanup() {
  $DOCKER rm -f med-front-$$ med-back-$$ >/dev/null 2>&1
  $DOCKER network rm $NET >/dev/null 2>&1
  rm -rf "$HTML"
}
trap cleanup EXIT

ok() { echo "ok   $1"; }
ko() { echo "FAIL $1"; FAIL=1; }

$DOCKER network create $NET >/dev/null
$DOCKER run -d --name med-back-$$ --network $NET --network-alias backend nginx:alpine sh -c '
  printf "server { listen 8000; location / { default_type text/plain; return 200 \"backend \$request_method \$request_uri \$http_host\"; } }\n" > /etc/nginx/conf.d/default.conf
  exec nginx -g "daemon off;"' >/dev/null

# Requête depuis le conteneur du front (wget de busybox) : pas de port publié,
# le relais de ports de Rancher Desktop ne suit pas les réseaux dédiés
req() { path=$1; shift; $DOCKER exec med-front-$$ wget -qO- "$@" "http://127.0.0.1$path" 2>/dev/null; }

# Démarre le front avec les variables données, attend qu'il réponde (ou qu'il meure)
start_front() {
  $DOCKER rm -f med-front-$$ >/dev/null 2>&1
  $DOCKER run -d --name med-front-$$ --network $NET \
    -v "$WEB_DIR/entrypoint.sh:/entrypoint.sh:ro" \
    -v "$WEB_DIR/nginx.conf:/etc/nginx/conf.d/default.conf" \
    -v "$HTML:/usr/share/nginx/html" \
    "$@" --entrypoint /bin/sh nginx:alpine /entrypoint.sh >/dev/null
  i=0
  while [ $i -lt 40 ]; do
    [ "$($DOCKER inspect -f '{{.State.Running}}' med-front-$$ 2>/dev/null)" = true ] || return 1
    [ "$(req /)" = '<html>spa</html>' ] && return 0
    sleep 0.5; i=$((i + 1))
  done
  return 1
}

# 1. Sans API_PROXY_URL : comportement d'avant (Helm route /api par l'ingress)
if start_front; then
  body=$(req /api/ping)
  [ "$body" = '<html>spa</html>' ] && ok "sans API_PROXY_URL, /api reste servi par la SPA" || ko "sans API_PROXY_URL, /api/ping = '$body'"
  $DOCKER exec med-front-$$ nginx -T 2>/dev/null | grep -q proxy_pass && ko "sans API_PROXY_URL, la conf contient un proxy_pass" || ok "sans API_PROXY_URL, aucun proxy_pass"
else
  ko "sans API_PROXY_URL, le front ne démarre pas"
fi

# 2. Avec API_PROXY_URL : /api transmis tel quel au backend (comme l'ingress Helm, root_path=/api)
if start_front -e API_PROXY_URL=http://backend:8000; then
  body=$(req '/api/ping?x=1')
  [ "$body" = "backend GET /api/ping?x=1 127.0.0.1" ] && ok "GET /api/ping transmis avec /api et le Host d'origine" || ko "GET /api/ping = '$body'"
  body=$(req /api/accounts/auto-login --post-data=)
  case "$body" in "backend POST /api/accounts/auto-login "*) ok "POST /api transmis (plus de 405)";; *) ko "POST /api = '$body'";; esac
  body=$(req /dashboard)
  [ "$body" = '<html>spa</html>' ] && ok "les routes de la SPA restent servies" || ko "/dashboard = '$body'"
else
  ko "avec API_PROXY_URL, le front ne démarre pas"
fi

# 3. API_PROXY_URL invalide : refus au démarrage, pas d'injection dans la conf nginx
for bad in 'backend:8000' 'http://backend:8000; return 200 pwned' 'http://backend:8000/}'; do
  if start_front -e "API_PROXY_URL=$bad"; then
    ko "API_PROXY_URL='$bad' accepté"
  else
    ok "API_PROXY_URL='$bad' refusé"
  fi
done

[ $FAIL -eq 0 ] && echo "TOUS LES TESTS PASSENT" || echo "ÉCHECS"
exit $FAIL
