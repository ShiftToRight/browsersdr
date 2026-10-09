#!/usr/bin/env python3
"""Inspect a GEO-1 synthetic pair with the configured local Atlas implementation.
No HTTP, database, object-store or production upload is performed.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--atlas-root", type=Path, default=ROOT.parent / "SigIntAtlas")
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    args = parser.parse_args()
    metadata_bytes = args.metadata.read_bytes()
    data = args.data.read_bytes()
    metadata = json.loads(metadata_bytes)
    site = metadata["captures"][0]["browsersdr:receiver_location"]
    assert metadata["captures"][0]["core:geolocation"]["coordinates"][:2] == [site["longitude"], site["latitude"]]
    assert hashlib.sha512(data).hexdigest() == metadata["global"]["core:sha512"]
    atlas_python = args.atlas_root / ".venv/bin/python"
    if not atlas_python.is_file():
        raise SystemExit(f"missing configured interpreter: {atlas_python}")
    source_files = ["backend/src/signal_atlas/sigmf/service.py", "backend/src/signal_atlas/ingestion/service.py"]
    code = """
import asyncio, json, sys
from signal_atlas.sigmf.service import SigMFInspector
from signal_atlas.ingestion.service import _sigmf_catalog_fields, _json
v = json.load(sys.stdin)
async def chunks(): yield v['metadata'].encode()
r = asyncio.run(SigMFInspector().inspect(chunks(), v['bytes']))
assert r.analysis_ready, r.issues
expected = json.loads(v['metadata'])
assert r.normalized == expected
fields = _sigmf_catalog_fields(r.normalized)
site = expected['captures'][0]['browsersdr:receiver_location']
assert fields['latitude'] == site['latitude'] and fields['longitude'] == site['longitude']
assert fields['provenance']['location'] == 'sigmf:core:geolocation'
# The real revision serializer retains all acquisition metadata in extensions.
revision = json.loads(_json({'sigmf': r.normalized}))
assert revision['sigmf']['captures'][0]['browsersdr:receiver_location'] == site
print(json.dumps({'parser': r.parser_version, 'analysis_ready': r.analysis_ready,
 'samples': r.sample_count, 'location_provenance': fields['provenance']['location'],
 'extension_roundtrip': True, 'catalog_accuracy_source_fields': False}))
"""
    env = dict(os.environ, PYTHONPATH=str(args.atlas_root / "backend/src"), PYTHONDONTWRITEBYTECODE="1")
    completed = subprocess.run([str(atlas_python), "-c", code], input=json.dumps({"metadata": metadata_bytes.decode(), "bytes": len(data)}), text=True, capture_output=True, check=True, env=env)
    result = json.loads(completed.stdout)
    result["dataset_sha256"] = hashlib.sha256(data).hexdigest()
    result["metadata_sha256"] = hashlib.sha256(metadata_bytes).hexdigest()
    result["atlas_source_sha256"] = {path: hashlib.sha256((args.atlas_root / path).read_bytes()).hexdigest() for path in source_files}
    result["scope"] = "Local actual inspector/catalog/revision serialization; no HTTP/database/object-store acceptance."
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
