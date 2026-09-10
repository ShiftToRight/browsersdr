#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate_directory="$repository_root/wasm/spectrum-analysis"
output_directory="$repository_root/src/wasm/pkg"

(cd "$crate_directory" && cargo build --target wasm32-unknown-unknown --release --locked)
mkdir -p "$output_directory"
cp "$crate_directory/target/wasm32-unknown-unknown/release/browsersdr_spectrum_wasm.wasm" "$output_directory/spectrum_analysis.wasm"
