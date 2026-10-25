#!/bin/bash
set -euo pipefail
ssh mini 'bash "$HOME/Downloads/启动翻译服务.command" --no-open'
if [[ "${1:-}" != '--no-open' ]]; then open 'http://192.168.50.71:18746'; fi
echo 'Mini 翻译服务已就绪。'
