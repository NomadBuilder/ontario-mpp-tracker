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
FEATURED = {"Bill 5", "Bill 17", "Bill 24", "Bill 48", "Bill 60", "Bill 68", "Bill 97"}

# Site display toggles — overridden by a "Display Settings" sheet tab when present.
# Yes/No (or true/false/1/0/show/hide) in column B. Unknown fields are ignored.
DEFAULT_DISPLAY = {
    "salary": False,
    "benefits": False,
    "votingAlignment": False,
}

DISPLAY_ALIASES = {
    "salary": "salary",
    "benefits": "benefits",
    "benefit": "benefits",
    "votingalignment": "votingAlignment",
    "voting alignment": "votingAlignment",
    "alignment": "votingAlignment",
    "party alignment": "votingAlignment",
}


def get_xlsx_path() -> Path:
    import argparse
    parser = argparse.ArgumentParser(description="Convert MPP spreadsheet to JSON")
    parser.add_argument(
        "--xlsx",
        type=Path,
        default=None,
        help="Path to Excel file (default: project root spreadsheet)",
    )
    args, _ = parser.parse_known_args()
    return args.xlsx if args.xlsx else XLSX


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


def vote_display(vote) -> dict:
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

    parts = key.split()
    if len(parts) > 2:
        short_slug = f"{parts[0]}-{parts[-1]}"
        if short_slug in by_slug and by_slug[short_slug].get("photo"):
            info = by_slug[short_slug]
            return info["photo"], info.get("profileUrl")

    return None, f"https://www.ola.org/en/members/all/{slug}"


def parse_show_value(raw) -> bool | None:
    if raw is None:
        return None
    if isinstance(raw, bool):
        return raw
    s = str(raw).strip().lower()
    if s in {"yes", "y", "true", "1", "show", "on"}:
        return True
    if s in {"no", "n", "false", "0", "hide", "off"}:
        return False
    return None


def load_display_settings(wb) -> dict:
    """Read optional 'Display Settings' tab: Field | Show (Yes/No)."""
    display = dict(DEFAULT_DISPLAY)
    sheet_name = next(
        (n for n in wb.sheetnames if n.strip().lower() in {"display settings", "display", "site settings"}),
        None,
    )
    if not sheet_name:
        print("No Display Settings tab — using defaults:", display)
        return display

    ws = wb[sheet_name]
    for row in ws.iter_rows(min_row=1, max_col=2, values_only=True):
        if not row or not row[0]:
            continue
        field_raw = str(row[0]).strip()
        key_norm = re.sub(r"\s+", " ", field_raw).lower()
        if key_norm in {"field", "setting", "name", "column"}:
            continue
        key = DISPLAY_ALIASES.get(key_norm) or DISPLAY_ALIASES.get(key_norm.replace(" ", ""))
        if not key:
            continue
        show = parse_show_value(row[1] if len(row) > 1 else None)
        if show is not None:
            display[key] = show

    print(f"Display Settings ({sheet_name}): {display}")
    return display


def find_header_row(ws) -> int:
    """Locate the row that starts with 'MPP Name' (handles inserted date rows)."""
    for r in range(1, 20):
        val = ws.cell(r, 1).value
        if val and "MPP" in str(val) and "Name" in str(val):
            return r
    raise ValueError("Could not find header row in 'How They Voted' sheet")


def find_bill_start_col(ws, header_row: int) -> int:
    """First column after Party that looks like a bill/vote header."""
    for c in range(1, ws.max_column + 1):
        h = ws.cell(header_row, c).value
        if not h:
            continue
        s = str(h).strip()
        if s.startswith("Bill ") or "Surveillance" in s or "Pricing" in s:
            return c
    return 11


def main() -> None:
    xlsx_path = get_xlsx_path()
    if not xlsx_path.exists():
        print(f"Error: {xlsx_path} not found", file=sys.stderr)
        sys.exit(1)

    by_slug, by_name = load_photos()
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    display = load_display_settings(wb)

    # Optional contact/roles sheet
    mpp_info = {}
    if "Current Ontarios MPPs" in wb.sheetnames:
        contact = wb["Current Ontarios MPPs"]
        headers = {
            (contact.cell(1, c).value or "").strip().lower(): c
            for c in range(1, contact.max_column + 1)
            if contact.cell(1, c).value
        }
        name_c = headers.get("mpp name", 1)
        roles_c = headers.get("roles")
        party_c = headers.get("party")
        riding_c = headers.get("riding")
        email_c = headers.get("email")
        phone_c = headers.get("constituency office number")
        score_c = headers.get("oac score")

        for row in contact.iter_rows(min_row=2, values_only=False):
            name_cell = row[name_c - 1].value
            if not name_cell:
                continue
            name = str(name_cell).strip()

            def cell(col):
                return row[col - 1].value if col else None

            mpp_info[name.lower()] = {
                "roles": (cell(roles_c) or "") if roles_c else "",
                "party": (cell(party_c) or "") if party_c else "",
                "riding": (cell(riding_c) or "") if riding_c else "",
                "email": (cell(email_c) or "") if email_c else "",
                "phone": (cell(phone_c) or "") if phone_c else "",
                "oacScore": cell(score_c) if score_c is not None and cell(score_c) is not None else 0,
            }

    ws = wb["How They Voted"]
    header_row = find_header_row(ws)
    bill_start = find_bill_start_col(ws, header_row)
    print(f"Header row: {header_row}, bill columns start at: {bill_start}")

    bill_headers = []
    bill_urls: dict[str, str | None] = {}
    for i in range(bill_start, ws.max_column + 1):
        h = ws.cell(header_row, i).value
        if not h or not str(h).strip():
            continue
        h = str(h).strip()
        # Skip non-bill helper columns
        if h.lower() in {"party", "url", "third reading vote", "first reading"}:
            continue
        bill_headers.append((i, h))
        simple = simplify_bill_name(h)
        raw_url = ws.cell(1, i).value
        url = normalize_bill_url(raw_url, h)
        bill_urls[simple] = url
        bill_urls[h] = url

    print(f"Bills found ({len(bill_headers)}): {[h for _, h in bill_headers]}")

    data_start = header_row + 1

    party_votes: dict = {}
    for row in ws.iter_rows(min_row=data_start, values_only=True):
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
            if info.get("email") and email and info["email"].lower() == email.lower():
                return info
        return None

    mpps = []
    skipped = 0
    for row in ws.iter_rows(min_row=data_start, values_only=True):
        if not row[4]:
            skipped += 1
            continue

        name = str(row[4]).strip()
        # Skip accidental header/date leftovers
        if name.lower() in {"name", "mpp name"} or not row[1]:
            skipped += 1
            continue

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
            "phone": (str(extra["phone"]).strip() if extra and extra["phone"] else ""),
            "oacScore": extra["oacScore"] if extra else 0,
            "photo": photo,
            "profileUrl": profile_url,
            "votingAlignment": round(aligned / total * 100) if total else None,
            "votes": votes,
        })

    mpps.sort(key=lambda m: str(m["lastName"]).lower())

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
            "featured": simple in FEATURED,
        })

    OUTPUT.parent.mkdir(exist_ok=True)
    with open(OUTPUT, "w") as f:
        json.dump({
            "display": display,
            "featuredBills": sorted(FEATURED, key=lambda x: int(x.split()[1]) if x.startswith("Bill ") else 999),
            "bills": bills_meta,
            "mpps": mpps,
        }, f, indent=2)

    with_photo = sum(1 for m in mpps if m.get("photo"))
    with_riding = sum(1 for m in mpps if m.get("riding"))
    with_urls = sum(1 for b in bills_meta if b.get("url"))
    parties = {}
    for m in mpps:
        parties[m["party"] or "?"] = parties.get(m["party"] or "?", 0) + 1

    print(f"Wrote {len(mpps)} MPPs ({with_photo} photos, {with_riding} with riding)")
    print(f"Bill URLs: {with_urls}/{len(bills_meta)}")
    print(f"Parties: {parties}")
    print(f"Skipped empty/invalid rows: {skipped}")

    # Sanity: Tyler Allsopp
    tyler = next((m for m in mpps if "Allsopp" in m["name"]), None)
    if tyler:
        print(f"Sample Tyler Allsopp: salary={tyler['salary']} riding={tyler['riding']!r} "
              f"photo={'yes' if tyler['photo'] else 'no'} votes={len(tyler['votes'])} "
              f"align={tyler['votingAlignment']}%")


if __name__ == "__main__":
    main()
