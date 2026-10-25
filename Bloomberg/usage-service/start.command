#!/bin/bash
set -euo pipefail
TRANSLATION_DIR="$HOME/services/translation-usage"
TRANSLATION_AGENT="$HOME/Library/LaunchAgents/com.neptuno.translation-usage.plist"
TRANSLATION_DOMAIN="gui/$(id -u)"
TRANSLATION_URL="http://192.168.50.71:18746"
if [[ ! -f "$TRANSLATION_DIR/server.py" ]]; then
  echo "未找到翻译服务：$TRANSLATION_DIR"
  exit 1
fi
if [[ ! -x "$TRANSLATION_DIR/bin/apple-translate" || "$TRANSLATION_DIR/AppleTranslate.swift" -nt "$TRANSLATION_DIR/bin/apple-translate" ]]; then
  echo '正在编译 Apple 本机翻译程序…'
  mkdir -p "$TRANSLATION_DIR/bin"
  xcrun swiftc -parse-as-library -O "$TRANSLATION_DIR/AppleTranslate.swift" -o "$TRANSLATION_DIR/bin/apple-translate"
fi
mkdir -p "$HOME/Library/LaunchAgents" "$TRANSLATION_DIR/data"
chmod 700 "$TRANSLATION_DIR/data"
if [[ ! -f "$TRANSLATION_AGENT" ]]; then
  cp "$TRANSLATION_DIR/com.neptuno.translation-usage.plist" "$TRANSLATION_AGENT"
fi
if ! launchctl print "$TRANSLATION_DOMAIN/com.neptuno.translation-usage" >/dev/null 2>&1; then
  launchctl bootstrap "$TRANSLATION_DOMAIN" "$TRANSLATION_AGENT"
fi
if ! curl -fsS --max-time 2 "$TRANSLATION_URL/health" >/dev/null 2>&1; then
  launchctl kickstart "$TRANSLATION_DOMAIN/com.neptuno.translation-usage"
fi
for TRANSLATION_ATTEMPT in {1..20}; do
  if curl -fsS --max-time 2 "$TRANSLATION_URL/health" >/dev/null 2>&1; then
    echo "翻译服务已运行：$TRANSLATION_URL"
    echo '已配置登录自动启动和异常重启；不会重复启动实例。'
    if [[ "${1:-}" != '--no-open' ]]; then open "$TRANSLATION_URL"; fi
    exit 0
  fi
  sleep 0.5
done
echo "服务未就绪，请查看 $TRANSLATION_DIR/data/error.log"
exit 1
