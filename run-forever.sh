#!/usr/bin/env bash
# run-forever.sh — держит команду запущенной: упала — поднимает снова, с паузой, растущей до предела.
# Код выхода 3 значит «не перезапускай» (например, уже работает другой экземпляр) — тогда обёртка выходит.
#
#   run-forever.sh [--log FILE] [--name NAME] [--] command [args...]
#
#   --log FILE   строки «старт»/«стоп» и вывод команды дописываются в FILE (иначе — в stdout)
#   --name NAME  имя в строках лога (по умолчанию — первое слово команды)
#
# Переменные окружения (целые секунды):
#   RF_MIN_DELAY=5     первая пауза перед перезапуском
#   RF_MAX_DELAY=300   предел паузы: каждая следующая вдвое длиннее, но не больше этого
#   RF_RESET_AFTER=60  если команда проработала дольше, пауза сбрасывается к RF_MIN_DELAY
#   RF_STOP_CODE=3     код выхода «не перезапускать»
set -u

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }

log_file=""
name=""
while [ $# -gt 0 ]; do
  case "$1" in
    --log) [ $# -ge 2 ] || { echo "run-forever: --log: нужен файл" >&2; exit 2; }; log_file="$2"; shift 2 ;;
    --name) [ $# -ge 2 ] || { echo "run-forever: --name: нужно имя" >&2; exit 2; }; name="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) echo "run-forever: неизвестный флаг $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || { usage >&2; exit 2; }
[ -n "$name" ] || name="$(basename "$1")"

min_delay="${RF_MIN_DELAY:-5}"
max_delay="${RF_MAX_DELAY:-300}"
reset_after="${RF_RESET_AFTER:-60}"
stop_code="${RF_STOP_CODE:-3}"
for v in "$min_delay" "$max_delay" "$reset_after" "$stop_code"; do
  case "$v" in ''|*[!0-9]*) echo "run-forever: RF_* должны быть целыми числами" >&2; exit 2 ;; esac
done
[ "$max_delay" -ge "$min_delay" ] || max_delay="$min_delay"

say() {
  local line
  line="$(date -u +%FT%TZ) [run-forever] $name: $*"
  if [ -n "$log_file" ]; then printf '%s\n' "$line" >> "$log_file"; else printf '%s\n' "$line"; fi
}

child=""
on_signal() {
  say "стоп: обёртка получила сигнал, снимаю команду и выхожу"
  [ -n "$child" ] && kill "$child" 2>/dev/null
  wait 2>/dev/null
  exit 0
}
trap on_signal INT TERM HUP

delay="$min_delay"
while true; do
  say "старт: $*"
  started="$(date +%s)"
  # команда — в фоне, а обёртка ждёт её через wait: так сигнал до обёртки доходит сразу
  if [ -n "$log_file" ]; then "$@" >> "$log_file" 2>&1 & else "$@" & fi
  child=$!
  wait "$child"
  rc=$?
  child=""
  ran=$(( $(date +%s) - started ))
  if [ "$rc" -eq "$stop_code" ]; then
    say "стоп: код $rc — перезапуск не нужен (например, уже работает другой экземпляр), обёртка выходит"
    exit 0
  fi
  [ "$ran" -ge "$reset_after" ] && delay="$min_delay"
  say "стоп: код $rc после ${ran} с работы, перезапуск через ${delay} с"
  sleep "$delay"
  delay=$(( delay * 2 ))
  [ "$delay" -lt 1 ] && delay=1
  [ "$delay" -gt "$max_delay" ] && delay="$max_delay"
  [ "$delay" -lt "$min_delay" ] && delay="$min_delay"
done
