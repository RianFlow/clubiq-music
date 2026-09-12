#!/bin/sh
set -eu

LAN_INTERFACE="${CLUBIQ_LAN_INTERFACE:-eth0}"
WIFI_INTERFACE="${CLUBIQ_WIFI_INTERFACE:-wlan1}"
WIFI_CONNECTION="${CLUBIQ_WIFI_CONNECTION:-clubiq-internet-wlan}"
STATE_DIRECTORY="${CLUBIQ_UPLINK_STATE_DIRECTORY:-/run/clubiq-uplink-failover}"
SUCCESS_FILE="$STATE_DIRECTORY/lan-successes"
MODE_FILE="$STATE_DIRECTORY/mode"

mkdir -p "$STATE_DIRECTORY"

lan_is_online() {
    ip -4 route show default dev "$LAN_INTERFACE" 2>/dev/null | grep -q '^default ' || return 1
    ping -I "$LAN_INTERFACE" -c 1 -W 3 1.1.1.1 >/dev/null 2>&1 \
        || ping -I "$LAN_INTERFACE" -c 1 -W 3 9.9.9.9 >/dev/null 2>&1
}

wifi_is_connected() {
    state="$(nmcli -g GENERAL.STATE device show "$WIFI_INTERFACE" 2>/dev/null || true)"
    case "$state" in
        100*) return 0 ;;
        *) return 1 ;;
    esac
}

read_successes() {
    if [ -r "$SUCCESS_FILE" ]; then
        value="$(cat "$SUCCESS_FILE")"
        case "$value" in
            ''|*[!0-9]*) printf '0' ;;
            *) printf '%s' "$value" ;;
        esac
    else
        printf '0'
    fi
}

record_mode() {
    mode="$1"
    previous="$(cat "$MODE_FILE" 2>/dev/null || true)"
    printf '%s\n' "$mode" > "$MODE_FILE"
    if [ "$previous" != "$mode" ]; then
        printf 'ClubIQ Internetweg: %s\n' "$mode"
    fi
}

if lan_is_online; then
    successes="$(read_successes)"
    if [ "$successes" -lt 3 ]; then
        successes=$((successes + 1))
    fi
    printf '%s\n' "$successes" > "$SUCCESS_FILE"

    if [ "$successes" -ge 3 ]; then
        if wifi_is_connected; then
            nmcli --wait 10 device disconnect "$WIFI_INTERFACE" >/dev/null
        fi
        record_mode "LAN aktiv, Internet-WLAN in Bereitschaft"
    fi
    exit 0
fi

printf '0\n' > "$SUCCESS_FILE"
if ! wifi_is_connected; then
    nmcli --wait 20 connection up "$WIFI_CONNECTION" ifname "$WIFI_INTERFACE" >/dev/null
fi
record_mode "LAN nicht erreichbar, Internet-WLAN aktiv"
