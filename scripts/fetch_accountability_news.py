#!/usr/bin/env python3
"""
Fetch Ontario MPP accountability-related news and publish a deduped feed.

Live site reads data/accountability.json.
Duplicates with the same URL are merged into one item; mppNames are unioned
and the richer title/summary/type wins (prefer more people associated).

Hourly CI: Sync from Google Sheets workflow runs this with --publish.

Usage:
  python3 scripts/fetch_accountability_news.py --publish
  python3 scripts/fetch_accountability_news.py --publish --all
"""

from __future__ import annotations

import argparse
import json
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from difflib import SequenceMatcher
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MPPS_PATH = ROOT / "data" / "mpps.json"
OUT_PATH = ROOT / "data" / "accountability-candidates.json"
CURATED_PATH = ROOT / "data" / "accountability.json"

UA = "OAC-MPP-Tracker/1.0 (accountability-watch; github.com/NomadBuilder/ontario-mpp-tracker)"

ROLE_HINT = re.compile(
    r"\b(minister|premier|associate minister|parliamentary assistant|whip|house leader)\b",
    re.I,
)

# Only auto-publish hits that look like accountability / controversy coverage
SIGNAL = re.compile(
    r"integrity|expense|hotel|resign|scandal|complaint|probe|investigat|"
    r"conflict of interest|hung up|cut short|wildfire|evacuat|hospitality|"
    r"repay|billing|taxpayer|ethics|misconduct|lobby|inquiry|allegation|"
    r"controvers|criticism|fired|oust|improper|audit",
    re.I,
)

TOPIC_QUERIES = [
    'Ontario MPP (hotel OR expenses OR hospitality OR "Integrity Commissioner")',
    'Ontario (minister OR MPP) (resign OR resignation OR scandal OR probe)',
    '"Queen\'s Park" (expenses OR hotel OR integrity OR scandal)',
    "Ontario wildfire (Dunlop OR evacuation OR inquiry OR minister)",
    'Ontario "Integrity Commissioner" MPP',
]

TYPE_RANK = {
    "investigation": 4,
    "integrity": 3,
    "expenses": 2,
    "news": 1,
}


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


def normalize_name(s: str) -> str:
    s = re.sub(r"^hon\.?\s*", "", str(s or "").lower())
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def url_key(url: str) -> str:
    """Canonical key so the same article is not listed twice."""
    u = (url or "").strip()
    if not u:
        return ""
    try:
        p = urllib.parse.urlparse(u)
    except ValueError:
        return u.lower().rstrip("/")
    host = (p.netloc or "").lower().removeprefix("www.")
    path = (p.path or "").rstrip("/")
    # Google News redirect links are unique per fetch — fall back to full URL
    if "news.google.com" in host:
        return u.lower()
    return f"{host}{path}".lower()


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


def infer_type(title: str, summary: str = "") -> str:
    blob = f"{title} {summary}"
    if re.search(r"integrity commissioner|ethics|conflict of interest", blob, re.I):
        return "integrity"
    if re.search(r"hotel|expense|hospitality|billing|repay", blob, re.I):
        return "expenses"
    if re.search(r"inquir|investigat|probe|audit", blob, re.I):
        return "investigation"
    return "news"


def unique_names(names: list[str]) -> list[str]:
    """Collapse aliases; prefer longer forms (Hardeep Singh Grewal > Hardeep Grewal)."""
    by_key: dict[str, str] = {}
    for n in names:
        tokens = normalize_name(n).split()
        if not tokens:
            continue
        key = f"{tokens[0]} {tokens[-1]}" if len(tokens) >= 2 else tokens[0]
        prev = by_key.get(key)
        if not prev or len(tokens) > len(normalize_name(prev).split()):
            by_key[key] = n
    return list(by_key.values())


def people_score(item: dict) -> int:
    return len(unique_names(list(item.get("mppNames") or [])))


def merge_items(a: dict, b: dict) -> dict:
    """Merge same-URL items: union MPPs; prefer the card that already named more people."""
    names = unique_names(list(a.get("mppNames") or []) + list(b.get("mppNames") or []))
    # Prefer the version that listed more people; tie-break on curated/summary length
    a_score = (
        people_score(a),
        1 if a.get("curated") else 0,
        len(a.get("summary") or ""),
        len(a.get("title") or ""),
    )
    b_score = (
        people_score(b),
        1 if b.get("curated") else 0,
        len(b.get("summary") or ""),
        len(b.get("title") or ""),
    )
    primary, secondary = (a, b) if a_score >= b_score else (b, a)

    type_a = a.get("type") or "news"
    type_b = b.get("type") or "news"
    best_type = type_a if TYPE_RANK.get(type_a, 0) >= TYPE_RANK.get(type_b, 0) else type_b

    summary = primary.get("summary") or ""
    if len(secondary.get("summary") or "") > len(summary):
        summary = secondary["summary"]

    title = primary.get("title") or secondary.get("title") or ""

    status_rank = {"under_review": 3, "reported": 2, "resolved": 1, "candidate": 0}
    status_a = a.get("status") or "reported"
    status_b = b.get("status") or "reported"
    best_status = status_a if status_rank.get(status_a, 0) >= status_rank.get(status_b, 0) else status_b
    if best_status == "candidate":
        best_status = "reported"

    curated = bool(a.get("curated") or b.get("curated"))
    date = max(a.get("date") or "", b.get("date") or "")
    source = primary.get("source") or secondary.get("source") or ""
    url = primary.get("url") or secondary.get("url") or ""
    item_id = primary.get("id") or secondary.get("id") or f"merged-{slug(title)}"

    out = {
        "id": item_id,
        "mppNames": names,
        "title": title,
        "summary": summary,
        "url": url,
        "source": source,
        "date": date,
        "type": best_type,
        "status": best_status,
    }
    if curated:
        out["curated"] = True
    return out


def title_key(title: str) -> str:
    t = str(title or "").strip()
    # Google News titles often end with " - Outlet Name"
    if " - " in t:
        t = t.rsplit(" - ", 1)[0]
    t = normalize_name(t)
    return t[:120]


def dedupe_by_url(items: list[dict]) -> list[dict]:
    """Dedupe by article URL, then by normalized headline (Google News links are unique)."""
    buckets: dict[str, dict] = {}
    order: list[str] = []

    def add(key: str, item: dict) -> None:
        item = dict(item)
        item["mppNames"] = unique_names(list(item.get("mppNames") or []))
        if key not in buckets:
            buckets[key] = item
            order.append(key)
        else:
            buckets[key] = merge_items(buckets[key], item)

    for raw in items:
        url = str(raw.get("url") or "").strip()
        if not url:
            continue
        add(f"url:{url_key(url)}", raw)

    # Second pass: merge Google News / thin URLs that share a headline
    by_title: dict[str, list[str]] = {}
    for key in order:
        it = buckets[key]
        tk = title_key(it.get("title") or "")
        if len(tk) < 28:
            continue
        by_title.setdefault(tk, []).append(key)

    drop: set[str] = set()
    for _tk, keys in by_title.items():
        if len(keys) < 2:
            continue
        keys = [k for k in keys if k not in drop]
        if len(keys) < 2:
            continue
        # Prefer non-google URL + more people
        def rank(k: str) -> tuple:
            it = buckets[k]
            host = urllib.parse.urlparse(it.get("url") or "").netloc.lower()
            return (
                0 if "news.google.com" in host else 1,
                people_score(it),
                len(it.get("summary") or ""),
            )

        keys.sort(key=rank, reverse=True)
        keep = keys[0]
        for other in keys[1:]:
            buckets[keep] = merge_items(buckets[keep], buckets[other])
            drop.add(other)

    return [buckets[k] for k in order if k not in drop]


def name_overlap(a: dict, b: dict) -> bool:
    ka = {normalize_name(n).split()[-1] for n in (a.get("mppNames") or []) if normalize_name(n)}
    kb = {normalize_name(n).split()[-1] for n in (b.get("mppNames") or []) if normalize_name(n)}
    return bool(ka & kb)


def fuzzy_merge_similar(items: list[dict], threshold: float = 0.62) -> list[dict]:
    """Merge near-duplicate headlines that share an MPP (different Google News URLs)."""
    items = sorted(items, key=people_score, reverse=True)
    kept: list[dict] = []
    for item in items:
        tk = title_key(item.get("title") or "")
        merged_into = None
        for i, prev in enumerate(kept):
            if not name_overlap(item, prev):
                continue
            pk = title_key(prev.get("title") or "")
            if not tk or not pk:
                continue
            ratio = SequenceMatcher(None, tk, pk).ratio()
            if ratio >= threshold:
                kept[i] = merge_items(prev, item)
                merged_into = i
                break
        if merged_into is None:
            kept.append(item)
    return kept


def match_mpps_in_text(text: str, mpps: list[dict]) -> list[str]:
    blob = normalize_name(text)
    found: list[str] = []
    for m in mpps:
        first = normalize_name(m.get("firstName") or "")
        last = normalize_name(m.get("lastName") or "")
        if not last or len(last) < 3:
            continue
        if first and f"{first} {last}" in blob:
            found.append(display_name(m))
        elif last in blob and first and first[0] in blob:
            # weak: last name only — skip unless first also present
            if first in blob:
                found.append(display_name(m))
    return unique_names(found)


def load_existing() -> list[dict]:
    if not CURATED_PATH.exists():
        return []
    try:
        payload = json.loads(CURATED_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    items = list(payload.get("items") or [])
    for it in items:
        # Preserve hand-edited copy across merges
        if it.get("summary") or it.get("curated"):
            it["curated"] = True
    return items


def fetch_hits_for_query(query: str) -> list[dict]:
    try:
        return parse_rss(fetch_xml(google_news_rss(query)))
    except Exception as exc:  # noqa: BLE001
        print(f"  query fail: {query[:60]}… ({exc})", flush=True)
        return []


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--all", action="store_true", help="Query every MPP (slow)")
    ap.add_argument("--limit", type=int, default=120, help="Max published items to keep")
    ap.add_argument("--per-mpp", type=int, default=3, help="Max signal hits kept per MPP query")
    ap.add_argument(
        "--publish",
        action="store_true",
        help="Merge into data/accountability.json (deduped) for the Watch page",
    )
    ap.add_argument("--sleep", type=float, default=0.35, help="Pause between RSS requests")
    args = ap.parse_args()

    mpps = load_mpps()
    targets = mpps
    if not args.all:
        targets = [
            m
            for m in mpps
            if ROLE_HINT.search(str(m.get("roles") or ""))
            or str(m.get("party") or "").startswith("Progressive")
        ]

    collected: list[dict] = []

    print(f"Topic queries ({len(TOPIC_QUERIES)})…", flush=True)
    for q in TOPIC_QUERIES:
        hits = fetch_hits_for_query(q)
        for hit in hits:
            if not SIGNAL.search(hit["title"]):
                continue
            names = match_mpps_in_text(hit["title"], mpps)
            collected.append(
                {
                    "id": f"auto-{slug(hit['title'])}-{hit.get('date') or 'nd'}",
                    "mppNames": names,
                    "title": hit["title"],
                    "summary": "",
                    "url": hit["url"],
                    "source": hit["source"],
                    "date": hit["date"],
                    "type": infer_type(hit["title"]),
                    "status": "reported",
                }
            )
        print(f"  topic: {len(hits)} raw", flush=True)
        time.sleep(args.sleep)

    print(f"Per-MPP queries ({len(targets)})…", flush=True)
    for i, mpp in enumerate(targets, 1):
        name = search_name(mpp)
        if not name:
            continue
        query = f'"{name}" (Ontario OR "Queen\'s Park" OR MPP)'
        hits = fetch_hits_for_query(query)
        kept = 0
        for hit in hits:
            if not SIGNAL.search(hit["title"]):
                continue
            collected.append(
                {
                    "id": f"auto-{slug(name)}-{slug(hit['title'])}-{hit.get('date') or 'nd'}",
                    "mppNames": [display_name(mpp), name],
                    "title": hit["title"],
                    "summary": "",
                    "url": hit["url"],
                    "source": hit["source"],
                    "date": hit["date"],
                    "type": infer_type(hit["title"]),
                    "status": "reported",
                }
            )
            kept += 1
            if kept >= args.per_mpp:
                break
        if i % 15 == 0 or i == len(targets):
            print(f"  [{i}/{len(targets)}]…", flush=True)
        time.sleep(args.sleep)

    existing = load_existing()
    merged = dedupe_by_url(existing + collected)

    # Enrich mppNames from title when empty / thin
    for it in merged:
        from_title = match_mpps_in_text(f"{it.get('title')} {it.get('summary')}", mpps)
        if from_title:
            it["mppNames"] = unique_names(list(it.get("mppNames") or []) + from_title)

    # Re-dedupe after enrichment
    merged = dedupe_by_url(merged)
    merged = fuzzy_merge_similar(merged)

    # Auto items must name at least one MPP; curated hand-entries always keep
    merged = [
        it
        for it in merged
        if it.get("curated") or people_score(it) >= 1
    ]

    merged.sort(
        key=lambda it: (
            it.get("date") or "",
            people_score(it),
            len(it.get("summary") or ""),
        ),
        reverse=True,
    )
    merged = merged[: max(1, args.limit)]

    as_of = datetime.now(timezone.utc).date().isoformat()
    note = (
        "Deduped by article URL — one card per story, with all associated MPPs merged. "
        "Auto-refreshed from Google News RSS (accountability-signal filter). "
        "Hand-written summaries marked curated are preserved on merge."
    )

    if args.publish:
        payload = {"asOf": as_of, "note": note, "items": merged}
        CURATED_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"Published {len(merged)} items → {CURATED_PATH}", flush=True)
    else:
        staging = [it for it in merged if not it.get("curated")]
        OUT_PATH.write_text(
            json.dumps({"asOf": as_of, "note": "Staging", "items": staging}, indent=2, ensure_ascii=False)
            + "\n",
            encoding="utf-8",
        )
        print(f"Wrote {len(staging)} candidates → {OUT_PATH} (pass --publish to update watch feed)", flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
