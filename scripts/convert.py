#!/usr/bin/env python3
"""Convert the MPP Excel spreadsheet to JSON for the web showcase."""

import json
import re
import sys
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
XLSX = ROOT / "Current Ontario MPPs & How They Vote..xlsx"
OUTPUT = ROOT / "data" / "mpps.json"
PHOTOS = ROOT / "data" / "photos.json"
OLA_BILL_BASE = "https://www.ola.org/en/legislative-business/bills/parliament-44/session-1"


def slug_from_name(name: str) -> str:
    name = re.sub(r"^(Hon\.|Dr\.)\s*", "", name or "")
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9\s-]", "", slug)
    return re.sub(r"\s+", "-", slug)


def simplify_bill_name(name: str) -> str:
    if name and name.startswith("Bill "):
        parts = name.split(" ")
        return f"{parts[0]} {parts[1]}"
    return name


def normalize_bill_url(raw, bill_header: str) -> str | None:
    if not raw:
        return None
    if isinstance(raw, str) and raw.startswith("http"):
        return raw.split("?")[0]
    # Bill 110 row has title text instead of URL
    m = re.search(r"Bill\s+(\d+)", bill_header or "")
    if m:
        return f"{OLA_BILL_BASE}/bill-{m.group(1)}"
    return None


def vote_display(vote: str) -> dict:
    if vote == "Aye":
        return {"label": "Yes", "yes": True}
    if vote == "Nay":
        return {"label": "No", "yes": False}
    if vote == "No Show":
        return {"label": "No Show", "yes": None}
    return {"label": "N/A", "yes": None}


def load_photos() -> tuple[dict, dict]:
    if not PHOTOS.exists():
        return {}, {}
    data = json.loads(PHOTOS.read_text())
    return data.get("bySlug", {}), data.get("byName", {})


def lookup_photo(name: str, by_slug: dict, by_name: dict) -> tuple[str | None, str | None]:
    slug = slug_from_name(name)
    if slug in by_slug and by_slug[slug].get("photo"):
        info = by_slug[slug]
        return info["photo"], info.get("profileUrl")

    key = re.sub(r"^(Hon\.|Dr\.)\s*", "", name).lower().strip()
    if key in by_name:
        return by_name[key], f"https://www.ola.org/en/members/all/{slug}"

    # Try without middle names: "Teresa J. Armstrong" -> teresa-armstrong
    parts = key.split()
    if len(parts) > 2:
        short_slug = f"{parts[0]}-{parts[-1]}"
        if short_slug in by_slug and by_slug[short_slug].get("photo"):
            info = by_slug[short_slug]
            return info["photo"], info.get("profileUrl")

    return None, f"https://www.ola.org/en/members/all/{slug}"


def main() -> None:
    if not XLSX.exists():
        print(f"Error: {XLSX} not found", file=sys.stderr)
        sys.exit(1)

    by_slug, by_name = load_photos()
    wb = openpyxl.load_workbook(XLSX, data_only=True)

    mpp_info = {}
    for row in wb["Current Ontarios MPPs"].iter_rows(min_row=2, values_only=True):
        if not row[0]:
            continue
        name = row[0].strip()
        mpp_info[name.lower()] = {
            "roles": row[1] or "",
            "party": row[2] or "",
            "riding": row[3] or "",
            "email": row[4] or "",
            "phone": row[5] or "",
            "oacScore": row[6] if row[6] is not None else 0,
        }

    ws = wb["How They Voted"]
    bill_headers = []
    bill_urls: dict[str, str | None] = {}
    for i in range(11, ws.max_column + 1):
        h = ws.cell(2, i).value
        if h:
            bill_headers.append((i, h))
            simple = simplify_bill_name(h)
            raw_url = ws.cell(1, i).value
            url = normalize_bill_url(raw_url, h)
            bill_urls[simple] = url
            bill_urls[h.strip()] = url

    party_votes: dict = {}
    for row in ws.iter_rows(min_row=3, values_only=True):
        if not row[4]:
            continue
        party = row[9]
        if party not in party_votes:
            party_votes[party] = {h: {"Aye": 0, "Nay": 0} for _, h in bill_headers}
        for col_idx, bill_name in bill_headers:
            vote = row[col_idx - 1]
            if vote in ("Aye", "Nay"):
                party_votes[party][bill_name][vote] += 1

    party_majority = {}
    for party, bills in party_votes.items():
        party_majority[party] = {}
        for bill, counts in bills.items():
            party_majority[party][bill] = "Aye" if counts["Aye"] >= counts["Nay"] else "Nay"

    def find_extra(name: str, email: str) -> dict | None:
        for key, info in mpp_info.items():
            if key in name.lower() or name.lower() in key:
                return info
        for info in mpp_info.values():
            if info.get("email") and info["email"].lower() == email.lower():
                return info
        return None

    mpps = []
    for row in ws.iter_rows(min_row=3, values_only=True):
        if not row[4]:
            continue

        name = row[4]
        party = row[9] or ""
        email = row[3] or ""
        extra = find_extra(name, email)
        photo, profile_url = lookup_photo(name, by_slug, by_name)

        votes = []
        aligned = total = 0
        for col_idx, bill_name in bill_headers:
            vote = row[col_idx - 1]
            simple = simplify_bill_name(bill_name)
            if vote in ("Aye", "Nay"):
                total += 1
                majority = party_majority.get(party, {}).get(bill_name)
                if majority and vote == majority:
                    aligned += 1
            vd = vote_display(vote)
            votes.append({
                "bill": simple,
                "billFull": bill_name.strip(),
                "url": bill_urls.get(simple) or bill_urls.get(bill_name.strip()),
                "vote": vote,
                "display": vd["label"],
                "yes": vd["yes"],
            })

        mpps.append({
            "name": name,
            "lastName": row[1] or "",
            "firstName": row[2] or "",
            "email": email,
            "party": party,
            "salary": row[5],
            "benefits": row[6],
            "asOf": row[7],
            "raisePct": row[8],
            "riding": extra["riding"] if extra else "",
            "roles": extra["roles"] if extra else "",
            "phone": extra["phone"] if extra else "",
            "oacScore": extra["oacScore"] if extra else 0,
            "photo": photo,
            "profileUrl": profile_url,
            "votingAlignment": round(aligned / total * 100) if total else None,
            "votes": votes,
        })

    mpps.sort(key=lambda m: m["lastName"].lower())

    # Deduplicated bill list with URLs for UI
    bills_meta = []
    seen = set()
    for _, h in bill_headers:
        simple = simplify_bill_name(h)
        if simple in seen:
            continue
        seen.add(simple)
        bills_meta.append({
            "id": simple,
            "label": h.strip(),
            "url": bill_urls.get(simple),
            "featured": simple in {"Bill 5", "Bill 17", "Bill 24", "Bill 48", "Bill 60", "Bill 68", "Bill 97"},
        })

    OUTPUT.parent.mkdir(exist_ok=True)
    with open(OUTPUT, "w") as f:
        json.dump({
            "featuredBills": ["Bill 5", "Bill 17", "Bill 24", "Bill 48", "Bill 60", "Bill 68", "Bill 97"],
            "bills": bills_meta,
            "mpps": mpps,
        }, f, indent=2)

    with_photo = sum(1 for m in mpps if m.get("photo"))
    with_urls = sum(1 for b in bills_meta if b.get("url"))
    print(f"Wrote {len(mpps)} MPPs ({with_photo} with photos), {with_urls}/{len(bills_meta)} bill URLs")


if __name__ == "__main__":
    main()
