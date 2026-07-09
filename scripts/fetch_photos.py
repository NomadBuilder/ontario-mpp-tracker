#!/usr/bin/env python3
"""Fetch MPP profile photo URLs from the Legislative Assembly of Ontario."""

import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "data" / "photos.json"
MEMBERS_URL = "https://www.ola.org/en/members/current"
BASE = "https://www.ola.org"


def slug_from_name(name: str) -> str:
    name = re.sub(r"^(Hon\.|Dr\.)\s*", "", name or "")
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9\s-]", "", slug)
    return re.sub(r"\s+", "-", slug)


def fetch_html(url: str) -> str | None:
    req = urllib.request.Request(url, headers={"User-Agent": "OAC-MPP-Tracker/1.0"})
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError:
        return None


def parse_member_slugs(html: str) -> list[str]:
    return sorted(set(re.findall(r"/en/members/all/([a-z0-9-]+)", html)))


def parse_member_page(html: str, slug: str) -> dict:
    photo = None
    m = re.search(r"/sites/default/files/member/profile-photo/([^\"']+)", html)
    if m:
        photo = f"{BASE}/sites/default/files/member/profile-photo/{m.group(1)}"

    title = None
    t = re.search(r"<h1[^>]*>([^<]+)</h1>", html)
    if t:
        title = re.sub(r"\s+", " ", t.group(1)).strip()

    return {
        "slug": slug,
        "name": title,
        "photo": photo,
        "profileUrl": f"{BASE}/en/members/all/{slug}",
    }


def main() -> None:
    print("Fetching member list from OLA…")
    listing = fetch_html(MEMBERS_URL)
    if not listing:
        print("Failed to fetch member listing", file=sys.stderr)
        sys.exit(1)

    slugs = parse_member_slugs(listing)
    print(f"Found {len(slugs)} member pages")

    by_slug: dict[str, dict] = {}
    by_name: dict[str, str] = {}

    for i, slug in enumerate(slugs, 1):
        html = fetch_html(f"{BASE}/en/members/all/{slug}")
        if not html:
            print(f"  skip {slug} (no page)")
            continue
        info = parse_member_page(html, slug)
        by_slug[slug] = info
        if info.get("name") and info.get("photo"):
            by_name[info["name"].lower()] = info["photo"]
        if i % 20 == 0:
            print(f"  …{i}/{len(slugs)}")
        time.sleep(0.15)

    OUTPUT.parent.mkdir(exist_ok=True)
    with open(OUTPUT, "w") as f:
        json.dump({"bySlug": by_slug, "byName": by_name}, f, indent=2)

    with_photo = sum(1 for v in by_slug.values() if v.get("photo"))
    print(f"Wrote {with_photo}/{len(by_slug)} photos to {OUTPUT}")


if __name__ == "__main__":
    main()
