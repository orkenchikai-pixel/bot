#!/usr/bin/env bash
# dental-bot — установка и управление ИИ-администратором стоматологии.
#
#   dental-bot help        список команд
#
# Мастер установки (dental-bot install) запускается из install.sh. Ответы на все вопросы можно
# передать переменными окружения и установить бота без вопросов: NONINTERACTIVE=1 (см. help).
set -Eeuo pipefail
umask 077

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
APP_DIR="${DENTAL_BOT_DIR:-$(cd "$(dirname "$SELF")/.." && pwd)}"
ENV_FILE="$APP_DIR/.env"
CLINICS_REL="clinics.local"
CLINICS_DIR="$APP_DIR/$CLINICS_REL"
TEMPLATE="$APP_DIR/clinics/demo.json"
IMAGE="dental-bot-agent"
APP_UID=1000 # пользователь node в образе node:22-slim: от его имени работает бот в контейнере
INSTALL_URL="https://raw.githubusercontent.com/orkenchikai-pixel/bot/main/install.sh"
LOG_FILE="${LOG_FILE:-/var/log/dental-bot.log}"
INSTALL_TTY="${INSTALL_TTY:-/dev/tty}"
NONINTERACTIVE="${NONINTERACTIVE:-0}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
ANTHROPIC_API_URL="${ANTHROPIC_API_URL:-https://api.anthropic.com}"
GRAPH_API_URL="${GRAPH_API_URL:-https://graph.facebook.com}"
TELEGRAM_API_URL="${TELEGRAM_API_URL:-https://api.telegram.org}"

# Значения, пришедшие из окружения (для установки без вопросов), — до того как их заменят ответы.
ENV_WA_TOKEN="${WHATSAPP_ACCESS_TOKEN:-}"
ENV_APP_SECRET="${WHATSAPP_APP_SECRET:-}"
ENV_TG_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
ENV_CLINIC_CURRENCY="${CLINIC_CURRENCY:-}"

DOMAIN="${DOMAIN:-}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
WHATSAPP_SETUP="${WHATSAPP_SETUP:-}"
WHATSAPP_PHONE_NUMBER_ID="${WHATSAPP_PHONE_NUMBER_ID:-}"
WHATSAPP_APP_SECRET="${WHATSAPP_APP_SECRET:-}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
CLINIC_NAME="${CLINIC_NAME:-}"
CLINIC_TIMEZONE="${CLINIC_TIMEZONE:-}"
CLINIC_CURRENCY="${CLINIC_CURRENCY:-}"
CLINIC_ADDRESS="${CLINIC_ADDRESS:-}"
CLINIC_PHONE="${CLINIC_PHONE:-}"
CLINIC_HOURS="${CLINIC_HOURS:-}"
CLINIC_OPERATOR="${CLINIC_OPERATOR:-}"
# CLINIC_POLICY_URL намеренно не инициализируется: «не задана» и «пустая» — разные случаи.

TMP_DIR=""
INPUT_OPEN=0
ANSWER=""
CHOICE=""
NORMALIZED=""
VALIDATION_ERROR=""
SERVER_IP="${SERVER_IP:-}"
HTTP_CODE=""
HTTP_BODY=""
CLINIC_FILE=""
CLINIC_ID=""
CLINIC_IS_NEW=1
WA_TOKEN=""
WA_TOKEN_VAR="WHATSAPP_ACCESS_TOKEN"
WA_DISPLAY=""
WA_APP_ID=""
WA_TOKEN_TEMPORARY=0
WA_FORCE=0
TG_FORCE=0
TG_CHATS=""
TG_BOT_USERNAME=""
TELEGRAM_SETUP=""

# ───────────────────────────── вывод ─────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BOLD=$'\033[1m' C_DIM=$'\033[2m' C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_CYAN=$'\033[36m' C_RESET=$'\033[0m'
else
  C_BOLD="" C_DIM="" C_RED="" C_GREEN="" C_YELLOW="" C_CYAN="" C_RESET=""
fi

say() { printf '%s\n' "$*"; }
info() { printf '%s\n' "${C_CYAN}›${C_RESET} $*"; }
ok() { printf '%s\n' "${C_GREEN}✓${C_RESET} $*"; }
warn() { printf '%s\n' "${C_YELLOW}!${C_RESET} $*" >&2; }
hint() { printf '%s\n' "  ${C_DIM}$*${C_RESET}"; }
title() { printf '\n%s\n' "${C_BOLD}$*${C_RESET}"; }
die() {
  printf '%s\n' "${C_RED}✗ $*${C_RESET}" >&2
  exit 1
}
interactive() { [ "$NONINTERACTIVE" != 1 ]; }
is_root() { [ "$(id -u)" -eq 0 ]; }

cleanup() {
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}
on_error() {
  local code=$? line="$1"
  printf '\n%s\n' "${C_RED}✗ Неожиданная ошибка (строка $line, код $code).${C_RESET}" >&2
  printf '%s\n' "Подробности — в журнале $LOG_FILE. Команду можно запустить ещё раз: это безопасно." >&2
}
trap cleanup EXIT
trap 'on_error $LINENO' ERR
TMP_DIR="$(mktemp -d)"

init_log() {
  if ! { touch "$LOG_FILE" && chmod 600 "$LOG_FILE"; } 2>/dev/null; then
    LOG_FILE="$TMP_DIR/dental-bot.log"
    : >"$LOG_FILE"
  fi
  printf '\n===== %s dental-bot %s =====\n' "$(date '+%F %T')" "${COMMAND:-}" >>"$LOG_FILE"
}

# Длинные команды пишут вывод в журнал, а на экран — только итог. При ошибке показываем хвост журнала.
run_logged() {
  local message="$1"
  shift
  info "$message"
  printf '\n### %s: %s\n' "$(date '+%T')" "$*" >>"$LOG_FILE"
  if "$@" >>"$LOG_FILE" 2>&1; then return 0; fi
  warn "Не получилось. Последние строки журнала ($LOG_FILE):"
  tail -n 25 "$LOG_FILE" >&2
  return 1
}

require_root() {
  if ! is_root && [ "${SKIP_ROOT_CHECK:-0}" != 1 ]; then
    die "Нужны права администратора: sudo dental-bot ${COMMAND:-help}"
  fi
}

require_installed() {
  [ -f "$ENV_FILE" ] || die "Бот ещё не установлен. Установка: bash <(curl -fsSL $INSTALL_URL)"
  command -v docker >/dev/null 2>&1 || die "Не найден Docker. Запустите установку ещё раз."
}

# ───────────────────────────── ввод ─────────────────────────────

open_input() {
  interactive || return 0
  [ "$INPUT_OPEN" = 1 ] && return 0
  if ! (: <"$INSTALL_TTY") 2>/dev/null; then
    die "Нет терминала для вопросов. Запустите команду в консоли сервера или задайте ответы переменными окружения и NONINTERACTIVE=1 (dental-bot help)."
  fi
  exec 3<"$INSTALL_TTY"
  INPUT_OPEN=1
}

# Убирает \r, пробелы по краям и кавычки вокруг — их часто захватывают при копировании.
clean() {
  local v="${1//$'\r'/}"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  case "$v" in
    \"*\") v="${v#\"}" && v="${v%\"}" ;;
    \'*\') v="${v#\'}" && v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}

mask() {
  local v="$1"
  if [ "${#v}" -le 12 ]; then printf '•••'; else printf '%s…%s' "${v:0:6}" "${v: -4}"; fi
}

# read_line "Вопрос" [по умолчанию] → $ANSWER
read_line() {
  local prompt="$1" def="${2-}" line=""
  if [ -n "$def" ]; then prompt="$prompt ${C_DIM}[$def]${C_RESET}"; fi
  printf '%s ' "${C_BOLD}?${C_RESET} $prompt:"
  if ! IFS= read -r line <&3; then
    if [ -z "$line" ]; then
      printf '\n'
      die "Ввод прерван."
    fi
  fi
  if [ ! -t 3 ]; then printf '\n'; fi
  line="$(clean "$line")"
  ANSWER="${line:-$def}"
}

# read_secret "Вопрос" [по умолчанию] → $ANSWER (ввод не отображается на экране)
read_secret() {
  local prompt="$1" def="${2-}" line=""
  if [ -n "$def" ]; then prompt="$prompt ${C_DIM}[Enter — оставить $(mask "$def")]${C_RESET}"; fi
  printf '%s ' "${C_BOLD}?${C_RESET} $prompt:"
  if ! IFS= read -rs line <&3; then
    if [ -z "$line" ]; then
      printf '\n'
      die "Ввод прерван."
    fi
  fi
  printf '\n'
  line="$(clean "$line")"
  if [ -n "$line" ]; then hint "получено: $(mask "$line")"; fi
  ANSWER="${line:-$def}"
}

# ask ПЕРЕМЕННАЯ "Вопрос" проверка [по умолчанию] [secret]
# Без вопросов (NONINTERACTIVE=1) берётся значение по умолчанию — переменная окружения или
# текущая настройка. Проверка может заменить ответ на нормализованный ($NORMALIZED).
ask() {
  local var="$1" prompt="$2" validator="$3" def="${4-}" secret="${5-}" value
  while :; do
    if ! interactive; then
      value="$def"
    elif [ -n "$secret" ]; then
      read_secret "$prompt" "$def"
      value="$ANSWER"
    else
      read_line "$prompt" "$def"
      value="$ANSWER"
    fi
    VALIDATION_ERROR=""
    NORMALIZED="$value"
    if "$validator" "$value"; then
      printf -v "$var" '%s' "$NORMALIZED"
      return 0
    fi
    interactive || die "$var: ${VALIDATION_ERROR:-неверное значение}"
    warn "${VALIDATION_ERROR:-Неверное значение, попробуйте ещё раз.}"
  done
}

# choose "Вопрос" номер_по_умолчанию "Вариант 1" "Вариант 2" … → $CHOICE
choose() {
  local prompt="$1" def="$2" i=1 option
  shift 2
  if ! interactive; then
    CHOICE="$def"
    return 0
  fi
  say "$prompt"
  for option in "$@"; do
    say "  $i) $option"
    i=$((i + 1))
  done
  while :; do
    read_line "Введите номер" "$def"
    if [[ "$ANSWER" =~ ^[0-9]+$ ]] && [ "$ANSWER" -ge 1 ] && [ "$ANSWER" -le $# ]; then
      CHOICE="$ANSWER"
      return 0
    fi
    warn "Введите число от 1 до $#."
  done
}

# confirm "Вопрос" y|n — да/нет, Enter выбирает вариант по умолчанию.
confirm() {
  local def="${2:-y}" hint_text="[Д/н]"
  if ! interactive; then
    [ "$def" = y ]
    return
  fi
  if [ "$def" != y ]; then hint_text="[д/Н]"; fi
  while :; do
    read_line "$1 $hint_text" ""
    case "$ANSWER" in
      "") [ "$def" = y ] && return 0 || return 1 ;;
      y | Y | yes | Yes | д | Д | да | Да | ДА) return 0 ;;
      n | N | no | No | н | Н | нет | Нет | НЕТ) return 1 ;;
      *) warn "Ответьте «д» (да) или «н» (нет)." ;;
    esac
  done
}

# ───────────────────────────── .env ─────────────────────────────

env_get() {
  local key="$1" file="${2:-$ENV_FILE}"
  [ -f "$file" ] || return 0
  KEY="$key" awk 'BEGIN { k = ENVIRON["KEY"] } index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$file"
}

# Заменяет строку KEY=… или добавляет её. Значение передаётся через окружение awk, а не аргументом,
# поэтому секреты не видны в списке процессов и спецсимволы не портятся.
set_env() {
  local key="$1" value="$2" tmp
  case "$value" in *$'\n'* | *$'\r'*) die "Недопустимый перевод строки в значении $key" ;; esac
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  KEY="$key" VALUE="$value" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 } next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}

# Секрет создаётся один раз и больше не меняется (особенно ключ шифрования базы: без него данные не прочитать).
ensure_secret() {
  local key="$1" bytes="$2"
  [ -n "$(env_get "$key")" ] && return 0
  set_env "$key" "$(openssl rand -hex "$bytes")"
}

ensure_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    cp "$APP_DIR/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    set_env SIMULATOR_ENABLED true
  fi
  chmod 600 "$ENV_FILE"
}

# ───────────────────────────── HTTP ─────────────────────────────

json_get() { jq -r "$1 // empty" 2>/dev/null <<<"$2" || true; }

curl_escape() {
  local v="${1//\\/\\\\}"
  printf '%s' "${v//\"/\\\"}"
}

# http МЕТОД URL [ЗАГОЛОВОК…] [--data ТЕЛО] → $HTTP_CODE, $HTTP_BODY
# Адрес и заголовки (в них ключи) пишутся во временный конфиг curl, а не в аргументы команды.
http() {
  local method="$1" url="$2" cfg="$TMP_DIR/curl.cfg" out="$TMP_DIR/curl.out" data="$TMP_DIR/curl.data"
  shift 2
  rm -f "$data"
  printf 'url = "%s"\nrequest = "%s"\n' "$(curl_escape "$url")" "$method" >"$cfg"
  while [ $# -gt 0 ]; do
    if [ "$1" = --data ]; then
      printf '%s' "$2" >"$data"
      printf 'data-binary = "@%s"\n' "$data" >>"$cfg"
      shift 2
    else
      printf 'header = "%s"\n' "$(curl_escape "$1")" >>"$cfg"
      shift
    fi
  done
  HTTP_CODE="$(curl -sS --max-time 20 --config "$cfg" -o "$out" -w '%{http_code}' 2>>"$LOG_FILE" || true)"
  HTTP_BODY="$(cat "$out" 2>/dev/null || true)"
  rm -f "$cfg" "$out" "$data"
  if [ -z "$HTTP_CODE" ]; then HTTP_CODE=000; fi
}

graph_version() {
  local v
  v="$(env_get WHATSAPP_API_VERSION)"
  printf '%s' "${v:-v27.0}"
}

# ───────────────────────────── проверки ответов ─────────────────────────────

v_text() {
  local v="$1"
  if [ "${#v}" -lt 2 ]; then
    VALIDATION_ERROR="Нужен ответ (хотя бы 2 символа)."
    return 1
  fi
  if [ "${#v}" -gt 300 ]; then
    VALIDATION_ERROR="Слишком длинно — до 300 символов."
    return 1
  fi
  case "$v" in *[[:cntrl:]]*)
    VALIDATION_ERROR="Недопустимые символы."
    return 1
    ;;
  esac
}

v_short() {
  local v="$1"
  if [ "${#v}" -lt 1 ] || [ "${#v}" -gt 24 ]; then
    VALIDATION_ERROR="Например: ₸, ₽, сум, сом."
    return 1
  fi
}

v_phone() {
  local re='^\+?[0-9][0-9 ()-]{4,24}$'
  [[ "$1" =~ $re ]] && return 0
  VALIDATION_ERROR="Телефон, например +7 701 234 56 78"
  return 1
}

v_url_optional() {
  local v="$1" re='^https?://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:[0-9]+)?(/[^[:space:]"\\]*)?$'
  if [ -z "$v" ]; then
    NORMALIZED=""
    return 0
  fi
  [[ "$v" =~ ^https?:// ]] || v="https://$v"
  if [[ ! "$v" =~ $re ]]; then
    VALIDATION_ERROR="Ссылка вида https://my-clinic.kz/privacy"
    return 1
  fi
  NORMALIZED="$v"
}

v_timezone() {
  if [[ ! "$1" =~ ^[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2}$ ]]; then
    VALIDATION_ERROR="Часовой пояс в формате Регион/Город, например Asia/Almaty."
    return 1
  fi
  if [ -d /usr/share/zoneinfo ] && [ ! -e "/usr/share/zoneinfo/$1" ]; then
    VALIDATION_ERROR="Неизвестный часовой пояс: $1"
    return 1
  fi
}

normalize_domain() {
  local d="${1,,}"
  d="${d#http://}"
  d="${d#https://}"
  d="${d%%/*}"
  d="${d%.}"
  printf '%s' "$d"
}

v_domain() {
  local d re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
  d="$(normalize_domain "$1")"
  if [ "$d" = localhost ] || { [ "${#d}" -le 253 ] && [[ "$d" =~ $re ]]; }; then
    NORMALIZED="$d"
    return 0
  fi
  VALIDATION_ERROR="Это не похоже на домен. Пример: bot.my-clinic.kz (без https:// и пробелов; кириллический домен — в виде xn--…)."
  return 1
}

v_anthropic() {
  if [[ ! "$1" =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]]; then
    VALIDATION_ERROR="Ключ Claude начинается с sk-ant- и длиннее 20 символов. Скопируйте его целиком."
    return 1
  fi
  check_anthropic_key "$1"
}

# Крошечный запрос к модели: проверяет сразу ключ, доступ к модели и баланс (стоит доли цента).
check_anthropic_key() {
  local key="$1" model message
  [ "${SKIP_KEY_CHECKS:-0}" = 1 ] && return 0
  model="$(env_get AGENT_MODEL)"
  model="${model:-claude-opus-5-5}"
  info "Проверяю ключ Claude…"
  http POST "$ANTHROPIC_API_URL/v1/messages" "x-api-key: $key" "anthropic-version: 2023-06-01" "content-type: application/json" \
    --data "{\"model\":\"$model\",\"max_tokens\":16,\"output_config\":{\"effort\":\"low\"},\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}"
  message="$(json_get '.error.message' "$HTTP_BODY")"
  case "$HTTP_CODE" in
    200)
      ok "Ключ Claude работает (модель $model)"
      return 0
      ;;
    401) VALIDATION_ERROR="Ключ не подошёл. Скопируйте его ещё раз целиком: platform.claude.com → API Keys." ;;
    402) VALIDATION_ERROR="Проблема с оплатой: пополните баланс в platform.claude.com → Billing. ($message)" ;;
    403) VALIDATION_ERROR="У ключа нет доступа: $message" ;;
    404) VALIDATION_ERROR="Модель $model недоступна для этого ключа: $message" ;;
    400)
      if grep -qi credit <<<"$message"; then
        VALIDATION_ERROR="На балансе Claude нет средств: пополните в platform.claude.com → Billing и повторите."
      else
        VALIDATION_ERROR="Claude отклонил запрос: $message"
      fi
      ;;
    429)
      warn "Claude ответил «лимит запросов» ($message). Ключ рабочий; если это лимит расходов — поднимите его в Billing."
      return 0
      ;;
    000)
      warn "Не удалось связаться с api.anthropic.com — ключ проверю при запуске бота."
      return 0
      ;;
    5*)
      warn "Сервис Claude временно недоступен ($HTTP_CODE) — продолжаю без проверки."
      return 0
      ;;
    *) VALIDATION_ERROR="Неожиданный ответ Claude ($HTTP_CODE): $message" ;;
  esac
  return 1
}

v_phone_id() {
  local other
  if [[ ! "$1" =~ ^[0-9]{6,25}$ ]]; then
    VALIDATION_ERROR="Phone number ID — длинное число (обычно 15–16 цифр) со страницы WhatsApp → API Setup. Это не номер телефона."
    return 1
  fi
  other="$(clinic_with_phone_id "$1")"
  if [ -n "$other" ]; then
    VALIDATION_ERROR="Этот номер уже подключён к клинике $other."
    return 1
  fi
}

# check_whatsapp PHONE_ID TOKEN [quiet] — номер существует и токен имеет к нему доступ.
check_whatsapp() {
  local phone_id="$1" token="$2" quiet="${3-}" code message name expires
  WA_DISPLAY="" WA_APP_ID="" WA_TOKEN_TEMPORARY=0
  [ "${SKIP_KEY_CHECKS:-0}" = 1 ] && return 0
  [ -n "$quiet" ] || info "Проверяю доступ к WhatsApp…"
  http GET "$GRAPH_API_URL/$(graph_version)/$phone_id?fields=display_phone_number,verified_name" "Authorization: Bearer $token"
  case "$HTTP_CODE" in
    200)
      WA_DISPLAY="$(json_get '.display_phone_number' "$HTTP_BODY")"
      name="$(json_get '.verified_name' "$HTTP_BODY")"
      [ -n "$quiet" ] || ok "WhatsApp: номер ${WA_DISPLAY:-?}${name:+ ($name)}"
      ;;
    000)
      [ -n "$quiet" ] || warn "Нет связи с graph.facebook.com — проверку пропускаю."
      return 0
      ;;
    *)
      code="$(json_get '.error.code' "$HTTP_BODY")"
      message="$(json_get '.error.message' "$HTTP_BODY")"
      case "$code" in
        190) VALIDATION_ERROR="Токен недействителен или истёк ($message). Нужен постоянный токен системного пользователя." ;;
        100 | 803) VALIDATION_ERROR="Phone number ID не найден или у токена нет к нему доступа ($message)." ;;
        *) VALIDATION_ERROR="Meta ответила ошибкой: ${message:-HTTP $HTTP_CODE}" ;;
      esac
      return 1
      ;;
  esac
  # Срок действия токена и приложение, для которого он выпущен (по нему проверим App Secret).
  http GET "$GRAPH_API_URL/$(graph_version)/debug_token?input_token=$token" "Authorization: Bearer $token"
  if [ "$HTTP_CODE" = 200 ]; then
    WA_APP_ID="$(json_get '.data.app_id' "$HTTP_BODY")"
    expires="$(json_get '.data.expires_at' "$HTTP_BODY")"
    if [[ "$expires" =~ ^[0-9]+$ ]] && [ "$expires" != 0 ]; then
      WA_TOKEN_TEMPORARY=1
      WA_TOKEN_EXPIRES="$(date -d "@$expires" '+%d.%m.%Y %H:%M' 2>/dev/null || printf '%s' "$expires")"
    fi
  fi
  return 0
}

v_wa_token() {
  if [[ ! "$1" =~ ^EA[A-Za-z0-9]{20,}$ ]]; then
    VALIDATION_ERROR="Токен WhatsApp начинается с EA… и длиннее 20 символов. Скопируйте его целиком."
    return 1
  fi
  check_whatsapp "$WHATSAPP_PHONE_NUMBER_ID" "$1" || return 1
  if [ "$WA_TOKEN_TEMPORARY" = 1 ]; then
    warn "У этого токена есть срок действия (до ${WA_TOKEN_EXPIRES:-?}): потом бот перестанет отвечать в WhatsApp."
    if interactive && ! confirm "Всё равно использовать его? Лучше создать постоянный" n; then
      VALIDATION_ERROR="Вставьте постоянный токен системного пользователя (срок «Никогда»)."
      return 1
    fi
  fi
}

# App Secret проверяем «токеном приложения» APP_ID|SECRET — Meta принимает его, только если секрет верный.
check_app_secret() {
  local secret="$1" quiet="${2-}"
  [ "${SKIP_KEY_CHECKS:-0}" = 1 ] && return 0
  [ -n "$WA_APP_ID" ] || return 0
  http GET "$GRAPH_API_URL/$(graph_version)/$WA_APP_ID?fields=id&access_token=$WA_APP_ID%7C$secret"
  case "$HTTP_CODE" in
    200)
      [ -n "$quiet" ] || ok "App Secret подходит"
      return 0
      ;;
    000)
      [ -n "$quiet" ] || warn "Нет связи с Meta — App Secret проверю позже."
      return 0
      ;;
  esac
  VALIDATION_ERROR="App Secret не подходит к приложению, для которого выпущен токен (ID $WA_APP_ID). Откройте настройки именно этого приложения."
  return 1
}

v_app_secret() {
  if [[ ! "$1" =~ ^[0-9a-f]{32}$ ]]; then
    VALIDATION_ERROR="App Secret — 32 символа (цифры и буквы a–f): Настройки приложения → Основное → Секрет приложения → Показать."
    return 1
  fi
  check_app_secret "$1"
}

v_telegram_token() {
  if [[ ! "$1" =~ ^[0-9]{5,15}:[A-Za-z0-9_-]{30,}$ ]]; then
    VALIDATION_ERROR="Токен бота выглядит так: 1234567890:AAH…  Его присылает @BotFather."
    return 1
  fi
  [ "${SKIP_KEY_CHECKS:-0}" = 1 ] && return 0
  http GET "$TELEGRAM_API_URL/bot$1/getMe"
  case "$HTTP_CODE" in
    200)
      TG_BOT_USERNAME="$(json_get '.result.username' "$HTTP_BODY")"
      ok "Бот Telegram: @$TG_BOT_USERNAME"
      return 0
      ;;
    000)
      warn "Нет связи с api.telegram.org — проверить токен не удалось."
      return 0
      ;;
  esac
  VALIDATION_ERROR="Telegram не принял токен: $(json_get '.description' "$HTTP_BODY")"
  return 1
}

v_chat_ids() {
  local id ids=()
  IFS=, read -ra ids <<<"$1"
  for id in "${ids[@]}"; do
    id="$(clean "$id")"
    if [[ ! "$id" =~ ^-?[0-9]{1,20}$ ]]; then
      VALIDATION_ERROR="chat_id — число, например 123456789 или -1001234567890 для группы."
      return 1
    fi
  done
}

# ───────────────────────────── DNS и сервер ─────────────────────────────

detect_server_ip() {
  [ -n "$SERVER_IP" ] && return 0
  [ "${SKIP_DNS_CHECK:-0}" = 1 ] && return 0
  local url ip
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -4 -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
      SERVER_IP="$ip"
      return 0
    fi
  done
}

dns_continue() {
  confirm "Продолжить установку? Сертификат HTTPS появится сам, когда DNS заработает" y ||
    die "Исправьте DNS и запустите установку ещё раз."
}

check_dns() {
  local domain="$1" ips v6
  if [ "${SKIP_DNS_CHECK:-0}" = 1 ] || [ "$domain" = localhost ]; then return 0; fi
  ips="$(getent ahostsv4 "$domain" 2>/dev/null | awk '{ print $1 }' | sort -u | paste -sd ' ' - || true)"
  if [ -z "$ips" ]; then
    warn "Домен $domain пока не находится в DNS."
    hint "Добавьте у регистратора домена A-запись: $domain → ${SERVER_IP:-IP этого сервера}."
    hint "Запись начинает работать через 5 минут — несколько часов."
    dns_continue
    return 0
  fi
  if [ -n "$SERVER_IP" ] && [[ " $ips " != *" $SERVER_IP "* ]]; then
    warn "Домен $domain указывает на $ips, а у этого сервера адрес $SERVER_IP."
    hint "Исправьте A-запись у регистратора, иначе сертификат HTTPS не выдадут."
    dns_continue
    return 0
  fi
  ok "DNS в порядке: $domain → $ips"
  v6="$(getent ahostsv6 "$domain" 2>/dev/null | awk '{ print $1 }' | grep -v '^::ffff:' | sort -u | paste -sd ' ' - || true)"
  if [ -n "$v6" ] && ! ip -6 addr show scope global 2>/dev/null | grep -q inet6; then
    warn "У домена есть IPv6-запись (AAAA: $v6), а у сервера IPv6 нет. Удалите AAAA-запись, иначе сертификат может не выдаться."
  fi
}

# ───────────────────────────── клиники ─────────────────────────────

list_clinic_files() {
  local f
  for f in "$CLINICS_DIR"/*.json; do
    if [ -e "$f" ]; then printf '%s\n' "$f"; fi
  done
  return 0
}

first_clinic_file() {
  local f
  for f in "$CLINICS_DIR"/*.json; do
    if [ -e "$f" ]; then
      printf '%s' "$f"
      return 0
    fi
  done
  return 0
}

clinic_label() { jq -r '"«\(.name)» (\(.id))"' "$1" 2>/dev/null || basename "$1" .json; }

# Значение из файла текущей клиники (у новой клиники — пусто).
clinic_get() {
  if [ "$CLINIC_IS_NEW" = 1 ] || [ ! -f "$CLINIC_FILE" ]; then return 0; fi
  jq -r "$1 // empty" "$CLINIC_FILE" 2>/dev/null || true
}

clinic_with_phone_id() {
  local f
  while IFS= read -r f; do
    [ "$f" = "$CLINIC_FILE" ] && continue
    if [ "$(jq -r '.whatsapp.phone_number_id // ""' "$f" 2>/dev/null)" = "$1" ]; then
      clinic_label "$f"
      return 0
    fi
  done < <(list_clinic_files)
  return 0
}

other_clinics_use_main_token() {
  local f phone own
  while IFS= read -r f; do
    [ "$f" = "$CLINIC_FILE" ] && continue
    phone="$(jq -r '.whatsapp.phone_number_id // ""' "$f" 2>/dev/null)"
    own="$(jq -r '.whatsapp.access_token_env // ""' "$f" 2>/dev/null)"
    if [[ "$phone" != REPLACE* ]] && [ -z "$own" ]; then return 0; fi
  done < <(list_clinic_files)
  return 1
}

# Транслитерация для имени файла клиники: «Улыбка» → ulybka.
TRANSLIT=(
  А a а a Б b б b В v в v Г g г g Д d д d Е e е e Ё e ё e Ж zh ж zh З z з z И i и i Й y й y
  К k к k Л l л l М m м m Н n н n О o о o П p п p Р r р r С s с s Т t т t У u у u Ф f ф f
  Х h х h Ц ts ц ts Ч ch ч ch Ш sh ш sh Щ sch щ sch Ъ "" ъ "" Ы y ы y Ь "" ь "" Э e э e Ю yu ю yu
  Я ya я ya Ә a ә a Ғ g ғ g Қ q қ q Ң n ң n Ө o ө o Ұ u ұ u Ү u ү u Һ h һ h І i і i
)

slugify() {
  local i args=() s
  for ((i = 0; i < ${#TRANSLIT[@]}; i += 2)); do args+=(-e "s/${TRANSLIT[i]}/${TRANSLIT[i + 1]}/g"); done
  s="$(printf '%s' "$1" | sed "${args[@]}" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-//' -e 's/-$//')"
  s="${s:0:40}"
  printf '%s' "${s%-}"
}

new_clinic_id() {
  local base id n=2
  base="$(slugify "$1")"
  [ -n "$base" ] || base="clinic"
  [ "$base" = demo ] && base="demo-clinic"
  id="$base"
  while [ -e "$CLINICS_DIR/$id.json" ]; do
    id="$base-$n"
    n=$((n + 1))
  done
  printf '%s' "$id"
}

id_to_env() {
  local s="${1^^}"
  printf '%s' "${s//[^A-Z0-9]/_}"
}

currency_for() {
  case "$1" in
    Asia/Almaty | Asia/Qyzylorda | Asia/Qostanay | Asia/Aqtobe | Asia/Aqtau | Asia/Atyrau | Asia/Oral) printf '₸' ;;
    Europe/Moscow | Europe/Kaliningrad | Europe/Samara | Europe/Volgograd | Europe/Saratov | Europe/Ulyanovsk | Europe/Astrakhan | Europe/Kirov) printf '₽' ;;
    Asia/Yekaterinburg | Asia/Omsk | Asia/Novosibirsk | Asia/Barnaul | Asia/Tomsk | Asia/Novokuznetsk | Asia/Krasnoyarsk) printf '₽' ;;
    Asia/Irkutsk | Asia/Chita | Asia/Yakutsk | Asia/Vladivostok | Asia/Sakhalin | Asia/Magadan | Asia/Kamchatka) printf '₽' ;;
    Asia/Tashkent | Asia/Samarkand) printf 'сум' ;;
    Asia/Bishkek) printf 'сом' ;;
  esac
}

pick_clinic() {
  local want="${1-}" files=() labels=() f
  mapfile -t files < <(list_clinic_files)
  [ ${#files[@]} -gt 0 ] || die "В $CLINICS_DIR нет файлов клиник. Добавьте клинику: dental-bot add-clinic"
  if [ -n "$want" ]; then
    if [[ ! "$want" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || [ ! -f "$CLINICS_DIR/$want.json" ]; then
      die "Клиника «$want» не найдена. Список клиник: dental-bot status"
    fi
    CLINIC_FILE="$CLINICS_DIR/$want.json"
  elif [ ${#files[@]} -eq 1 ]; then
    CLINIC_FILE="${files[0]}"
  else
    interactive || die "Клиник несколько — укажите нужную: dental-bot ${COMMAND:-edit} <id>"
    for f in "${files[@]}"; do labels+=("$(clinic_label "$f")"); done
    choose "Какая клиника?" 1 "${labels[@]}"
    CLINIC_FILE="${files[$((CHOICE - 1))]}"
  fi
  CLINIC_ID="$(basename "$CLINIC_FILE" .json)"
  CLINIC_IS_NEW=0
}

load_clinic_fields() {
  CLINIC_NAME="$(clinic_get '.name')"
  CLINIC_TIMEZONE="$(clinic_get '.timezone')"
  CLINIC_CURRENCY="$(clinic_get '.currency')"
  CLINIC_ADDRESS="$(clinic_get '.address')"
  CLINIC_PHONE="$(clinic_get '.phone')"
  CLINIC_HOURS="$(clinic_get '.working_hours_text')"
  CLINIC_OPERATOR="$(clinic_get '.privacy.operator_name')"
  CLINIC_POLICY_URL="$(clinic_get '.privacy.policy_url')"
}

# ───────────────────────────── вопросы мастера ─────────────────────────────

q_domain() {
  title "Домен"
  if interactive; then
    hint "Адрес бота в интернете, например bot.my-clinic.kz. Meta принимает только адреса с HTTPS —"
    hint "сертификат бот получит сам. A-запись домена должна указывать на IP этого сервера: ${SERVER_IP:-(не удалось определить)}."
    hint "Нет домена — купите у любого регистратора или используйте поддомен сайта клиники."
  fi
  ask DOMAIN "Домен" v_domain "${DOMAIN:-$(env_get DOMAIN)}"
  check_dns "$DOMAIN"
}

q_anthropic() {
  title "Ключ Claude (Anthropic)"
  if interactive; then
    hint "platform.claude.com → API Keys → Create Key. Ключ начинается с sk-ant-."
    hint "Там же, в Billing, пополните баланс и задайте месячный лимит расходов."
    hint "При вставке символы не отображаются — это нормально, просто нажмите Enter."
  fi
  ask ANTHROPIC_API_KEY "Ключ Claude" v_anthropic "${ANTHROPIC_API_KEY:-$(env_get ANTHROPIC_API_KEY)}" secret
}

q_timezone() {
  local def idx cur
  def="${CLINIC_TIMEZONE:-$(clinic_get '.timezone')}"
  def="${def:-Asia/Almaty}"
  if interactive; then
    case "$def" in
      Asia/Almaty) idx=1 ;;
      Europe/Moscow) idx=2 ;;
      Asia/Tashkent) idx=3 ;;
      Asia/Bishkek) idx=4 ;;
      *) idx=5 ;;
    esac
    choose "Часовой пояс клиники:" "$idx" "Казахстан (Asia/Almaty)" "Москва (Europe/Moscow)" "Узбекистан (Asia/Tashkent)" "Кыргызстан (Asia/Bishkek)" "Другой"
    case "$CHOICE" in
      1) CLINIC_TIMEZONE=Asia/Almaty ;;
      2) CLINIC_TIMEZONE=Europe/Moscow ;;
      3) CLINIC_TIMEZONE=Asia/Tashkent ;;
      4) CLINIC_TIMEZONE=Asia/Bishkek ;;
      *)
        [ "$idx" = 5 ] || def=""
        ask CLINIC_TIMEZONE "Часовой пояс (например, Asia/Yekaterinburg)" v_timezone "$def"
        ;;
    esac
  else
    ask CLINIC_TIMEZONE "Часовой пояс" v_timezone "$def"
  fi
  cur="$ENV_CLINIC_CURRENCY"
  if [ -z "$cur" ] && [ "$CLINIC_IS_NEW" = 0 ] && [ "$(clinic_get '.timezone')" = "$CLINIC_TIMEZONE" ]; then
    cur="$(clinic_get '.currency')"
  fi
  [ -n "$cur" ] || cur="$(currency_for "$CLINIC_TIMEZONE")"
  if [ -n "$cur" ]; then
    CLINIC_CURRENCY="$cur"
  else
    ask CLINIC_CURRENCY "Валюта (как писать в ценах: ₸, ₽, сум…)" v_short ""
  fi
}

q_clinic_info() {
  title "Клиника"
  interactive && hint "Эти данные бот сообщает пациентам. Прайс, врачей и расписание измените потом командой: dental-bot edit"
  ask CLINIC_NAME "Название клиники" v_text "${CLINIC_NAME:-$(clinic_get '.name')}"
  if [ "$CLINIC_IS_NEW" = 1 ]; then
    CLINIC_ID="$(new_clinic_id "$CLINIC_NAME")"
    CLINIC_FILE="$CLINICS_DIR/$CLINIC_ID.json"
  fi
  q_timezone
  ask CLINIC_ADDRESS "Адрес (город, улица, дом)" v_text "${CLINIC_ADDRESS:-$(clinic_get '.address')}"
  ask CLINIC_PHONE "Телефон клиники для пациентов" v_phone "${CLINIC_PHONE:-$(clinic_get '.phone')}"
  interactive && hint "Например: Пн–Пт 9:00–20:00, Сб 10:00–16:00, Вс — выходной"
  ask CLINIC_HOURS "Часы работы" v_text "${CLINIC_HOURS:-$(clinic_get '.working_hours_text')}"
  interactive && hint "Юрлицо — оператор персональных данных пациентов; его название попадёт в запрос согласия."
  ask CLINIC_OPERATOR "Юрлицо (например, ТОО «Улыбка» или ИП Иванова А. А.)" v_text "${CLINIC_OPERATOR:-$(clinic_get '.privacy.operator_name')}"
  interactive && hint "Страница политики конфиденциальности на сайте клиники. Если её нет — нажмите Enter, добавите позже."
  ask CLINIC_POLICY_URL "Ссылка на политику конфиденциальности" v_url_optional "${CLINIC_POLICY_URL-$(clinic_get '.privacy.policy_url')}"
}

token_var_for() {
  local own="$1" main="$2"
  if [ -n "$own" ]; then
    printf '%s' "$own"
  elif [ -z "$main" ] || [ "$WA_TOKEN" = "$main" ] || ! other_clinics_use_main_token; then
    printf 'WHATSAPP_ACCESS_TOKEN'
  else
    printf 'WHATSAPP_TOKEN_%s' "$(id_to_env "$CLINIC_ID")"
  fi
}

q_whatsapp() {
  local file_phone own_var main_token secret_def def_mode=2
  title "WhatsApp"
  file_phone="$(clinic_get '.whatsapp.phone_number_id')"
  [[ "$file_phone" == REPLACE* ]] && file_phone=""
  own_var="$(clinic_get '.whatsapp.access_token_env')"
  if [ "$WA_FORCE" = 1 ]; then
    WHATSAPP_SETUP=now
  else
    [ -n "${WHATSAPP_PHONE_NUMBER_ID:-$file_phone}" ] && def_mode=1
    case "$WHATSAPP_SETUP" in now) def_mode=1 ;; later) def_mode=2 ;; esac
    if interactive; then
      hint "Нужны данные из кабинета Meta: developers.facebook.com → ваше приложение → WhatsApp → API Setup."
      hint "Если их ещё нет, выберите «Позже»: бота можно проверить в браузере, а WhatsApp подключить"
      hint "потом командой  dental-bot whatsapp"
    fi
    choose "Подключить WhatsApp сейчас?" "$def_mode" "Да, данные из Meta у меня есть" "Позже"
    if [ "$CHOICE" = 2 ]; then
      WHATSAPP_SETUP=later
      return 0
    fi
    WHATSAPP_SETUP=now
  fi

  interactive && hint "Phone number ID — длинное число на странице API Setup рядом с номером (не сам номер телефона)."
  ask WHATSAPP_PHONE_NUMBER_ID "Phone number ID" v_phone_id "${WHATSAPP_PHONE_NUMBER_ID:-$file_phone}"

  main_token="$(env_get WHATSAPP_ACCESS_TOKEN)"
  if [ "$WA_FORCE" != 1 ] && [ -z "$own_var" ] && [ -n "$main_token" ] && [ -z "$ENV_WA_TOKEN" ] &&
    check_whatsapp "$WHATSAPP_PHONE_NUMBER_ID" "$main_token" quiet; then
    WA_TOKEN="$main_token"
    WA_TOKEN_VAR=WHATSAPP_ACCESS_TOKEN
    ok "Токен WhatsApp из настроек подходит к этому номеру${WA_DISPLAY:+ ($WA_DISPLAY)}"
    if [ "$WA_TOKEN_TEMPORARY" = 1 ]; then warn "У токена есть срок действия (до ${WA_TOKEN_EXPIRES:-?}) — замените его на постоянный: dental-bot whatsapp"; fi
  else
    if interactive; then
      hint "Нужен ПОСТОЯННЫЙ токен: временный со страницы API Setup перестаёт работать через сутки."
      hint "business.facebook.com → Настройки компании → Пользователи → Системные пользователи → Добавить"
      hint "(роль «Администратор») → Назначить активы: ваш аккаунт WhatsApp, полный доступ →"
      hint "Сгенерировать токен: ваше приложение, срок «Никогда», разрешения whatsapp_business_messaging"
      hint "и whatsapp_business_management."
    fi
    ask WA_TOKEN "Постоянный токен доступа" v_wa_token "${ENV_WA_TOKEN:-$(env_get "${own_var:-WHATSAPP_ACCESS_TOKEN}")}" secret
    WA_TOKEN_VAR="$(token_var_for "$own_var" "$main_token")"
  fi

  secret_def="${ENV_APP_SECRET:-$(env_get WHATSAPP_APP_SECRET)}"
  if [ "$WA_FORCE" != 1 ] && [ -z "$ENV_APP_SECRET" ] && [ -n "$secret_def" ] && [[ "$secret_def" =~ ^[0-9a-f]{32}$ ]] &&
    check_app_secret "$secret_def" quiet; then
    WHATSAPP_APP_SECRET="$secret_def"
    ok "App Secret из настроек подходит"
  else
    interactive && hint "App Secret: developers.facebook.com → ваше приложение → Настройки приложения → Основное → Секрет приложения → Показать."
    ask WHATSAPP_APP_SECRET "App Secret" v_app_secret "$secret_def" secret
  fi
}

tg_find_chats() {
  http GET "$TELEGRAM_API_URL/bot$TELEGRAM_BOT_TOKEN/getUpdates?timeout=0"
  [ "$HTTP_CODE" = 200 ] || return 0
  jq -r '[.result[]? | (.message.chat // .edited_message.chat // .my_chat_member.chat // .channel_post.chat // empty)]
    | unique_by(.id) | .[]
    | "\(.id)\t\(.title // ([.first_name, .last_name] | map(select(. != null)) | join(" ")))"' <<<"$HTTP_BODY" 2>/dev/null || true
}

tg_send() {
  http POST "$TELEGRAM_API_URL/bot$TELEGRAM_BOT_TOKEN/sendMessage" "Content-Type: application/json" \
    --data "$(jq -nc --arg chat "$1" --arg text "$2" '{chat_id: $chat, text: $text}')"
  [ "$HTTP_CODE" = 200 ]
}

q_telegram() {
  local token_def existing line lines=() chat_ids=() labels=() ids=() id sent=0
  title "Уведомления администратору (Telegram)"
  token_def="${ENV_TG_TOKEN:-$(env_get TELEGRAM_BOT_TOKEN)}"
  existing="$(clinic_get '.notifications.telegram_chat_ids | join(",")')"
  TG_CHATS="${TELEGRAM_CHAT_ID:-$existing}"
  TELEGRAM_SETUP=no
  if ! interactive; then
    [ -n "$token_def" ] || return 0
    ask TELEGRAM_BOT_TOKEN "Токен бота" v_telegram_token "$token_def"
    if [ -n "$TG_CHATS" ]; then
      v_chat_ids "$TG_CHATS" || die "TELEGRAM_CHAT_ID: $VALIDATION_ERROR"
    else
      warn "TELEGRAM_CHAT_ID не задан — уведомления этой клиники приходить не будут."
    fi
    TELEGRAM_SETUP=yes
    return 0
  fi
  hint "Бот напишет администратору, когда пациент просит позвать человека, хочет удалить свои данные,"
  hint "когда исчерпан дневной бюджет и т. п. Без этого такие события видны только в журнале сервера."
  if [ "$TG_FORCE" != 1 ] && [ -n "$token_def" ] && [ -n "$existing" ]; then
    if ! confirm "Уведомления уже настроены. Настроить заново?" n; then
      TELEGRAM_SETUP=keep
      return 0
    fi
  elif [ "$TG_FORCE" != 1 ]; then
    confirm "Настроить уведомления сейчас? Это займёт 2 минуты" y || return 0
  fi

  TELEGRAM_BOT_TOKEN=""
  if [ -n "$token_def" ] && v_telegram_token "$token_def" && confirm "Использовать этого бота${TG_BOT_USERNAME:+ (@$TG_BOT_USERNAME)}?" y; then
    TELEGRAM_BOT_TOKEN="$token_def"
  else
    hint "1. В Telegram найдите @BotFather, отправьте ему /newbot, придумайте имя и адрес бота."
    hint "   BotFather пришлёт токен вида 1234567890:AAH… — скопируйте его."
    ask TELEGRAM_BOT_TOKEN "Токен бота" v_telegram_token "" secret
  fi
  hint "2. Откройте https://t.me/${TG_BOT_USERNAME:-ваш_бот} и нажмите «Запустить» (Start)."
  hint "   Для общего чата администраторов: добавьте бота в группу и напишите там любое сообщение."
  while :; do
    read_line "Когда сделаете, нажмите Enter" ""
    mapfile -t lines < <(tg_find_chats)
    [ ${#lines[@]} -gt 0 ] && break
    warn "Бот пока не получил ни одного сообщения."
    if ! confirm "Проверить ещё раз?" y; then return 0; fi
  done
  for line in "${lines[@]}"; do
    chat_ids+=("${line%%$'\t'*}")
    labels+=("${line#*$'\t'}")
  done
  if [ ${#chat_ids[@]} -eq 1 ]; then
    TG_CHATS="${chat_ids[0]}"
  else
    choose "Куда отправлять уведомления?" 1 "${labels[@]}" "Во все эти чаты"
    if [ "$CHOICE" -gt ${#chat_ids[@]} ]; then
      TG_CHATS="$(
        IFS=,
        printf '%s' "${chat_ids[*]}"
      )"
    else
      TG_CHATS="${chat_ids[$((CHOICE - 1))]}"
    fi
  fi
  IFS=, read -ra ids <<<"$TG_CHATS"
  for id in "${ids[@]}"; do
    if tg_send "$id" "✅ Сюда будут приходить уведомления ИИ-администратора клиники «${CLINIC_NAME:-}»."; then sent=$((sent + 1)); fi
  done
  if [ "$sent" -gt 0 ]; then ok "Тестовое сообщение отправлено — проверьте Telegram"; else warn "Не удалось отправить тестовое сообщение."; fi
  TELEGRAM_SETUP=yes
}

show_summary() {
  title "Проверьте ответы"
  if [ "${1-}" != clinic ]; then
    say "  Домен: $DOMAIN"
    say "  Ключ Claude: $(mask "$ANTHROPIC_API_KEY")"
  fi
  say "  Клиника: $CLINIC_NAME ($CLINIC_TIMEZONE, валюта $CLINIC_CURRENCY)"
  say "  Адрес: $CLINIC_ADDRESS"
  say "  Телефон: $CLINIC_PHONE"
  say "  Часы работы: $CLINIC_HOURS"
  say "  Юрлицо: $CLINIC_OPERATOR"
  say "  Политика конфиденциальности: ${CLINIC_POLICY_URL:-не указана (добавите позже)}"
  if [ "$WHATSAPP_SETUP" = now ]; then
    say "  WhatsApp: ${WA_DISPLAY:-номер} (Phone number ID $WHATSAPP_PHONE_NUMBER_ID)"
  else
    say "  WhatsApp: подключу позже"
  fi
  case "$TELEGRAM_SETUP" in
    yes) say "  Уведомления в Telegram: ${TG_BOT_USERNAME:+@$TG_BOT_USERNAME → }чаты $TG_CHATS" ;;
    keep) say "  Уведомления в Telegram: без изменений" ;;
    *) say "  Уведомления в Telegram: не настроены (позже: dental-bot telegram)" ;;
  esac
}

# ───────────────────────────── запись настроек ─────────────────────────────

own_app_group() {
  if is_root; then chown "root:$APP_UID" "$@" 2>/dev/null || true; fi
}

apply_env() {
  ensure_env_file
  [ -n "$DOMAIN" ] && set_env DOMAIN "$DOMAIN"
  [ -n "$ANTHROPIC_API_KEY" ] && set_env ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
  set_env CLINICS_HOST_DIR "./$CLINICS_REL"
  ensure_secret WHATSAPP_VERIFY_TOKEN 24
  ensure_secret DATA_ENCRYPTION_KEY 32
  ensure_secret CANARY_SECRET 32
  ensure_secret ADMIN_TOKEN 32
  ensure_secret SIMULATOR_KEY 24
  if [ "$WHATSAPP_SETUP" = now ]; then
    set_env "$WA_TOKEN_VAR" "$WA_TOKEN"
    set_env WHATSAPP_APP_SECRET "$WHATSAPP_APP_SECRET"
  fi
  if [ "$TELEGRAM_SETUP" = yes ]; then set_env TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"; fi
}

chats_json() { jq -cn --arg s "$1" '$s | split(",") | map(gsub("\\s"; "")) | map(select(length > 0))'; }

apply_clinic() {
  local src="$CLINIC_FILE" tmp phone_id="" token_env="keep" chats="null" fresh=false
  if [ "$CLINIC_IS_NEW" = 1 ]; then
    src="$TEMPLATE"
    fresh=true
  fi
  if [ "$WHATSAPP_SETUP" = now ]; then
    phone_id="$WHATSAPP_PHONE_NUMBER_ID"
    if [ "$WA_TOKEN_VAR" = WHATSAPP_ACCESS_TOKEN ]; then token_env=""; else token_env="$WA_TOKEN_VAR"; fi
  elif [ "$CLINIC_IS_NEW" = 1 ]; then
    phone_id="REPLACE_$CLINIC_ID"
    token_env=""
  fi
  if [ "$TELEGRAM_SETUP" = yes ]; then chats="$(chats_json "$TG_CHATS")"; fi
  mkdir -p "$CLINICS_DIR"
  chmod 750 "$CLINICS_DIR"
  own_app_group "$CLINICS_DIR"
  tmp="$(mktemp "$CLINICS_DIR/.new.XXXXXX")"
  jq --arg id "$CLINIC_ID" --arg name "$CLINIC_NAME" --arg tz "$CLINIC_TIMEZONE" --arg currency "$CLINIC_CURRENCY" \
    --arg address "$CLINIC_ADDRESS" --arg phone "$CLINIC_PHONE" --arg hours "$CLINIC_HOURS" \
    --arg operator "$CLINIC_OPERATOR" --arg policy "${CLINIC_POLICY_URL-}" \
    --arg phone_id "$phone_id" --arg token_env "$token_env" --argjson chats "$chats" \
    --arg version "$(date +%F)" --argjson fresh "$fresh" '
    .id = $id | .name = $name | .timezone = $tz | .currency = $currency
    | .address = $address | .working_hours_text = $hours
    | (if $phone == "" then del(.phone) else .phone = $phone end)
    | (if $operator == "" then del(.privacy.operator_name) else .privacy.operator_name = $operator end)
    | (if $policy == "" then del(.privacy.policy_url) else .privacy.policy_url = $policy end)
    | (if $phone_id == "" then . else .whatsapp.phone_number_id = $phone_id end)
    | (if $token_env == "keep" then . elif $token_env == "" then del(.whatsapp.access_token_env) else .whatsapp.access_token_env = $token_env end)
    | (if $chats == null then . else .notifications.telegram_chat_ids = $chats end)
    | (if $fresh then
        .privacy.consent_version = $version
        | .about = "" | .payment_methods = "" | .website = "" | .instagram = "" | .map_url = ""
        | .policies = [] | .promotions = [] | .faq = [] | .holidays = [] | .admin = {}
      else . end)
  ' "$src" >"$tmp"
  chmod 640 "$tmp"
  own_app_group "$tmp"
  mv -f "$tmp" "$CLINIC_FILE"
  CLINIC_IS_NEW=0
}

snapshot_config() {
  rm -f "$TMP_DIR/env.bak" "$TMP_DIR/clinic.bak"
  if [ -f "$ENV_FILE" ]; then cp -p "$ENV_FILE" "$TMP_DIR/env.bak"; fi
  if [ -n "$CLINIC_FILE" ] && [ -f "$CLINIC_FILE" ]; then cp -p "$CLINIC_FILE" "$TMP_DIR/clinic.bak"; fi
  SNAPSHOT_CLINIC="$CLINIC_FILE"
}

restore_config() {
  if [ -f "$TMP_DIR/env.bak" ]; then cp -p "$TMP_DIR/env.bak" "$ENV_FILE"; fi
  if [ -f "$TMP_DIR/clinic.bak" ]; then
    cp -p "$TMP_DIR/clinic.bak" "$SNAPSHOT_CLINIC"
  elif [ -n "${SNAPSHOT_CLINIC:-}" ]; then
    rm -f "$SNAPSHOT_CLINIC"
  fi
  warn "Вернул прежние настройки — бот продолжает работать как раньше."
}

prepare_dirs() {
  mkdir -p "$APP_DIR/data"
  chmod 700 "$APP_DIR/data"
  # Бот в контейнере работает не от root, а от пользователя с id 1000 — папке нужен этот владелец.
  if is_root; then chown -R "$APP_UID:$APP_UID" "$APP_DIR/data"; fi
}

# ───────────────────────────── система ─────────────────────────────

wait_apt() {
  local waited=0
  while pgrep -f 'apt.systemd.daily|unattended-upgrade|/usr/bin/dpkg' >/dev/null 2>&1; do
    [ "$waited" -eq 0 ] && info "Система ставит обновления — жду, пока закончит…"
    sleep 5
    waited=$((waited + 5))
    [ "$waited" -ge 900 ] && break
  done
  return 0
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 update -qq &&
    DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -qq "$@"
}

install_packages() {
  local missing=() cmd
  for cmd in curl git jq openssl; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  [ ${#missing[@]} -eq 0 ] && return 0
  command -v apt-get >/dev/null 2>&1 || die "Не хватает программ: ${missing[*]}. Установите их и запустите снова."
  wait_apt
  run_logged "Устанавливаю ${missing[*]}…" apt_install "${missing[@]}" ca-certificates || die "Не удалось установить ${missing[*]}."
}

ensure_swap() {
  local mem_mb="$1" swap_mb free_mb
  [ "${SKIP_SWAP:-0}" = 1 ] && return 0
  swap_mb="$(awk '/^SwapTotal:/ { print int($2 / 1024) }' /proc/meminfo)"
  if [ "$mem_mb" -ge 1900 ] || [ "$swap_mb" -ge 512 ] || [ -e /swapfile ]; then return 0; fi
  free_mb="$(df -Pm / | awk 'NR == 2 { print $4 }')"
  [ "$free_mb" -ge 6000 ] || return 0
  info "Памяти немного — добавляю файл подкачки 2 ГБ, чтобы сборка не упала…"
  if { fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; } &&
    chmod 600 /swapfile && mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile 2>/dev/null; then
    grep -q '^/swapfile ' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
    ok "Файл подкачки включён"
  else
    swapoff /swapfile 2>/dev/null || true
    rm -f /swapfile
    warn "Подкачку включить не удалось (на некоторых тарифах она запрещена) — продолжаю без неё."
  fi
}

preflight() {
  local mem_mb disk_mb
  if [ "${SKIP_OS_CHECK:-0}" != 1 ] && ! grep -Eqs '^ID(_LIKE)?=.*(debian|ubuntu)' /etc/os-release; then
    die "Установщик рассчитан на Ubuntu 22.04/24.04 или Debian 12."
  fi
  mem_mb="$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)"
  disk_mb="$(df -Pm "$APP_DIR" | awk 'NR == 2 { print $4 }')"
  if [ "$mem_mb" -lt 900 ]; then warn "Памяти ${mem_mb} МБ — маловато. Рекомендуем сервер от 1 ГБ (лучше 2 ГБ)."; fi
  if [ "$disk_mb" -lt 3000 ]; then die "Свободно ${disk_mb} МБ на диске, нужно хотя бы 3 ГБ."; fi
  ensure_swap "$mem_mb"
}

install_docker() {
  local script="$TMP_DIR/get-docker.sh"
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    docker info >/dev/null 2>&1 || systemctl enable --now docker >/dev/null 2>&1 || true
    docker info >/dev/null 2>&1 || die "Docker установлен, но не запущен. Проверьте: systemctl status docker"
    ok "Docker уже установлен"
    return 0
  fi
  wait_apt
  if curl -fsSL --max-time 60 https://get.docker.com -o "$script" 2>>"$LOG_FILE" &&
    run_logged "Устанавливаю Docker (1–3 минуты)…" sh "$script"; then
    :
  else
    warn "Официальный установщик Docker не сработал — пробую пакеты системы…"
    run_logged "Устанавливаю Docker из пакетов…" apt_install docker.io docker-compose-v2 ||
      run_logged "Пробую другой пакет Compose…" apt_install docker.io docker-compose-plugin ||
      die "Не удалось установить Docker. Подробности: $LOG_FILE"
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || die "Не установился Docker Compose. Подробности: $LOG_FILE"
  ok "Docker установлен"
}

open_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ok "Файрвол: открыты порты 80 и 443"
  fi
  return 0
}

# Порты 80 и 443 нужны Caddy для HTTPS. На многих серверах их уже занимает nginx или apache.
free_ports() {
  local port line proc
  [ "${SKIP_PORT_CHECK:-0}" = 1 ] && return 0
  command -v ss >/dev/null 2>&1 || return 0
  for port in 80 443; do
    line="$(ss -Hltnp "sport = :$port" 2>/dev/null | sed -n 1p || true)"
    [ -n "$line" ] || continue
    proc="$(sed -n 's/.*users:(("\([^"]*\)".*/\1/p' <<<"$line")"
    case "$proc" in
      docker-proxy | dockerd | "") continue ;;
      nginx | apache2 | httpd | caddy | lighttpd)
        warn "Порт $port занят программой $proc — она мешает получить сертификат HTTPS."
        if confirm "Остановить и отключить $proc?" n; then
          systemctl disable --now "$proc" >>"$LOG_FILE" 2>&1 || die "Не удалось остановить $proc."
          ok "$proc остановлен"
        else
          die "Освободите порт $port (systemctl disable --now $proc) и запустите установку снова."
        fi
        ;;
      *) die "Порт $port занят программой $proc. Остановите её и запустите установку снова." ;;
    esac
  done
}

# ───────────────────────────── запуск и проверки ─────────────────────────────

config_check() {
  local out status=0
  info "Проверяю настройки…"
  out="$(docker compose run --rm --no-deps -T agent node dist/cli/check.js 2>>"$LOG_FILE")" || status=$?
  if [ -n "$out" ]; then printf '%s\n' "$out" | sed 's/^/    /'; fi
  return "$status"
}

agent_api() { docker compose exec -T agent node dist/cli/api.js "$@"; }

wait_agent() {
  local i cid
  for ((i = 0; i < 60; i++)); do
    if agent_api GET /health >/dev/null 2>&1; then return 0; fi
    if [ "$i" -ge 10 ]; then
      cid="$(docker compose ps -q agent 2>/dev/null || true)"
      if [ -n "$cid" ] && [ "$(docker inspect -f '{{.State.Restarting}}' "$cid" 2>/dev/null || true)" = true ]; then return 1; fi
    fi
    sleep 2
  done
  return 1
}

agent_failed() {
  warn "Бот не запустился. Последние строки его журнала:"
  docker compose logs --tail=40 agent >&2 2>&1 || true
  die "${1:-Исправьте ошибку и запустите команду снова.}"
}

https_ok() {
  local domain="$1" insecure=()
  [ "$domain" = localhost ] && insecure=(-k)
  curl -fsS "${insecure[@]}" --max-time 8 --resolve "$domain:443:127.0.0.1" "https://$domain/health" >/dev/null 2>&1
}

wait_https() {
  local domain i
  domain="$(env_get DOMAIN)"
  HTTPS_OK=0
  if [ "${SKIP_HTTPS_CHECK:-0}" = 1 ]; then
    HTTPS_OK=1
    return 0
  fi
  info "Получаю сертификат HTTPS для $domain (до 2 минут)…"
  for ((i = 0; i < 40; i++)); do
    if https_ok "$domain"; then
      HTTPS_OK=1
      ok "HTTPS работает: https://$domain"
      return 0
    fi
    sleep 3
  done
  warn "HTTPS для $domain пока не работает. Частые причины:"
  hint "• A-запись домена ещё не обновилась или указывает не на этот сервер;"
  hint "• порты 80 и 443 закрыты файрволом в панели хостинга (откройте их);"
  hint "• у домена есть лишняя AAAA-запись (IPv6)."
  hint "Бот сам повторит попытку получить сертификат. Проверить позже: dental-bot status"
}

recreate_agent() {
  run_logged "Перезапускаю бота…" docker compose up -d --force-recreate agent || agent_failed
  wait_agent || agent_failed
  ok "Бот перезапущен"
}

# После изменения файлов клиник: бот перечитывает их без перезапуска, при неудаче — перезапуск.
reload_clinics() {
  if agent_api POST /admin/clinics/reload >>"$LOG_FILE" 2>&1; then
    ok "Бот перечитал файлы клиник"
  else
    recreate_agent
  fi
}

build_and_start() {
  run_logged "Собираю бота — первый раз это занимает 3–7 минут…" docker compose build ||
    die "Сборка не удалась. Подробности: $LOG_FILE"
  config_check || die "Настройки не прошли проверку (ошибки выше). Исправьте их и запустите установку снова."
  run_logged "Запускаю…" docker compose up -d --remove-orphans || agent_failed
  wait_agent || agent_failed
  ok "Бот работает"
  wait_https
}

install_cli() {
  chmod 755 "$APP_DIR/scripts/dental-bot.sh"
  mkdir -p "$BIN_DIR"
  ln -sfn "$APP_DIR/scripts/dental-bot.sh" "$BIN_DIR/dental-bot"
}

print_meta_steps() {
  local domain verify
  domain="$(env_get DOMAIN)"
  verify="$(env_get WHATSAPP_VERIFY_TOKEN)"
  say "   developers.facebook.com → ваше приложение → WhatsApp → Configuration (Конфигурация) →"
  say "   Webhook → Edit (Изменить). Вставьте:"
  say "     Callback URL:  ${C_BOLD}https://$domain/webhook/whatsapp${C_RESET}"
  say "     Verify token:  ${C_BOLD}$verify${C_RESET}"
  say "   Нажмите «Verify and save», затем в списке Webhook fields у поля messages нажмите Subscribe."
}

final_report() {
  local domain
  domain="$(env_get DOMAIN)"
  printf '\n%s\n' "${C_GREEN}${C_BOLD}══════════════════════════════════════════════════════════════${C_RESET}"
  say "${C_GREEN}${C_BOLD}  Готово! ИИ-администратор установлен и работает.${C_RESET}"
  printf '%s\n' "${C_GREEN}${C_BOLD}══════════════════════════════════════════════════════════════${C_RESET}"
  title "1. Проверьте бота в браузере (тестовый чат, отдельная база):"
  say "   https://$domain/simulator#key=$(env_get SIMULATOR_KEY)"
  if [ "${HTTPS_OK:-0}" != 1 ]; then hint "Ссылка заработает, когда появится сертификат HTTPS (см. выше)."; fi
  title "2. Подключите WhatsApp в кабинете Meta:"
  if [ "$WHATSAPP_SETUP" = now ]; then
    print_meta_steps
  else
    say "   Когда получите данные WhatsApp от Meta, выполните:  ${C_BOLD}dental-bot whatsapp${C_RESET}"
    say "   Команда проверит данные и покажет, что вписать в настройки вебхука."
  fi
  title "3. Впишите свой прайс, врачей и расписание:"
  say "   ${C_BOLD}dental-bot edit${C_RESET}"
  say "   ${C_YELLOW}Сейчас в боте врачи и цены из демо-примера — до подключения WhatsApp замените их.${C_RESET}"
  title "4. Сохраните в надёжном месте (менеджер паролей):"
  say "   Ключ шифрования базы:  $(env_get DATA_ENCRYPTION_KEY)"
  say "   Токен администратора:  $(env_get ADMIN_TOKEN)"
  hint "Без ключа шифрования данные из резервных копий не восстановить. Показать снова: dental-bot info --secrets"
  title "Управление ботом:"
  say "   dental-bot status — состояние,  dental-bot logs — журнал,  dental-bot help — все команды"
}

# ───────────────────────────── команды ─────────────────────────────

cmd_install() {
  require_root
  init_log
  open_input
  printf '\n%s\n' "${C_BOLD}Мастер установки ИИ-администратора стоматологии${C_RESET}"
  if [ -f "$ENV_FILE" ] && interactive; then
    installed_menu
    return 0
  fi
  if interactive; then
    say "Понадобится 10–15 минут и:"
    say "  • домен (например, bot.my-clinic.kz) с A-записью на IP этого сервера;"
    say "  • ключ Claude API — platform.claude.com → API Keys;"
    say "  • данные WhatsApp из кабинета Meta — их можно добавить и позже."
    say "Ответ вводите и подтверждайте клавишей Enter. В квадратных скобках — ответ по умолчанию."
  fi
  preflight
  install_packages
  detect_server_ip
  CLINIC_FILE="$(first_clinic_file)"
  if [ -n "$CLINIC_FILE" ]; then
    CLINIC_ID="$(basename "$CLINIC_FILE" .json)"
    CLINIC_IS_NEW=0
  fi
  while :; do
    q_domain
    q_anthropic
    q_clinic_info
    q_whatsapp
    q_telegram
    show_summary
    confirm "Всё верно? Начинаем установку" y && break
    say "Пройдём вопросы ещё раз — Enter оставляет уже введённый ответ."
  done
  install_docker
  apply_env
  apply_clinic
  prepare_dirs
  open_firewall
  free_ports
  build_and_start
  install_cli
  final_report
}

bot_running() {
  command -v docker >/dev/null 2>&1 || return 1
  [ -n "$(docker compose ps -q --status running agent 2>/dev/null || true)" ]
}

# Продолжение установки, которая оборвалась после записи настроек (например, пропал интернет при сборке).
resume_install() {
  local main_phone
  preflight
  install_packages
  install_docker
  apply_env
  prepare_dirs
  open_firewall
  free_ports
  build_and_start
  install_cli
  main_phone="$(jq -r '.whatsapp.phone_number_id // ""' "$(first_clinic_file)" 2>/dev/null || true)"
  if [ -n "$main_phone" ] && [[ "$main_phone" != REPLACE* ]]; then WHATSAPP_SETUP=now; else WHATSAPP_SETUP=later; fi
  final_report
}

installed_menu() {
  if ! bot_running; then
    say "Настройки бота уже есть в $APP_DIR, но бот сейчас не запущен — возможно, установка прервалась."
    choose "Что сделать?" 1 \
      "Продолжить установку и запустить бота" \
      "Изменить домен или ключ Claude" \
      "Выйти"
    case "$CHOICE" in
      1) resume_install ;;
      2) cmd_settings ;;
      *) say "Команды управления: dental-bot help" ;;
    esac
    return 0
  fi
  install_cli
  say "Бот уже установлен в $APP_DIR."
  choose "Что сделать?" 1 \
    "Обновить бота до новой версии (настройки сохранятся)" \
    "Изменить домен или ключ Claude" \
    "Подключить или заменить WhatsApp" \
    "Настроить уведомления в Telegram" \
    "Добавить ещё одну клинику" \
    "Показать адреса и данные для Meta" \
    "Выйти"
  case "$CHOICE" in
    1) cmd_update ;;
    2) cmd_settings ;;
    3) cmd_whatsapp ;;
    4) cmd_telegram ;;
    5) cmd_add_clinic ;;
    6) cmd_info ;;
    *) say "Команды управления: dental-bot help" ;;
  esac
}

cmd_settings() {
  require_root
  require_installed
  init_log
  open_input
  detect_server_ip
  q_domain
  q_anthropic
  confirm "Сохранить и перезапустить бота?" y || return 0
  snapshot_config
  apply_env
  if ! config_check; then
    restore_config
    die "Новые настройки не прошли проверку."
  fi
  run_logged "Перезапускаю…" docker compose up -d --force-recreate || agent_failed
  wait_agent || agent_failed
  ok "Настройки сохранены, бот перезапущен"
  wait_https
}

cmd_whatsapp() {
  require_root
  require_installed
  init_log
  open_input
  pick_clinic "${1-}"
  load_clinic_fields
  title "Подключение WhatsApp: $(clinic_label "$CLINIC_FILE")"
  WA_FORCE=1
  TELEGRAM_SETUP=""
  q_whatsapp
  snapshot_config
  apply_env
  apply_clinic
  if ! config_check; then
    restore_config
    die "Настройки не прошли проверку."
  fi
  recreate_agent
  title "Осталось настроить вебхук в кабинете Meta:"
  print_meta_steps
}

cmd_telegram() {
  require_root
  require_installed
  init_log
  open_input
  pick_clinic "${1-}"
  load_clinic_fields
  TG_FORCE=1
  WHATSAPP_SETUP=""
  q_telegram
  [ "$TELEGRAM_SETUP" = yes ] || return 0
  snapshot_config
  apply_env
  apply_clinic
  if ! config_check; then
    restore_config
    die "Настройки не прошли проверку."
  fi
  recreate_agent
}

cmd_add_clinic() {
  require_root
  require_installed
  init_log
  open_input
  CLINIC_FILE=""
  CLINIC_ID=""
  CLINIC_IS_NEW=1
  title "Новая клиника"
  while :; do
    q_clinic_info
    q_whatsapp
    q_telegram
    show_summary clinic
    confirm "Добавить клинику?" y && break
    say "Пройдём вопросы ещё раз — Enter оставляет уже введённый ответ."
  done
  snapshot_config
  apply_env
  apply_clinic
  if ! config_check; then
    restore_config
    die "Настройки не прошли проверку."
  fi
  recreate_agent
  ok "Клиника «$CLINIC_NAME» добавлена (файл $CLINICS_REL/$CLINIC_ID.json)"
  if [ "$WHATSAPP_SETUP" = now ]; then
    say "Если номер в том же приложении Meta, что и первая клиника, вебхук уже настроен. Если нет:"
    print_meta_steps
  fi
  warn "Впишите прайс и врачей новой клиники: dental-bot edit $CLINIC_ID"
}

cmd_edit() {
  local editor before
  require_root
  require_installed
  init_log
  open_input
  pick_clinic "${1-}"
  before="$TMP_DIR/before.json"
  cp -p "$CLINIC_FILE" "$before"
  editor="${EDITOR:-nano}"
  command -v "${editor%% *}" >/dev/null 2>&1 || editor="vi"
  title "Редактирование: $(clinic_label "$CLINIC_FILE")"
  hint "Меняйте значения в кавычках и цифры; запятые, двоеточия и скобки не трогайте."
  hint "Цены — price_from (от) и price_to (до), длительность приёма — duration_min (минуты)."
  hint "Врачи — раздел doctors: schedule — часы по дням (mon…sun), days_off — отпуск (\"2026-12-31\")."
  hint "В nano: сохранить — Ctrl+O, затем Enter; выйти — Ctrl+X."
  if interactive; then read_line "Нажмите Enter, чтобы открыть файл" ""; fi
  while :; do
    # Редактору нужен терминал и на ввод, и на вывод. EDITOR может содержать аргументы — без кавычек намеренно.
    if [ -t 3 ]; then
      # shellcheck disable=SC2086,SC2094
      $editor "$CLINIC_FILE" <"$INSTALL_TTY" >"$INSTALL_TTY" 2>&1 || true
    else
      # shellcheck disable=SC2086
      $editor "$CLINIC_FILE" || true
    fi
    if cmp -s "$CLINIC_FILE" "$before"; then
      info "Файл не изменился."
      return 0
    fi
    if config_check; then
      reload_clinics
      ok "Изменения применены"
      return 0
    fi
    if confirm "В файле ошибка (см. выше). Открыть его снова и исправить?" y; then continue; fi
    cp -p "$before" "$CLINIC_FILE"
    warn "Вернул прежнюю версию файла — бот работает со старыми данными."
    return 1
  done
}

cmd_status() {
  local domain n=0 last="" f
  require_root
  require_installed
  init_log
  domain="$(env_get DOMAIN)"
  title "Контейнеры"
  docker compose ps
  title "Проверки"
  if agent_api GET /health >/dev/null 2>&1; then ok "Бот отвечает"; else warn "Бот не отвечает — журнал: dental-bot logs"; fi
  if https_ok "$domain"; then ok "HTTPS: https://$domain"; else warn "https://$domain не отвечает (DNS, порты 80/443 или сертификат ещё не выдан)"; fi
  title "Настройки"
  config_check || true
  title "Резервные копии"
  for f in "$APP_DIR"/data/backups/backup-*.db; do
    [ -e "$f" ] || continue
    n=$((n + 1))
    last="$f"
  done
  if [ "$n" -gt 0 ]; then say "  $n шт., последняя: $(basename "$last")"; else say "  пока нет (создаются раз в сутки или командой dental-bot backup)"; fi
  title "Диск"
  df -h "$APP_DIR" | awk 'NR == 2 { print "  свободно " $4 " из " $2 }'
}

cmd_logs() {
  local service="${1:-agent}"
  require_root
  require_installed
  case "$service" in agent | caddy) ;; *) die "Журнал бывает у agent (бот) и caddy (HTTPS)." ;; esac
  docker compose logs -f --tail=200 "$service"
}

cmd_restart() {
  require_root
  require_installed
  init_log
  config_check || die "Настройки с ошибками — бот не перезапущен, работает прежняя версия."
  prepare_dirs
  run_logged "Перезапускаю…" docker compose up -d --force-recreate || agent_failed
  wait_agent || agent_failed
  ok "Бот перезапущен"
}

cmd_start() {
  require_root
  require_installed
  init_log
  config_check || die "Настройки с ошибками — исправьте их (dental-bot check)."
  prepare_dirs
  run_logged "Запускаю…" docker compose up -d || agent_failed
  wait_agent || agent_failed
  ok "Бот работает"
}

cmd_stop() {
  require_root
  require_installed
  init_log
  run_logged "Останавливаю…" docker compose stop
  ok "Бот остановлен. Запустить: dental-bot start"
}

cmd_check() {
  require_root
  require_installed
  init_log
  config_check
}

backup_now() { agent_api POST /admin/backup 2>>"$LOG_FILE"; }

cmd_backup() {
  local out file
  require_root
  require_installed
  init_log
  out="$(backup_now)" || die "Не удалось: бот не отвечает (dental-bot status)."
  file="$(json_get '.file' "$out")"
  ok "Резервная копия: $APP_DIR/data/backups/$file"
  hint "Копии лежат на этом же сервере. Регулярно скачивайте их к себе (WinSCP или FileZilla, протокол SFTP)."
  hint "Для восстановления нужен и ключ DATA_ENCRYPTION_KEY из файла $ENV_FILE — храните его отдельно."
}

rollback_update() {
  warn "Возвращаю прежнюю версию…"
  git -C "$APP_DIR" reset --hard --quiet "$1" >>"$LOG_FILE" 2>&1 || true
  if docker image inspect "$IMAGE:rollback" >/dev/null 2>&1; then docker image tag "$IMAGE:rollback" "$IMAGE:local"; fi
  docker compose up -d --no-build --remove-orphans >>"$LOG_FILE" 2>&1 || true
  wait_agent || warn "Бот не отвечает и на прежней версии — смотрите: dental-bot logs"
}

cmd_update() {
  local old new
  require_root
  require_installed
  init_log
  title "Обновление"
  if backup_now >/dev/null; then ok "Резервная копия базы создана"; else warn "Резервную копию сделать не удалось (бот остановлен?) — продолжаю."; fi
  old="$(git -C "$APP_DIR" rev-parse HEAD)"
  if [ "${SKIP_GIT_UPDATE:-0}" != 1 ]; then
    run_logged "Скачиваю новую версию…" git -C "$APP_DIR" pull --ff-only ||
      die "Не удалось скачать обновление. Если вы меняли файлы кода вручную, посмотрите: git -C $APP_DIR status"
  fi
  new="$(git -C "$APP_DIR" rev-parse HEAD)"
  if [ "$old" = "$new" ]; then info "Код уже последней версии — обновлю системные компоненты (базовый образ, Caddy)."; fi
  docker image tag "$IMAGE:local" "$IMAGE:rollback" >/dev/null 2>&1 || true
  if ! run_logged "Собираю (2–5 минут)…" docker compose build --pull; then
    rollback_update "$old"
    die "Сборка не удалась — бот работает на прежней версии. Подробности: $LOG_FILE"
  fi
  docker compose pull caddy >>"$LOG_FILE" 2>&1 || true
  if ! config_check; then
    rollback_update "$old"
    die "Новая версия не принимает текущие настройки — вернул прежнюю."
  fi
  prepare_dirs
  if ! run_logged "Перезапускаю…" docker compose up -d --remove-orphans || ! wait_agent; then
    rollback_update "$old"
    die "Новая версия не запустилась — вернул прежнюю. Журнал: dental-bot logs"
  fi
  docker image prune -f >>"$LOG_FILE" 2>&1 || true
  install_cli
  ok "Обновлено: $(git -C "$APP_DIR" log -1 --format='%h от %cd' --date=short)"
}

cmd_info() {
  local domain f
  require_root
  require_installed
  domain="$(env_get DOMAIN)"
  title "Адреса"
  say "  Бот:           https://$domain"
  say "  Тестовый чат:  https://$domain/simulator#key=$(env_get SIMULATOR_KEY)"
  hint "Ссылку на тестовый чат можно дать сотрудникам клиники: доступа к данным пациентов она не даёт."
  title "Вебхук для кабинета Meta"
  say "  Callback URL:  https://$domain/webhook/whatsapp"
  say "  Verify token:  $(env_get WHATSAPP_VERIFY_TOKEN)"
  title "Клиники"
  while IFS= read -r f; do
    if [[ "$(jq -r '.whatsapp.phone_number_id // ""' "$f")" == REPLACE* ]]; then
      say "  $(clinic_label "$f") — WhatsApp не подключён"
    else
      say "  $(clinic_label "$f") — WhatsApp подключён"
    fi
  done < <(list_clinic_files)
  if [ "${1-}" = --secrets ]; then
    title "Секреты (не пересылайте в мессенджерах)"
    say "  Ключ шифрования базы:  $(env_get DATA_ENCRYPTION_KEY)"
    say "  Токен администратора:  $(env_get ADMIN_TOKEN)"
  else
    hint "Ключ шифрования базы и токен администратора: dental-bot info --secrets"
  fi
  title "Файлы"
  say "  $APP_DIR: .env — секреты, $CLINICS_REL/ — клиники, data/ — база и резервные копии"
}

cmd_help() {
  cat <<EOF
dental-bot — управление ИИ-администратором стоматологии

  dental-bot status          состояние бота, HTTPS и настроек
  dental-bot logs [caddy]    журнал в реальном времени (выход — Ctrl+C)
  dental-bot edit [клиника]  изменить прайс, врачей, расписание и тексты клиники
  dental-bot info            адреса, тестовый чат, данные для Meta (--secrets — ключи)
  dental-bot whatsapp [id]   подключить или заменить WhatsApp
  dental-bot telegram [id]   уведомления администратору в Telegram
  dental-bot add-clinic      добавить ещё одну клинику
  dental-bot settings        изменить домен или ключ Claude
  dental-bot update          обновить до новой версии (с резервной копией и откатом)
  dental-bot backup          резервная копия базы сейчас
  dental-bot check           проверить настройки
  dental-bot restart | stop | start
  dental-bot install         мастер установки

Установка без вопросов: NONINTERACTIVE=1 и переменные окружения
  DOMAIN, ANTHROPIC_API_KEY, CLINIC_NAME, CLINIC_ADDRESS, CLINIC_PHONE, CLINIC_HOURS,
  CLINIC_OPERATOR; по желанию CLINIC_TIMEZONE (Asia/Almaty), CLINIC_CURRENCY, CLINIC_POLICY_URL,
  WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN + WHATSAPP_APP_SECRET,
  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (через запятую).
  SKIP_KEY_CHECKS=1 — не проверять ключи через API, SKIP_DNS_CHECK=1 — не проверять DNS.
EOF
}

main() {
  COMMAND="${1:-help}"
  [ $# -gt 0 ] && shift
  cd "$APP_DIR" || die "Не найдена папка $APP_DIR"
  case "$COMMAND" in
    install) cmd_install "$@" ;;
    status) cmd_status ;;
    logs) cmd_logs "$@" ;;
    edit) cmd_edit "$@" ;;
    info) cmd_info "$@" ;;
    whatsapp) cmd_whatsapp "$@" ;;
    telegram) cmd_telegram "$@" ;;
    add-clinic) cmd_add_clinic ;;
    settings) cmd_settings ;;
    update) cmd_update ;;
    backup) cmd_backup ;;
    check) cmd_check ;;
    restart) cmd_restart ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    help | -h | --help) cmd_help ;;
    *)
      warn "Неизвестная команда: $COMMAND"
      cmd_help
      exit 2
      ;;
  esac
}

main "$@"
