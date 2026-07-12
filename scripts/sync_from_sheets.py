#!/usr/bin/env python3
"""Download the Google Sheet as XLSX and regenerate data/mpps.json."""

from __future__ import annotations

import hashlib
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
XLSX = ROOT / "Current Ontario MPPs & How They Vote..xlsx"
CONVERT = ROOT / "scripts" / "convert.py"

# Editable Google Sheet (must be shared: Anyone with the link can view)
SHEET_ID = "1AirsQoXck1db6c1ibgjEii-qRbm-vQXr"
# Published spreadsheet (File → Share → Publish to web)
PUB_ID = "2PACX-1vRnzo_N8iyfD6qkrY5dHKkkANpImp4PoHagNABGDrhqHWaKOWHfkHKhldvTd8Eczw"

DOWNLOAD_URLS = [
    f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=xlsx",
    f"https://docs.google.com/spreadsheets/d/e/{PUB_ID}/pub?output=xlsx",
]


def download(url: str, dest: Path) -> None:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "OAC-MPP-Tracker/1.0 (github.com/NomadBuilder/ontario-mpp-tracker)"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    if len(data) < 1000:
        raise RuntimeError(f"Download too small ({len(data)} bytes) from {url}")
    # Google sometimes returns HTML login page
    if data[:20].lstrip().startswith(b"<") or b"<!DOCTYPE" in data[:200]:
        raise RuntimeError(f"Got HTML instead of XLSX from {url} — is the sheet shared publicly?")
    dest.write_bytes(data)


def file_hash(path: Path) -> str:
    if not path.exists():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    print("Downloading Google Sheet…", flush=True)
    last_err: Exception | None = None
    for url in DOWNLOAD_URLS:
        try:
            print(f"  Trying {url}", flush=True)
            download(url, XLSX)
            print(f"  Saved {XLSX} ({XLSX.stat().st_size:,} bytes)", flush=True)
            break
        except Exception as e:
            last_err = e
            print(f"  Failed: {e}", flush=True)
    else:
        print(f"All download URLs failed. Last error: {last_err}", file=sys.stderr)
        return 1

    before = file_hash(ROOT / "data" / "mpps.json")
    print("Converting to JSON…", flush=True)
    result = subprocess.run(
        [sys.executable, "-u", str(CONVERT), "--xlsx", str(XLSX)],
        cwd=ROOT,
        check=False,
    )
    if result.returncode != 0:
        return result.returncode

    after = file_hash(ROOT / "data" / "mpps.json")
    if before == after:
        print("No data changes.")
    else:
        print("data/mpps.json updated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
