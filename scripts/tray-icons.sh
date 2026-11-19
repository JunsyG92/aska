#!/bin/sh
# Regenerates the system tray icons from assets/aska.svg.
# The PNGs are committed: this script is only needed when the icon changes.
# Requires rsvg-convert (package librsvg2-bin).
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
A="$ROOT/assets"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# "Running" variant: the icon plus a green dot in the top right corner.
sed 's#</svg>#  <circle cx="102" cy="26" r="24" fill="\#3fb950" stroke="\#17171a" stroke-width="8"/>\n</svg>#' \
  "$A/aska.svg" > "$TMP/running.svg"

for size in 22 44; do
  suffix=""
  [ "$size" = 44 ] && suffix="@2x"
  rsvg-convert -w "$size" -h "$size" "$A/aska.svg" -o "$A/tray$suffix.png"
  rsvg-convert -w "$size" -h "$size" "$TMP/running.svg" -o "$A/tray-running$suffix.png"
done
echo "Icons regenerated in $A"
