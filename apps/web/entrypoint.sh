#!/bin/sh
set -e

# env.js et proxy /api (script partagé avec l'image client)
/runtime-config.sh

# Start nginx
exec nginx -g "daemon off;"
