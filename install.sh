#!/usr/bin/env bash
# Установка ИИ-администратора стоматологии (WhatsApp + Claude) на сервер.
#
# Вставьте в консоль сервера (Ubuntu 22.04/24.04 или Debian 12, пользователь root) одну строку:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/orkenchikai-pixel/bot/main/install.sh)
#
# Скрипт скачивает код в /opt/dental-bot и запускает мастер настройки (scripts/dental-bot.sh):
# он спросит домен, ключ Claude и данные WhatsApp, сам сгенерирует секреты и запустит бота.
# Повторный запуск безопасен: код обновится, настройки и ключ шифрования сохранятся.
#
# Для опытных: INSTALL_DIR, REPO_URL, BRANCH, GITHUB_TOKEN (закрытый репозиторий),
# NONINTERACTIVE=1 — установка без вопросов, ответы из переменных окружения (dental-bot help).
set -Eeuo pipefail

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m' RED=$'\033[31m' GREEN=$'\033[32m' RESET=$'\033[0m'
else
  BOLD="" RED="" GREEN="" RESET=""
fi

say() { printf '%s\n' "$*"; }
ok() { printf '%s\n' "${GREEN}✓${RESET} $*"; }
fail() {
  printf '%s\n' "${RED}✗ $*${RESET}" >&2
  exit 1
}

tty_available() { (: </dev/tty) 2>/dev/null; }

# git с токеном GitHub для закрытого репозитория. Токен передаётся через переменные окружения
# git (GIT_CONFIG_*), а не аргументы командной строки, — так его не видно в списке процессов.
git_auth() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    local basic
    basic="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
    GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0="http.https://github.com/.extraHeader" \
      GIT_CONFIG_VALUE_0="Authorization: Basic $basic" git "$@"
  else
    GIT_TERMINAL_PROMPT=0 git "$@"
  fi
}

clone_repo() {
  local repo="$1" branch="$2" dir="$3"
  if git_auth clone --quiet --depth 1 --branch "$branch" "$repo" "$dir" 2>/dev/null; then
    return 0
  fi
  rm -rf "$dir"
  if [ -z "${GITHUB_TOKEN:-}" ] && [ "${NONINTERACTIVE:-0}" != 1 ] && tty_available; then
    say "Не удалось скачать код из $repo."
    say "Если репозиторий закрытый, нужен токен GitHub с правом чтения: github.com → Settings →"
    say "Developer settings → Fine-grained tokens → доступ к репозиторию, Contents: Read-only."
    printf '%s ' "Вставьте токен (символы не отображаются) или нажмите Enter для выхода:"
    IFS= read -rs GITHUB_TOKEN </dev/tty || true
    printf '\n'
    GITHUB_TOKEN="${GITHUB_TOKEN//[[:space:]]/}"
  fi
  [ -n "${GITHUB_TOKEN:-}" ] || fail "Не удалось скачать код. Проверьте интернет на сервере и адрес репозитория ($repo)."
  git_auth clone --quiet --depth 1 --branch "$branch" "$repo" "$dir" ||
    fail "GitHub не принял токен или не нашёл репозиторий $repo (ветка $branch)."
  # Чтобы обновления (dental-bot update) работали без повторного ввода токена. Файл читает только root.
  local basic
  basic="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
  printf '[http "https://github.com/"]\n\textraHeader = Authorization: Basic %s\n' "$basic" >>"$dir/.git/config"
  chmod 600 "$dir/.git/config"
}

# Весь сценарий — в одной функции, которая вызывается в последней строке: если скачивание
# скрипта оборвётся на середине, не выполнится ничего.
main() {
  local repo="${REPO_URL:-https://github.com/orkenchikai-pixel/bot.git}"
  local branch="${BRANCH:-main}"
  local dir="${INSTALL_DIR:-/opt/dental-bot}"

  printf '\n%s\n\n' "${BOLD}Установка ИИ-администратора стоматологии${RESET}"

  if [ "$(id -u)" -ne 0 ] && [ "${SKIP_ROOT_CHECK:-0}" != 1 ]; then
    fail "Нужны права администратора. Введите команду  sudo -i  и вставьте команду установки ещё раз."
  fi
  if [ "${SKIP_OS_CHECK:-0}" != 1 ] && ! grep -Eqs '^ID(_LIKE)?=.*(debian|ubuntu)' /etc/os-release; then
    fail "Установщик рассчитан на Ubuntu 22.04/24.04 или Debian 12. Выберите одну из них в панели хостинга (переустановка ОС)."
  fi

  if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    say "Устанавливаю git и curl…"
    export DEBIAN_FRONTEND=noninteractive
    apt-get -o DPkg::Lock::Timeout=600 update -qq >/dev/null
    apt-get -o DPkg::Lock::Timeout=600 install -y -qq git curl ca-certificates >/dev/null
  fi

  if [ -d "$dir/.git" ]; then
    if [ "${SKIP_GIT_UPDATE:-0}" = 1 ]; then
      ok "Код уже на месте: $dir"
    else
      say "Обновляю код в $dir…"
      git_auth -C "$dir" pull --ff-only --quiet ||
        fail "Не удалось обновить код. Если вы меняли файлы в $dir вручную, посмотрите: git -C $dir status"
      ok "Код обновлён"
    fi
  elif [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    fail "Папка $dir уже существует и не пуста. Укажите другую: INSTALL_DIR=/opt/другая-папка"
  else
    say "Скачиваю код в $dir…"
    clone_repo "$repo" "$branch" "$dir"
    ok "Код скачан"
  fi

  # Вопросы мастера читаются с терминала, даже если этот скрипт пришёл через «curl … | bash».
  if [ ! -t 0 ] && tty_available; then
    exec bash "$dir/scripts/dental-bot.sh" install "$@" </dev/tty
  fi
  exec bash "$dir/scripts/dental-bot.sh" install "$@"
}

main "$@"
