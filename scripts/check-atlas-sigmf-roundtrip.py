#!/usr/bin/env python3
"""Optional BSD-01 contract/engine round trip; writes only to an owned temp directory."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ATLAS = ROOT.parent / "SignalAtlas"
DEFAULT_EXPLORER = ROOT.parent / "SignalExplorer" / "poc"
FIXTURE = ROOT / "docs/implementation/atlas-integration/fixtures/browsersdr-cu8-v1.json"


def run(command: list[str], *, env: dict[str, str], stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, input=stdin, text=True, capture_output=True, check=True, env=env)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--atlas-root", type=Path, default=DEFAULT_ATLAS)
    parser.add_argument("--explorer-root", type=Path, default=DEFAULT_EXPLORER)
    args = parser.parse_args()

    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    data = base64.b64decode(fixture["data_base64"], validate=True)
    metadata_bytes = (json.dumps(fixture["metadata"], indent=2) + "\n").encode()
    data_sha256 = hashlib.sha256(data).hexdigest()
    data_sha512 = hashlib.sha512(data).hexdigest()
    assert str(len(data)) == fixture["data_byte_length"]
    assert data_sha256 == fixture["data_sha256"]
    assert data_sha512 == fixture["data_sha512"] == fixture["metadata"]["global"]["core:sha512"]

    explorer_python = args.explorer_root / ".venv/bin/python"
    atlas_python = args.atlas_root / ".venv/bin/python"
    for executable in (explorer_python, atlas_python):
        if not executable.is_file():
            raise SystemExit(f"missing configured interpreter: {executable}")

    explorer_env = os.environ.copy()
    explorer_env["PYTHONPATH"] = str(args.explorer_root / "src")
    identity = run(
        [str(explorer_python), "-c", "from sigmf_poc.engine_info import get_engine_info; print(get_engine_info().model_dump_json())"],
        env=explorer_env,
    ).stdout.strip()

    preflight_input = json.dumps({"metadata": fixture["metadata"], "identity": json.loads(identity)})
    preflight_code = """
import json, sys
from signal_atlas.integrations.signal_explorer import EngineInfoV1, preflight_layout
value = json.load(sys.stdin)
decision = preflight_layout(value["metadata"], "identify", EngineInfoV1.model_validate(value["identity"]))
print(decision.model_dump_json())
"""
    atlas_env = os.environ.copy()
    atlas_env["PYTHONPATH"] = str(args.atlas_root / "backend/src")
    decision = json.loads(run([str(atlas_python), "-c", preflight_code], env=atlas_env, stdin=preflight_input).stdout)
    assert decision["archive_eligible"] is True
    assert decision["analysis_eligible"] is True
    assert decision["issues"] == []

    with tempfile.TemporaryDirectory(prefix="browsersdr-bsd01-") as temporary:
        owned = Path(temporary)
        metadata_path = owned / "fixture.sigmf-meta"
        data_path = owned / "fixture.sigmf-data"
        output_root = owned / "attempts"
        metadata_path.write_bytes(metadata_bytes)
        data_path.write_bytes(data)
        completed = run(
            [
                str(explorer_python), "-m", "sigmf_poc.worker", "run",
                "--metadata", str(metadata_path), "--data", str(data_path),
                "--output-root", str(output_root), "--operation", "identify",
                "--profile", "offline-bounded-v1", "--job-id", "bsd-01-fixture",
                "--attempt-id", "bsd-01-attempt", "--expected-sha256", data_sha256,
            ],
            env=explorer_env,
        )
        response = json.loads(completed.stdout)
        manifest = json.loads((output_root / "bsd-01-fixture/bsd-01-attempt/manifest.json").read_text())
        assert response["outcome"] in {"success", "partial"}
        assert manifest["input"]["actual_sha256"] == data_sha256
        assert manifest["input"]["hash_verification"] == "matched"

    print(json.dumps({
        "contract_version": fixture["contract_version"],
        "data_sha256": data_sha256,
        "data_sha512": data_sha512,
        "atlas_preflight": "analysis_eligible",
        "engine_hash_verification": "matched",
        "engine_outcome": manifest["outcome"],
    }, indent=2))


if __name__ == "__main__":
    main()
