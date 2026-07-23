#!/usr/bin/env python3
"""
Fetch Google News RSS hits for Ontario MPPs / ministers and write candidate
stories for editorial review.

Live site reads data/accountability.json only (curated).
This script writes data/accountability-candidates.json — promote items manually.

Usage:
  python3 scripts/fetch_accountability_news.py
  python3 scripts/fetch_accountability_news.py --limit 40
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MPPS_PATH = ROOT / "data" / "mpps.json"
OUT_PATH = ROOT / "data" / "accountability-candidates.json"
CURATED_PATH = ROOT / "data" / "accountability.json"

UA = "OAC-MPP-Tracker/1.0 (accountability-watch; github.com/NomadBuilder/ontario-mpp-tracker)"

# Prefer people in power / recent heat; still searchable for all if --all
ROLE_HINT = re.compile(
    r"\b(minister|premier|associate minister|parliamentary assistant|whip|house leader)\b",
    re.I,
)

QUERY_SUFFIX = '(Ontario OR "Queen\'s Park" OR MPP OR "Integrity Commissioner")'


def load_mpps() -> list[dict]:
    data = json.loads(MPPS_PATH.read_text(encoding="utf-8"))
    return list(data.get("mpps") or [])


def display_name(mpp: dict) -> str:
    return re.sub(r"^Hon\.\s*", "", str(mpp.get("name") or "")).strip()


def search_name(mpp: dict) -> str:
    first = str(mpp.get("firstName") or "").strip()
    last = str(mpp.get("lastName") or "").strip()
    if first and last:
        return f"{first} {last}"
    return display_name(mpp)


def known_urls() -> set[str]:
    urls: set[str] = set()
    for path in (CURATED_PATH, OUT_PATH):
        if not path.exists():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        for item in payload.get("items") or []:
            u = str(item.get("url") or "").strip()
            if u:
                urls.add(u)
    return urls


def google_news_rss(query: str) -> str:
    q = urllib.parse.quote_plus(query)
    return f"https://news.google.com/rss/search?q={q}&hl=en-CA&gl=CA&ceid=CA:en"


def fetch_xml(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=45) as resp:
        return resp.read()


def parse_rss(xml_bytes: bytes) -> list[dict]:
    root = ET.fromstring(xml_bytes)
    channel = root.find("channel")
    if channel is None:
        return []
    items = []
    for item in channel.findall("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        source_el = item.find("source")
        source = (source_el.text or "").strip() if source_el is not None else ""
        pub = (item.findtext("pubDate") or "").strip()
        date = ""
        if pub:
            try:
                date = parsedate_to_datetime(pub).date().isoformat()
            except (TypeError, ValueError, IndexError):
                date = ""
        if title and link:
            items.append(
                {
                    "title": title,
                    "url": link,
                    "source": source or "Google News",
                    "date": date,
                }
            )
    return items


def slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:48] or "item"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--all", action="store_true", help="Query every MPP (slow)")
    ap.add_argument("--limit", type=int, default=80, help="Max candidate items to keep")
    ap.add_argument("--per-mpp", type=int, default=4, help="Max hits kept per MPP")
    args = ap.parse_args()

    mpps = load_mpps()
    if not args.all:
        mpps = [
            m
            for m in mpps
            if ROLE_HINT.search(str(m.get("roles") or ""))
            or str(m.get("party") or "").startswith("Progressive")
        ]

    seen = known_urls()
    candidates: list[dict] = []

    print(f"Querying Google News RSS for {len(mpps)} MPPs…", flush=True)
    for i, mpp in enumerate(mpps, 1):
        name = search_name(mpp)
        if not name:
            continue
        query = f'"{name}" {QUERY_SUFFIX}'
        url = google_news_rss(query)
        try:
            hits = parse_rss(fetch_xml(url))
        except Exception as exc:  # noqa: BLE001 — network noise is expected
            print(f"  [{i}/{len(mpps)}] {name}: fail ({exc})", flush=True)
            continue

        kept = 0
        for hit in hits:
            if hit["url"] in seen:
                continue
            seen.add(hit["url"])
            candidates.append(
                {
                    "id": f"candidate-{slug(name)}-{slug(hit['title'])}-{hit.get('date') or 'nd'}",
                    "mppNames": [display_name(mpp), name],
                    "title": hit["title"],
                    "summary": "",
                    "url": hit["url"],
                    "source": hit["source"],
                    "date": hit["date"],
                    "type": "news",
                    "status": "candidate",
                    "note": "Auto-fetched — review before promoting to accountability.json",
                }
            )
            kept += 1
            if kept >= args.per_mpp:
                break
        print(f"  [{i}/{len(mpps)}] {name}: {kept} new", flush=True)

    # Prefer newer dates
    def sort_key(it: dict) -> tuple:
        return (it.get("date") or "", it.get("title") or "")

    candidates.sort(key=sort_key, reverse=True)
    candidates = candidates[: max(1, args.limit)]

    payload = {
        "asOf": datetime.now(timezone.utc).date().isoformat(),
        "note": "Staging only. Copy reviewed items into data/accountability.json for the Watch page.",
        "items": candidates,
    }
    OUT_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(candidates)} candidates → {OUT_PATH}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
