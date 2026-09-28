#!/usr/bin/env python3
"""Receive-only UHD baseline for the BrowserSDR B205-mini profile.

This intentionally constructs no TX streamer and performs no persistent write.
It reports every RX metadata error rather than hiding overflow recovery.
"""

from __future__ import annotations

import argparse
import signal
import sys
import time

import numpy as np
import uhd


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--args", default="type=b200,recv_frame_size=16360,num_recv_frames=32")
    parser.add_argument("--rate", type=float, default=19_200_000)
    parser.add_argument("--master-clock", type=float, default=38_400_000)
    parser.add_argument("--frequency", type=float, default=100_000_000)
    parser.add_argument("--bandwidth", type=float, default=19_200_000)
    parser.add_argument("--duration", type=float, default=60)
    parser.add_argument("--report-interval", type=float, default=5)
    return parser.parse_args()


def main() -> int:
    options = arguments()
    if options.duration <= 0 or options.rate <= 0 or options.report_interval <= 0:
        raise ValueError("duration, rate and report interval must be positive")

    radio = uhd.usrp.MultiUSRP(options.args)
    radio.set_clock_source("internal")
    radio.set_time_source("internal")
    radio.set_master_clock_rate(options.master_clock)
    radio.set_rx_antenna("RX2", 0)
    radio.set_rx_agc(True, 0)
    radio.set_rx_rate(options.rate, 0)
    radio.set_rx_bandwidth(options.bandwidth, 0)
    radio.set_rx_freq(uhd.types.TuneRequest(options.frequency), 0)

    accepted_rate = radio.get_rx_rate(0)
    accepted_bandwidth = radio.get_rx_bandwidth(0)
    accepted_frequency = radio.get_rx_freq(0)
    print(
        "configured"
        f" requested_rate={options.rate:.0f} accepted_rate={accepted_rate:.0f}"
        f" requested_bandwidth={options.bandwidth:.0f} accepted_bandwidth={accepted_bandwidth:.0f}"
        f" requested_frequency={options.frequency:.0f} accepted_frequency={accepted_frequency:.0f}",
        flush=True,
    )

    stream_args = uhd.usrp.StreamArgs("fc32", "sc16")
    stream_args.channels = [0]
    streamer = radio.get_rx_stream(stream_args)
    buffer = np.empty((1, streamer.get_max_num_samps()), dtype=np.complex64)
    metadata = uhd.types.RXMetadata()
    start = uhd.types.StreamCMD(uhd.types.StreamMode.start_cont)
    start.stream_now = True

    stopping = False

    def request_stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    errors = {name: 0 for name in uhd.types.RXMetadataErrorCode.__members__ if name != "none"}
    samples = 0
    calls = 0
    started = time.monotonic()
    deadline = started + options.duration
    next_report = started + options.report_interval
    streamer.issue_stream_cmd(start)
    try:
        while not stopping and time.monotonic() < deadline:
            received = streamer.recv(buffer, metadata, 1.0)
            calls += 1
            samples += received
            if metadata.error_code != uhd.types.RXMetadataErrorCode.none:
                name = str(metadata.error_code).rsplit(".", 1)[-1]
                errors[name] = errors.get(name, 0) + 1
                print(
                    f"metadata_error kind={name} received={received} detail={metadata.strerror()}",
                    file=sys.stderr,
                    flush=True,
                )
            now = time.monotonic()
            if now >= next_report:
                elapsed = now - started
                print(
                    f"progress seconds={elapsed:.3f} samples={samples}"
                    f" effective_rate={samples / elapsed:.0f} recv_calls={calls} errors={errors}",
                    flush=True,
                )
                next_report = now + options.report_interval
    finally:
        stop = uhd.types.StreamCMD(uhd.types.StreamMode.stop_cont)
        stop.stream_now = True
        streamer.issue_stream_cmd(stop)

    elapsed = time.monotonic() - started
    clean = all(value == 0 for value in errors.values())
    print(
        f"result seconds={elapsed:.3f} samples={samples} effective_rate={samples / elapsed:.0f}"
        f" recv_calls={calls} errors={errors} clean={str(clean).lower()}",
        flush=True,
    )
    return 0 if clean and samples / elapsed >= accepted_rate * 0.995 else 1


if __name__ == "__main__":
    raise SystemExit(main())
