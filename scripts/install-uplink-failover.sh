#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Bitte mit sudo starten: sudo ./scripts/install-uplink-failover.sh" >&2
    exit 1
fi

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

command -v nmcli >/dev/null 2>&1 || {
    echo "NetworkManager/nmcli fehlt." >&2
    exit 1
}
command -v ping >/dev/null 2>&1 || {
    echo "ping fehlt." >&2
    exit 1
}

install -m 0755 "$project_dir/scripts/clubiq-uplink-failover.sh" \
    /usr/local/sbin/clubiq-uplink-failover
install -m 0644 "$project_dir/scripts/clubiq-uplink-failover.service" \
    /etc/systemd/system/clubiq-uplink-failover.service
install -m 0644 "$project_dir/scripts/clubiq-uplink-failover.timer" \
    /etc/systemd/system/clubiq-uplink-failover.timer

systemctl daemon-reload
systemctl enable --now clubiq-uplink-failover.timer
systemctl start clubiq-uplink-failover.service

echo "ClubIQ Notfall-Internet ist aktiv."
systemctl --no-pager status clubiq-uplink-failover.timer
