#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source_root="$repo_root/third_party/adi-no-os/src"
output_root="$repo_root/src/vendor/adi-no-os"
compiler=${EMCC:-emcc}

mkdir -p "$output_root"
"$compiler" \
  "$source_root/bridge.c" \
  "$source_root/ad9361/ad9361.c" \
  "$source_root/ad9361/ad9361_api.c" \
  "$source_root/ad9361/ad9361_util.c" \
  "$source_root/ad9361/ad9361_conv.c" \
  "$source_root/ad9361/ad9361_ext_band_ctrl.c" \
  "$source_root/util/no_os_alloc.c" \
  "$source_root/util/no_os_util.c" \
  "$source_root/util/no_os_gpio.c" \
  -I"$source_root/include" \
  -I"$source_root/ad9361" \
  -DAXI_ADC_NOT_PRESENT=1 \
  -O3 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web \
  -sASYNCIFY=1 \
  -sASYNCIFY_IMPORTS='["browser_spi","browser_delay"]' \
  -sALLOW_MEMORY_GROWTH=1 \
  -sNO_EXIT_RUNTIME=1 \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_bridge_last_error","_bridge_initialize","_bridge_set_rate","_bridge_get_rate","_bridge_set_bandwidth","_bridge_get_bandwidth","_bridge_set_lo","_bridge_get_lo","_bridge_set_input","_bridge_get_input","_bridge_set_gain_mode","_bridge_get_gain_mode","_bridge_set_ensm","_bridge_get_ensm","_bridge_rx_pll_locked","_bridge_slow_agc_mode","_bridge_ensm_rx_mode","_bridge_ensm_alert_mode"]' \
  -o "$output_root/ad9364-no-os.js"

perl -0pi -e 's/wasmExports=await \(createWasm\(\)\);run\(\);/wasmExports=await (createWasm());run();Object.defineProperties(Module,{HEAPU8:{get:()=>HEAPU8},HEAPU32:{get:()=>HEAPU32}});Module["awaitAsyncify"]=(result)=>Asyncify.currData?Asyncify.whenDone():Promise.resolve(result);/' \
  "$output_root/ad9364-no-os.js"
grep -q 'Module\["awaitAsyncify"\]' "$output_root/ad9364-no-os.js"
grep -q 'Object.defineProperties(Module,{HEAPU8:' "$output_root/ad9364-no-os.js"

sha256sum "$output_root/ad9364-no-os.js" "$output_root/ad9364-no-os.wasm"
