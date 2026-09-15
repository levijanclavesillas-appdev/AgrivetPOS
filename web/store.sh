#!/usr/bin/env bash
# Chachi POS web — one store per container (TASK-062).
#
#   web/store.sh build                 build the image chachi-pos:<version> (and :latest)
#   web/store.sh create <store>        a new store at <store>.pos.chachisoftware.store
#   web/store.sh list                  every store, its port and whether it is up
#   web/store.sh code <store>          the store's one-time setup code, to send its owner
#   web/store.sh upgrade               rebuild, then restart every store on the new image
#   web/store.sh logs <store>          the store's log
#
# A store is: /srv/chachi-pos/<store>/.env (its port and setup code), its data and backups
# in /var/lib/chachi-pos/<store>/{data,backups}, a container chachi-pos-<store> on the
# host's 127.0.0.1:<port>, and an nginx vhost. The vhost and its certificate are made only
# once <store>.pos.chachisoftware.store resolves to this machine — until then the script
# says which DNS record is missing and leaves nginx alone.
#
# Removing a store is deliberately not a command: it deletes a business's records. Stop
# its container, keep /var/lib/chachi-pos/<store>, and remove the vhost by hand.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${POS_WEB_DOMAIN:-pos.chachisoftware.store}"
CONF_ROOT="${POS_WEB_CONF:-/srv/chachi-pos}"
DATA_ROOT="${POS_WEB_DATA:-/var/lib/chachi-pos}"
FIRST_PORT="${POS_WEB_FIRST_PORT:-8801}"
NGINX_SITES=/etc/nginx/sites-available
NGINX_ENABLED=/etc/nginx/sites-enabled

say() { printf '%s\n' "$*"; }
die() { printf 'store.sh: %s\n' "$*" >&2; exit 1; }

version() { node -p "require('$REPO/package.json').version"; }

compose() {
  local store="$1"; shift
  docker compose -p "chachi-pos-$store" --env-file "$CONF_ROOT/$store/.env" -f "$REPO/web/compose.yml" "$@"
}

valid_store() {
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$ ]] || die "a store name is 1–30 lowercase letters, digits and dashes: $1"
  case "$1" in www|admin|api|link|mail|static|guide) die "$1 is reserved" ;; esac
}

next_port() {
  local port="$FIRST_PORT" used
  used="$(cat "$CONF_ROOT"/*/.env 2>/dev/null | sed -n 's/^PORT=//p' | sort -n)"
  while grep -qx "$port" <<<"$used" || ss -ltn "( sport = :$port )" | grep -q ":$port"; do port=$((port + 1)); done
  echo "$port"
}

cmd_build() {
  local v; v="$(version)"
  say "Building chachi-pos:$v from $REPO"
  docker build -f "$REPO/web/Dockerfile" -t "chachi-pos:$v" -t chachi-pos:latest "$REPO"
}

wait_healthy() {
  local store="$1" i
  for i in $(seq 1 40); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "chachi-pos-$store" 2>/dev/null)" = healthy ] && return 0
    sleep 1
  done
  return 1
}

install_nginx() {
  local store="$1" port="$2" host="$store.$DOMAIN" site
  site="$NGINX_SITES/$host.conf"
  if [ ! -f /etc/nginx/conf.d/chachi-pos.conf ]; then
    cp "$REPO/web/nginx-shared.conf" /etc/nginx/conf.d/chachi-pos.conf
  fi
  mkdir -p /etc/nginx/snippets
  cp "$REPO/web/nginx-proxy.snippet" /etc/nginx/snippets/chachi-pos-proxy.conf
  sed -e "s/__HOST__/$host/g" -e "s/__PORT__/$port/g" -e "s/__STORE__/$store/g" \
    "$REPO/web/nginx-store.conf.template" > "$site"
  ln -sf "$site" "$NGINX_ENABLED/$host.conf"
  if ! nginx -t 2>/dev/null; then
    rm -f "$NGINX_ENABLED/$host.conf"
    nginx -t || true
    die "nginx refused the new vhost; it has been disabled again and nginx was not reloaded"
  fi
  systemctl reload nginx
  certbot --nginx -d "$host" --non-interactive --redirect --keep-until-expiring \
    || say "certbot did not finish; run: certbot --nginx -d $host"
}

cmd_create() {
  local store="${1:-}"; [ -n "$store" ] || die "usage: store.sh create <store>"
  valid_store "$store"
  [ -e "$CONF_ROOT/$store/.env" ] && die "$store already exists ($CONF_ROOT/$store/.env)"
  docker image inspect chachi-pos:latest >/dev/null 2>&1 || cmd_build

  local port code host="$store.$DOMAIN"
  port="$(next_port)"
  code="$(node "$REPO/src/config/hosting.js" new-setup-code)"
  mkdir -p "$CONF_ROOT/$store" "$DATA_ROOT/$store/data" "$DATA_ROOT/$store/backups"
  chown 1000:1000 "$DATA_ROOT/$store/data" "$DATA_ROOT/$store/backups"   # the image's node user
  chmod 700 "$DATA_ROOT/$store"
  umask 077
  cat > "$CONF_ROOT/$store/.env" <<ENV
STORE=$store
PORT=$port
SETUP_CODE=$code
STORE_ROOT=$DATA_ROOT/$store
ENV
  compose "$store" up -d
  wait_healthy "$store" || die "chachi-pos-$store did not become healthy; see: store.sh logs $store"

  local here there
  here="$(curl -s -4 --max-time 5 ifconfig.me || true)"
  there="$(getent hosts "$host" | awk '{print $1}' | head -1 || true)"
  if [ -n "$there" ] && [ "$there" = "$here" ]; then
    install_nginx "$store" "$port"
    say "Store:       https://$host"
  else
    say "Store:       running on 127.0.0.1:$port, not yet on the internet."
    say "             $host does not resolve to this machine ($here)."
    say "             Add a DNS A record for $host (or *.$DOMAIN) to $here, then run:"
    say "             POS_WEB_DOMAIN=$DOMAIN $0 nginx $store"
  fi
  say "Setup code:  $code   (send it to the store's owner with the address; setup asks for it)"
}

cmd_nginx() {
  local store="${1:-}"; [ -n "$store" ] || die "usage: store.sh nginx <store>"
  [ -f "$CONF_ROOT/$store/.env" ] || die "no such store: $store"
  install_nginx "$store" "$(sed -n 's/^PORT=//p' "$CONF_ROOT/$store/.env")"
}

cmd_list() {
  local env store port state
  printf '%-24s %-6s %-10s %s\n' STORE PORT STATE ADDRESS
  for env in "$CONF_ROOT"/*/.env; do
    [ -f "$env" ] || continue
    store="$(sed -n 's/^STORE=//p' "$env")"; port="$(sed -n 's/^PORT=//p' "$env")"
    state="$(docker inspect -f '{{.State.Health.Status}}' "chachi-pos-$store" 2>/dev/null || echo stopped)"
    printf '%-24s %-6s %-10s https://%s.%s\n' "$store" "$port" "$state" "$store" "$DOMAIN"
  done
}

cmd_code() {
  local store="${1:-}"; [ -f "$CONF_ROOT/$store/.env" ] || die "no such store: $store"
  sed -n 's/^SETUP_CODE=//p' "$CONF_ROOT/$store/.env"
}

cmd_upgrade() {
  cmd_build
  local env store
  for env in "$CONF_ROOT"/*/.env; do
    [ -f "$env" ] || continue
    store="$(sed -n 's/^STORE=//p' "$env")"
    say "Restarting $store on the new image (it backs up before migrating)"
    compose "$store" up -d --force-recreate
    wait_healthy "$store" || say "  $store is not healthy yet; see: store.sh logs $store"
  done
}

cmd_logs() { local store="${1:-}"; [ -f "$CONF_ROOT/$store/.env" ] || die "no such store: $store"; compose "$store" logs --tail 200 -f; }

case "${1:-}" in
  build) cmd_build ;;
  create) shift; cmd_create "$@" ;;
  nginx) shift; cmd_nginx "$@" ;;
  list) cmd_list ;;
  code) shift; cmd_code "$@" ;;
  upgrade) cmd_upgrade ;;
  logs) shift; cmd_logs "$@" ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
