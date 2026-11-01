#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
NGINX_CONF="${PROJECT_ROOT}/infra/nginx/nginx.conf"
NGINX_PID="${PROJECT_ROOT}/infra/nginx/nginx.pid"

ACTION="${1:-status}"

case "${ACTION}" in
  start)
    if [ -f "${NGINX_PID}" ] && kill -0 "$(cat "${NGINX_PID}")" 2>/dev/null; then
      echo "Nginx is already running (PID $(cat "${NGINX_PID}"))"
    else
      nginx -t -c "${NGINX_CONF}"
      nginx -c "${NGINX_CONF}"
      echo "Nginx started on 127.0.0.1:8080 (PID $(cat "${NGINX_PID}"))"
    fi
    ;;
  stop)
    if [ -f "${NGINX_PID}" ] && kill -0 "$(cat "${NGINX_PID}")" 2>/dev/null; then
      nginx -c "${NGINX_CONF}" -s stop || true
      rm -f "${NGINX_PID}"
      echo "Nginx stopped"
    else
      echo "Nginx is not running"
    fi
    ;;
  reload)
    nginx -t -c "${NGINX_CONF}"
    nginx -c "${NGINX_CONF}" -s reload
    echo "Nginx reloaded successfully"
    ;;
  test)
    nginx -t -c "${NGINX_CONF}"
    ;;
  status)
    if [ -f "${NGINX_PID}" ] && kill -0 "$(cat "${NGINX_PID}")" 2>/dev/null; then
      echo "Nginx is running (PID $(cat "${NGINX_PID}"))"
    else
      echo "Nginx is stopped"
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|reload|test|status}"
    exit 1
    ;;
esac

