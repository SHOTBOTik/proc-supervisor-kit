#!/usr/bin/env bash
# deploy.sh — шаблон безопасного выпуска новой версии долгоживущего Node-процесса.
#
#   deploy.sh --config deploy.conf [--dry-run]
#
# Шаги: 1) остановить процессы и убедиться, что их ноль; 2) бэкап версии в archive/<время>/;
# 3) вычистить секреты из старых логов и переложить их в бэкап; 4) положить новую версию (если задан SRC_DIR);
# 5) node --check всех точек входа; 6) сухой прогон с DRY=1; 7) запуск; 8) ждать свежий пульс.
# При неудаче — понятное сообщение и команды отката из бэкапа. Повторный запуск безопасен.
# --dry-run: только показать, что будет сделано; читает список процессов, ничего не меняет.
# Пример конфига — examples/deploy.conf.
set -u

KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
SELF="$KIT_DIR/$(basename "$0")"
CLI=(node "$KIT_DIR/src/cli.ts")

usage() { sed -n '2,12p' "$SELF" | sed 's/^# \{0,1\}//'; }

conf=""
PLAN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --config) [ $# -ge 2 ] || { usage >&2; exit 2; }; conf="$2"; shift 2 ;;
    --dry-run) PLAN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "deploy: неизвестный аргумент $1" >&2; usage >&2; exit 2 ;;
  esac
done
[ -n "$conf" ] || { usage >&2; exit 2; }
[ -f "$conf" ] || { echo "deploy: нет файла конфига $conf" >&2; exit 2; }

# умолчания; конфиг их переопределяет
APP_DIR=.
SRC_DIR=""
ARCHIVE_DIR=archive
STOP_MATCH=()
FILES=()
LOGS=()
SCRUB_VALUES_FROM=()
SCRUB_PATTERNS=()
ENTRIES=()
DRY_CMD=()
START=()
HEARTBEAT=""
HEARTBEAT_WAIT=30
STOP_SETTLE=2

conf_dir="$(cd "$(dirname "$conf")" && pwd)"
# shellcheck source=/dev/null
source "$conf_dir/$(basename "$conf")"
cd "$conf_dir" || exit 2
cd "$APP_DIR" || { echo "deploy: нет каталога приложения $APP_DIR" >&2; exit 2; }
APP_DIR="$(pwd)"
if [ -n "$SRC_DIR" ]; then
  ( cd "$conf_dir" && cd "$SRC_DIR" ) || { echo "deploy: нет каталога новой версии $SRC_DIR" >&2; exit 2; }
  SRC_DIR="$(cd "$conf_dir" && cd "$SRC_DIR" && pwd)"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$ARCHIVE_DIR/$stamp"
n=1
while [ -e "$backup" ]; do backup="$ARCHIVE_DIR/$stamp-$n"; n=$((n + 1)); done

step() { printf '\n== %s ==\n' "$*"; }
plan() { printf '  [dry-run] %s\n' "$*"; }
spawn() { "${CLI[@]}" spawn --cwd "$APP_DIR" -- "$@"; }

rollback_hint() {
  echo
  echo "Откат из бэкапа $APP_DIR/$backup:"
  echo "  1) остановить то, что успело запуститься:"
  for re in "${STOP_MATCH[@]}"; do echo "       node \"$KIT_DIR/src/cli.ts\" kill '$re'"; done
  echo "  2) вернуть файлы прошлой версии:"
  for f in "${FILES[@]}"; do echo "       cp -R \"$APP_DIR/$backup/$f\" \"$APP_DIR/$f\""; done
  echo "  3) запустить прошлую версию тем же способом, что в шаге 7:"
  if [ "${#START[@]}" -gt 0 ]; then echo "       node \"$KIT_DIR/src/cli.ts\" spawn --cwd \"$APP_DIR\" -- ${START[*]}"; else echo "       start_app из $conf"; fi
}

die() {
  local code="$1"; shift
  echo
  echo "СТОП: $*"
  [ "$PLAN" = 1 ] || rollback_hint
  exit "$code"
}

echo "deploy: приложение $APP_DIR${SRC_DIR:+, новая версия из $SRC_DIR}"
[ "$PLAN" = 1 ] && echo "deploy: сухой прогон — ничего не меняю"

step "1. останавливаю процессы"
[ "${#STOP_MATCH[@]}" -gt 0 ] || echo "  STOP_MATCH пуст — останавливать нечего"
for re in "${STOP_MATCH[@]}"; do
  echo "  -- $re"
  if [ "$PLAN" = 1 ]; then
    "${CLI[@]}" kill "$re" --dry-run | sed 's/^/  /'
  else
    "${CLI[@]}" kill "$re" | sed 's/^/  /'
    sleep 1
  fi
done
if [ "$PLAN" = 1 ]; then
  plan "проверить, что не осталось ни одного процесса"
else
  sleep "$STOP_SETTLE"
  left=0
  for re in "${STOP_MATCH[@]}"; do
    c="$("${CLI[@]}" ps "$re" --count)" || { echo "СТОП: список процессов не получен, деплой прерван до любых изменений"; exit 2; }
    left=$(( left + ${c//$'\r'/} ))
  done
  echo "  осталось процессов: $left"
  if [ "$left" != 0 ]; then
    echo "СТОП: процессы не остановлены, деплой прерван до любых изменений"
    exit 2
  fi
fi

step "2. бэкап текущей версии в $backup/"
if [ "$PLAN" = 1 ]; then
  for f in "${FILES[@]}"; do [ -e "$f" ] && plan "cp -R $f $backup/$f"; done
else
  mkdir -p "$backup" || die 2 "не создать $backup"
  for f in "${FILES[@]}"; do
    [ -e "$f" ] || { echo "  нет $f — пропускаю"; continue; }
    mkdir -p "$backup/$(dirname "$f")"
    cp -R "$f" "$backup/$f" || die 2 "бэкап $f не удался"
    echo "  $f"
  done
fi

step "3. старые логи: вычистить секреты и переложить в $backup/logs/"
scrub_args=(scrub-logs --to "$backup/logs")
for f in "${SCRUB_VALUES_FROM[@]}"; do scrub_args+=(--values-from "$f"); done
for p in "${SCRUB_PATTERNS[@]}"; do scrub_args+=(--pattern "$p"); done
[ "$PLAN" = 1 ] && scrub_args+=(--dry-run)
if [ "${#LOGS[@]}" -gt 0 ]; then
  "${CLI[@]}" "${scrub_args[@]}" -- "${LOGS[@]}" | sed 's/^/  /'
  [ "${PIPESTATUS[0]}" = 0 ] || die 2 "вычистка логов не удалась"
else
  echo "  LOGS пуст"
fi
echo "  (для строгой проверки можно прогнать архив ещё и сканером секретов, например leak-guard)"

step "4. новая версия"
if [ -z "$SRC_DIR" ]; then
  echo "  SRC_DIR не задан — файлы уже на месте"
else
  for f in "${FILES[@]}"; do
    [ -e "$SRC_DIR/$f" ] || { echo "  в новой версии нет $f — оставляю прежний"; continue; }
    if [ "$PLAN" = 1 ]; then plan "cp -R $SRC_DIR/$f $f"; continue; fi
    mkdir -p "$(dirname "$f")"
    rm -rf "$f.deploy-new" && cp -R "$SRC_DIR/$f" "$f.deploy-new" && rm -rf "$f" && mv "$f.deploy-new" "$f" || die 3 "не удалось положить $f"
    echo "  $f"
  done
fi

step "5. node --check точек входа"
for f in "${ENTRIES[@]}"; do
  if node --check "$f"; then echo "  $f: ок"; else die 3 "$f не проходит node --check"; fi
done

step "6. сухой прогон (DRY=1)"
if [ "${#DRY_CMD[@]}" -eq 0 ]; then
  echo "  DRY_CMD не задан — пропускаю"
elif [ "$PLAN" = 1 ]; then
  plan "DRY=1 ${DRY_CMD[*]}"
else
  DRY=1 "${DRY_CMD[@]}" 2>&1 | sed 's/^/  /'
  rc="${PIPESTATUS[0]}"
  [ "$rc" = 0 ] || die 4 "сухой прогон вышел с кодом $rc"
fi

step "7. запуск"
t0=$(( $(date +%s) * 1000 ))
if declare -F start_app >/dev/null; then
  if [ "$PLAN" = 1 ]; then plan "start_app из $conf"; else start_app || die 5 "start_app не удался"; fi
elif [ "${#START[@]}" -gt 0 ]; then
  if [ "$PLAN" = 1 ]; then plan "spawn ${START[*]}"; else
    pid="$(spawn "${START[@]}")" || die 5 "запуск не удался"
    echo "  запущено, pid $pid"
  fi
else
  die 5 "не задан ни START, ни start_app"
fi

step "8. проверка пульса"
if [ -z "$HEARTBEAT" ]; then
  echo "  HEARTBEAT не задан — проверяю только, что процессы есть"
  if [ "$PLAN" != 1 ] && [ "${#STOP_MATCH[@]}" -gt 0 ]; then
    sleep 3
    c="$("${CLI[@]}" ps "${STOP_MATCH[${#STOP_MATCH[@]}-1]}" --count)" || die 6 "список процессов не получен"
    c="${c//$'\r'/}"
    echo "  процессов: $c"
    [ "$c" -gt 0 ] || die 6 "после запуска процесса нет"
  fi
elif [ "$PLAN" = 1 ]; then
  plan "ждать свежий пульс в $HEARTBEAT до $HEARTBEAT_WAIT с"
else
  "${CLI[@]}" beat "$HEARTBEAT" --newer-than "$t0" --wait "$HEARTBEAT_WAIT" | sed 's/^/  /'
  [ "${PIPESTATUS[0]}" = 0 ] || die 6 "за $HEARTBEAT_WAIT с не появилось свежего пульса в $HEARTBEAT — новая версия не работает"
fi

echo
if [ "$PLAN" = 1 ]; then echo "deploy: сухой прогон окончен, ничего не изменено"; else echo "deploy: готово, бэкап прошлой версии — $APP_DIR/$backup"; fi
