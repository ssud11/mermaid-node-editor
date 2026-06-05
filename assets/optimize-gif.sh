#!/usr/bin/env bash
# Turn a raw screen recording (gif/mp4/webm) into a README-sized, palette-optimized
# GIF at images/demo.gif. Uses ffmpeg's two-pass palettegen/paletteuse (high quality,
# small file) — no gifski needed.
#
# Usage: assets/optimize-gif.sh <input.(gif|mp4|webm)> [width] [fps]
set -euo pipefail

in="${1:?usage: assets/optimize-gif.sh <input> [width=900] [fps=12]}"
width="${2:-900}"
fps="${3:-12}"
out="images/demo.gif"
pal="$(mktemp --suffix=.png)"
trap 'rm -f "$pal"' EXIT

filters="fps=${fps},scale=${width}:-1:flags=lanczos"
ffmpeg -y -i "$in" -vf "${filters},palettegen=stats_mode=diff" "$pal"
ffmpeg -y -i "$in" -i "$pal" \
  -lavfi "${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" "$out"

echo "wrote ${out} ($(du -h "$out" | cut -f1)), ${width}px @ ${fps}fps"
