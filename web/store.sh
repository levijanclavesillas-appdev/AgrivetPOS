#!/usr/bin/env bash
# Chachi POS web — one store per container, at https://pos.chachisoftware.store/s/<store>/
# (TASK-062, TASK-065).
#
#   web/store.sh build                 build the image chachi-pos:<version> (and :latest)
#   web/store.sh create <store>        a new store at /s/<store>/, with its setup code
#   web/store.sh nginx <store>         (re)write the store's nginx location, and reload
#   web/store.sh list                  every store, its port and whether it is up
#   web/store.sh code <store>          the store's one-time setup code, to send its owner
#   web/store.sh upgrade               rebuild, then restart every store on the new image
#   web/store.sh logs <store>          the store's log
#
# A store is: /srv/chachi-pos/<store>/.env (its port, setup code and address), its data and
# backups in /var/lib/chachi-pos/<store>/{data,backups}, a container chachi-pos-<store> on
# the host's 127.0.0.1:<port>, and a location file in /etc/nginx/chachi-pos-stores/ that the
# pos.chachisoftware.store site includes. Every store shares that host and its certificate,
# so a new store needs no DNS record and no certificate of its own.
#
# Removing a store is deliberately not a command: it deletes a business's records. Stop
# its container, keep /var/lib/chachi-pos/<store>, and remove its location file by hand.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${POS_WEB_DOMAIN:-pos.chachisoftware.store}"
CONF_ROOT="${POS_WEB_CONF:-/srv/chachi-pos}"
DATA_ROOT="${POS_WEB_DATA:-/var/lib/chachi-pos}"
FIRST_PORT="${POS_WEB_FIRST_PORT:-8801}"
SITE_CONF="/etc/nginx/sites-available/$DOMAIN.conf"
STORES_DIR=/etc/nginx/chachi-pos-stores

say() { printf '%s\n' "$*"; }
die() { printf 'store.sh: %s\n' "$*" >&2; exit 1; }

version() { node -p "require('$REPO/package.json').version"; }

compose() {
  local store="$1"; shift
  docker compose -p "chachi-pos-$store" --env-file "$CONF_ROOT/$store/.env" -f "$REPO/web/compose.yml" "$@"
}

valid_store() {
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$ ]] || die "a store name is 1–30 lowercase letters, digits and dashes: $1"
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

# Once per server: the rate-limit zone, the proxy lines, the stores folder, and the one
# include in the pos.chachisoftware.store site that brings every store's location in.
nginx_base() {
  [ -f "$SITE_CONF" ] || die "no nginx site for $DOMAIN at $SITE_CONF"
  cp "$REPO/web/nginx-shared.conf" /etc/nginx/conf.d/chachi-pos.conf
  mkdir -p /etc/nginx/snippets "$STORES_DIR"
  cp "$REPO/web/nginx-proxy.snippet" /etc/nginx/snippets/chachi-pos-proxy.conf
  if ! grep -q "include $STORES_DIR/\*.conf;" "$SITE_CONF"; then
    cp "$SITE_CONF" "$SITE_CONF.before-chachi-pos"
    # Into the first server block (the HTTPS one certbot wrote), right after its name.
    sed -i "0,/server_name $DOMAIN;/s||&\n\n    # Chachi POS web stores (TASK-065): \/s\/<store>\/ → that store's container.\n    include $STORES_DIR/*.conf;|" "$SITE_CONF"
    say "Added the stores include to $SITE_CONF (the previous file is $SITE_CONF.before-chachi-pos)"
  fi
}

write_location() {
  local store="$1" port="$2" file="$STORES_DIR/$1.conf" previous=""
  nginx_base
  [ -f "$file" ] && previous="$(cat "$file")"
  sed -e "s/__STORE__/$store/g" -e "s/__PORT__/$port/g" "$REPO/web/nginx-store-location.conf.template" > "$file"
  if ! nginx -t 2>/dev/null; then
    if [ -n "$previous" ]; then printf '%s\n' "$previous" > "$file"; else rm -f "$file"; fi
    nginx -t || true
    die "nginx refused the store's location; it has been put back and nginx was not reloaded"
  fi
  systemctl reload nginx
}

# A store made before its address was part of its settings (TASK-065) gains it.
ensure_public_url() {
  local store="$1" env="$CONF_ROOT/$1/.env"
  if ! grep -q '^PUBLIC_URL=' "$env"; then
    printf 'PUBLIC_URL=https://%s/s/%s\n' "$DOMAIN" "$store" >> "$env"
    compose "$store" up -d
    wait_healthy "$store" || say "  $store is not healthy yet; see: store.sh logs $store"
  fi
}

cmd_create() {
  local store="${1:-}"; [ -n "$store" ] || die "usage: store.sh create <store>"
  valid_store "$store"
  [ -e "$CONF_ROOT/$store/.env" ] && die "$store already exists ($CONF_ROOT/$store/.env)"
  docker image inspect chachi-pos:latest >/dev/null 2>&1 || cmd_build

  local port code
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
PUBLIC_URL=https://$DOMAIN/s/$store
ENV
  compose "$store" up -d
  wait_healthy "$store" || die "chachi-pos-$store did not become healthy; see: store.sh logs $store"
  write_location "$store" "$port"
  say "Store:       https://$DOMAIN/s/$store/"
  say "Setup code:  $code   (send both to the store's owner; setup asks for the code)"
}

cmd_nginx() {
  local store="${1:-}"; [ -n "$store" ] || die "usage: store.sh nginx <store>"
  [ -f "$CONF_ROOT/$store/.env" ] || die "no such store: $store"
  ensure_public_url "$store"
  write_location "$store" "$(sed -n 's/^PORT=//p' "$CONF_ROOT/$store/.env")"
  say "Store:       https://$DOMAIN/s/$store/"
}

cmd_list() {
  local env store port state
  printf '%-24s %-6s %-10s %s\n' STORE PORT STATE ADDRESS
  for env in "$CONF_ROOT"/*/.env; do
    [ -f "$env" ] || continue
    store="$(sed -n 's/^STORE=//p' "$env")"; port="$(sed -n 's/^PORT=//p' "$env")"
    state="$(docker inspect -f '{{.State.Health.Status}}' "chachi-pos-$store" 2>/dev/null || echo stopped)"
    printf '%-24s %-6s %-10s https://%s/s/%s/\n' "$store" "$port" "$state" "$DOMAIN" "$store"
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
