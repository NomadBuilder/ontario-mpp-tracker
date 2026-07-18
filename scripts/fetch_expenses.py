#!/usr/bin/env python3
"""Fetch MPP expense disclosure totals from the Legislative Assembly of Ontario.

Source: https://www.ola.org/en/members/expense-disclosure/list
Per-member pages include an HTML table of claims (travel, accommodation,
meals, hospitality) for the past ~2 years. CSV downloads are not publicly
fetchable without session cookies, so we parse the HTML tables.
"""

from __future__ import annotations

import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import date
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "data" / "expenses.json"
LIST_URL = "https://www.ola.org/en/members/expense-disclosure/list"
BASE = "https://www.ola.org"


def fetch_html(url: str) -> str | None:
    req = urllib.request.Request(url, headers={"User-Agent": "OAC-MPP-Tracker/1.0"})
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
        return None


def parse_list_slugs(html: str) -> list[tuple[str, str]]:
    """Return [(slug, display_name), ...] from the expense disclosure list."""
    found: list[tuple[str, str]] = []
    seen: set[str] = set()
    for m in re.finditer(
        r'href="/en/members/expense-disclosure/([a-z0-9-]+)"[^>]*>([^<]+)</a>',
        html,
        re.I,
    ):
        slug, name = m.group(1), re.sub(r"\s+", " ", m.group(2)).strip()
        if slug in {"list", "faq", "expense-rules"} or slug in seen:
            continue
        seen.add(slug)
        found.append((slug, name))
    return found


def parse_money(raw: str) -> float:
    s = (raw or "").strip().replace(",", "").replace("$", "")
    if not s or s in {"-", "–", "—"}:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


class ExpenseTableParser(HTMLParser):
    """Extract rows from #memberExpenseData (or first expense table)."""

    def __init__(self) -> None:
        super().__init__()
        self.in_table = False
        self.in_row = False
        self.in_cell = False
        self.skip_header = False
        self.current: list[str] = []
        self.cell_parts: list[str] = []
        self.rows: list[list[str]] = []
        self.table_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_d = dict(attrs)
        if tag == "table":
            tid = attrs_d.get("id") or ""
            cls = attrs_d.get("class") or ""
            if tid == "memberExpenseData" or "expenseMpp" in cls or (
                not self.in_table and "expense" in cls.lower()
            ):
                self.in_table = True
                self.table_depth = 1
                self.skip_header = True
            elif self.in_table:
                self.table_depth += 1
        elif self.in_table and tag == "tr":
            self.in_row = True
            self.current = []
        elif self.in_table and self.in_row and tag in {"td", "th"}:
            self.in_cell = True
            self.cell_parts = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "table" and self.in_table:
            self.table_depth -= 1
            if self.table_depth <= 0:
                self.in_table = False
        elif self.in_table and tag == "tr" and self.in_row:
            self.in_row = False
            if self.skip_header:
                self.skip_header = False
            elif self.current:
                self.rows.append(self.current)
        elif self.in_table and self.in_cell and tag in {"td", "th"}:
            self.in_cell = False
            self.current.append(re.sub(r"\s+", " ", "".join(self.cell_parts)).strip())

    def handle_data(self, data: str) -> None:
        if self.in_cell:
            self.cell_parts.append(data)


def summarize_rows(rows: list[list[str]]) -> dict | None:
    travel = accommodation = meals = hospitality = total = 0.0
    claims = 0
    periods: set[str] = set()

    for row in rows:
        if len(row) < 10:
            continue
        # Empty placeholder rows use "-" across numeric columns
        nums = [parse_money(row[i]) for i in (3, 4, 5, 6, 9)]
        if all(n == 0 for n in nums) and all(
            (row[i] or "").strip() in {"", "-", "–", "—"} for i in (3, 4, 5, 6, 9)
        ):
            continue

        t, a, m, h, tot = nums
        # Prefer explicit total; otherwise sum categories
        row_total = tot if tot else (t + a + m + h)
        if row_total == 0 and not any((row[i] or "").strip() not in {"", "-", "–", "—"} for i in (3, 4, 5, 6, 9)):
            continue

        travel += t
        accommodation += a
        meals += m
        hospitality += h
        total += row_total
        claims += 1
        if row[0] and row[0] not in {"-", "–", "—"}:
            periods.add(row[0])

    if claims == 0 and total == 0:
        return {
            "total": 0.0,
            "travel": 0.0,
            "accommodation": 0.0,
            "meals": 0.0,
            "hospitality": 0.0,
            "claimCount": 0,
            "periodCount": 0,
        }

    return {
        "total": round(total, 2),
        "travel": round(travel, 2),
        "accommodation": round(accommodation, 2),
        "meals": round(meals, 2),
        "hospitality": round(hospitality, 2),
        "claimCount": claims,
        "periodCount": len(periods),
    }


def name_keys(display_name: str, slug: str) -> list[str]:
    """Keys for joining to sheet names (lowercased)."""
    keys: list[str] = []
    raw = re.sub(r"\s+", " ", (display_name or "").strip())
    if raw:
        keys.append(raw.lower())
        # "Last, First" → "First Last"
        if "," in raw:
            last, first = [p.strip() for p in raw.split(",", 1)]
            keys.append(f"{first} {last}".lower())
            keys.append(f"hon. {first} {last}".lower())
    keys.append(slug.replace("-", " "))
    # de-dupe preserve order
    out: list[str] = []
    seen: set[str] = set()
    for k in keys:
        k = re.sub(r"\s+", " ", k).strip()
        if k and k not in seen:
            seen.add(k)
            out.append(k)
    return out


def parse_member_page(html: str, slug: str, list_name: str) -> dict:
    parser = ExpenseTableParser()
    parser.feed(html)
    summary = summarize_rows(parser.rows) or {
        "total": 0.0,
        "travel": 0.0,
        "accommodation": 0.0,
        "meals": 0.0,
        "hospitality": 0.0,
        "claimCount": 0,
        "periodCount": 0,
    }

    riding = None
    m = re.search(
        r'views-field-field-riding-name[^>]*>[\s\S]*?<p>([^<]+)</p>',
        html,
        re.I,
    )
    if m:
        riding = re.sub(r"\s+", " ", m.group(1)).strip() or None

    source = f"{BASE}/en/members/expense-disclosure/{slug}"
    return {
        "slug": slug,
        "name": list_name,
        "riding": riding,
        "sourceUrl": source,
        **summary,
    }


def main() -> None:
    print("Fetching expense disclosure list from OLA…")
    listing = fetch_html(LIST_URL)
    if not listing:
        print("Failed to fetch expense list", file=sys.stderr)
        sys.exit(1)

    members = parse_list_slugs(listing)
    print(f"Found {len(members)} members with expense pages")

    by_slug: dict[str, dict] = {}
    by_name: dict[str, str] = {}

    for i, (slug, name) in enumerate(members, 1):
        html = fetch_html(f"{BASE}/en/members/expense-disclosure/{slug}")
        if not html:
            print(f"  skip {slug} (no page)")
            continue
        info = parse_member_page(html, slug, name)
        by_slug[slug] = info
        for key in name_keys(name, slug):
            by_name[key] = slug
        if i % 20 == 0:
            print(f"  …{i}/{len(members)}")
        time.sleep(0.12)

    OUTPUT.parent.mkdir(exist_ok=True)
    payload = {
        "fetchedAt": date.today().isoformat(),
        "source": LIST_URL,
        "bySlug": by_slug,
        "byName": by_name,
    }
    with open(OUTPUT, "w") as f:
        json.dump(payload, f, indent=2)

    with_claims = sum(1 for v in by_slug.values() if v.get("claimCount", 0) > 0)
    print(f"Wrote {with_claims}/{len(by_slug)} members with claims to {OUTPUT}")


if __name__ == "__main__":
    main()
