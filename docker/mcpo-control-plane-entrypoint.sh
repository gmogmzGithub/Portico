#!/bin/sh
set -eu

export MCPO_REGULAR_AGGREGATOR_PORT="${MCPO_REGULAR_AGGREGATOR_PORT:-8080}"
export MCPO_CORE_AGGREGATOR_PORT="${MCPO_CORE_AGGREGATOR_PORT:-8082}"
export MCPO_NGINX_CONF="${MCPO_NGINX_CONF:-/etc/nginx/nginx.conf}"

# Generate self-signed SSL cert for nginx OAuth callback server (port 3834)
if [ ! -f /etc/nginx/ssl/oauth.crt ]; then
  mkdir -p /etc/nginx/ssl
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout /etc/nginx/ssl/oauth.key \
    -out /etc/nginx/ssl/oauth.crt \
    -days 3650 \
    -subj '/CN=localhost'
fi

if [ ! -f "$MCPO_NGINX_CONF" ]; then
  echo "FATAL: nginx config not found at $MCPO_NGINX_CONF" >&2
  exit 1
fi

exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/mcpo-control-plane.conf
