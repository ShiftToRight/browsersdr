#!/usr/bin/env python3
"""Capture actual upstream libhackrf requests without USB hardware.

Usage: python3 scripts/verify-hackrf-one-oracle.py PINNED_HACKRF_ROOT LIBUSB_HEADER
Reads local upstream sources only. Does not download, open USB, or update fixtures.
Compare the resulting requests with src/testing/fixtures/hackrf-one/wire-oracle.json.
"""
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile

root = pathlib.Path(sys.argv[1]).resolve()
header = pathlib.Path(sys.argv[2]).resolve()
source = root / 'host/libhackrf/src/hackrf.c'
expected = json.loads((pathlib.Path(__file__).resolve().parent.parent / 'src/testing/fixtures/hackrf-one/wire-oracle.json').read_text())
for path, key in [(source, 'sourceSha256'), (source.parent / 'hackrf.h', 'headerSha256'), (header, 'libusbHeaderSha256')]:
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected[key]:
        raise SystemExit(f'Unexpected upstream bytes: {path}')

harness = r'''
#include <stdio.h>
#include "hackrf.c"
static const char *operation;
libusb_device *libusb_get_device(libusb_device_handle *handle) { return (void *)handle; }
int libusb_get_device_descriptor(libusb_device *dev, struct libusb_device_descriptor *desc) {
  (void)dev; memset(desc, 0, sizeof(*desc)); desc->bcdDevice = 0x0110; return 0;
}
int libusb_control_transfer(libusb_device_handle *handle, uint8_t type, uint8_t request,
 uint16_t value, uint16_t index, unsigned char *data, uint16_t length, unsigned int timeout) {
 (void)handle; (void)timeout;
 printf("{\"operation\":\"%s\",\"direction\":\"%s\",\"request\":%u,\"value\":%u,\"index\":%u,\"length\":%u,\"bytes\":[", operation, (type & 128) ? "in" : "out", request, value, index, length);
 if (!(type & 128)) for (unsigned n=0; n<length; n++) printf("%s%u", n ? "," : "", data[n]);
 puts("]}");
 if ((type & 128) && length) memset(data, 1, length);
 return length;
}
#define RUN(label, call) do { operation = label; if ((call) != 0) return 2; } while (0)
int main(void) {
 struct hackrf_device device = { .usb_device = (void *)1 };
 hackrf_bias_t_user_settting_req bias = { .off = {true,true,false}, .rx = {true,true,false} };
 RUN("bias-off-rx", hackrf_set_user_bias_t_opts(&device, &bias));
 RUN("off", hackrf_set_transceiver_mode(&device, HACKRF_TRANSCEIVER_MODE_OFF));
 RUN("rate-filter", hackrf_set_sample_rate(&device, 9600000));
 RUN("frequency", hackrf_set_freq(&device, 100000000));
 RUN("lna", hackrf_set_lna_gain(&device, 16));
 RUN("vga", hackrf_set_vga_gain(&device, 12));
 RUN("amplifier-off", hackrf_set_amp_enable(&device, 0));
 RUN("antenna-off", hackrf_set_antenna_enable(&device, 0));
 RUN("trigger-off", hackrf_set_hw_sync_mode(&device, 0));
 RUN("rx", hackrf_set_transceiver_mode(&device, HACKRF_TRANSCEIVER_MODE_RECEIVE));
 return 0;
}
'''
with tempfile.TemporaryDirectory(prefix='browsersdr-one-oracle-') as directory:
    scratch = pathlib.Path(directory)
    (scratch / 'libusb.h').write_bytes(header.read_bytes())
    (scratch / 'oracle.c').write_text(harness)
    subprocess.run(['cc', '-O2', '-ffunction-sections', '-fdata-sections', '-I', str(scratch), '-I', str(source.parent), str(scratch / 'oracle.c'), '-Wl,--gc-sections', '-pthread', '-lm', '-o', str(scratch / 'oracle')], check=True)
    output = subprocess.check_output([str(scratch / 'oracle')], text=True)
    requests = [json.loads(line) for line in output.splitlines()]
    print(json.dumps({'referenceCommit': '1cfe7dfe98d333450217d50e3f3a1ad0702e000f', 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'headerSha256': hashlib.sha256((source.parent / 'hackrf.h').read_bytes()).hexdigest(), 'libusbHeaderSha256': hashlib.sha256(header.read_bytes()).hexdigest(), 'requests': requests}, indent=2))
