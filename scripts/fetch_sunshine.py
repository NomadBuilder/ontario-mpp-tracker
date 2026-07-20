#!/usr/bin/env python3
"""Fetch Ontario Public Sector Salary Disclosure (Sunshine List) for MPPs.

Downloads the official Legislative Assembly rows from ontario.ca, matches them
to current MPPs, computes YoY raise %, and writes data/sunshine.json for convert.py.

Source: https://www.ontario.ca/page/public-sector-salary-disclosure
"""

from __future__ import annotations

import csv
import io
import json
import re
import ssl
import sys
import unicodedata
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "data" / "sunshine.json"
MPPS_JSON = ROOT / "data" / "mpps.json"
XLSX = ROOT / "Current Ontario MPPs & How They Vote..xlsx"
MANIFEST_URL = "https://www.ontario.ca/public-sector-salary-disclosure_artifacts/pssdfiles.json"
BASE = "https://www.ontario.ca"
EMPLOYER = "Legislative Assembly"

# Sheet / OLA display name → Sunshine List (Last, First)
# Legal / preferred-name mismatches that simple nickname maps miss.
NAME_OVERRIDES: dict[str, tuple[str, str]] = {
    "andrew dowie": ("Dowie", "Michael"),
    "robert bailey": ("Bailey", "Bob"),
    "ted hsu": ("Hsu", "Theodore"),
    "natalia kusendova-bashta": ("Kusendova", "Natalia"),
    "dawn gallagher murphy": ("Gallagher Murphy", "Dawn"),
    "steve pinsonneault": ("Pinsonneault", "Stephen"),
    "bill rosenberg": ("Rosenberg", "William"),
    "chris scott": ("Van Scott", "Chris"),
    "jennifer (jennie) stevens": ("Stevens", "Jennie"),
    "jennifer stevens": ("Stevens", "Jennie"),
    "jennie stevens": ("Stevens", "Jennie"),
    "ric bresee": ("Bresee", "Richard"),
    "jess dixon": ("Dixon", "Jessica"),
    "zee hamid": ("Hamid", "Zeeshan"),
    "sol mamakwa": ("Mamakwa", "Solomon"),
}

# Mutual first-name aliases for fuzzy matching
FIRST_ALIASES: dict[str, set[str]] = {
    "bob": {"robert", "rob"},
    "robert": {"bob", "rob"},
    "rob": {"robert", "bob"},
    "bill": {"william", "will"},
    "william": {"bill", "will"},
    "will": {"william", "bill"},
    "ted": {"theodore"},
    "theodore": {"ted"},
    "steve": {"stephen"},
    "stephen": {"steve"},
    "jennie": {"jennifer"},
    "jennifer": {"jennie"},
    "jess": {"jessica"},
    "jessica": {"jess"},
    "ric": {"richard", "rick"},
    "rick": {"richard", "ric"},
    "richard": {"ric", "rick"},
    "zee": {"zeeshan"},
    "zeeshan": {"zee"},
    "sol": {"solomon"},
    "solomon": {"sol"},
    "chris": {"christopher"},
    "christopher": {"chris"},
    "mike": {"michael"},
    "michael": {"mike", "andrew"},  # Andrew Dowie listed as Michael
    "andrew": {"michael", "andy"},
}


def fetch_bytes(url: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "OAC-MPP-Tracker/1.0 (github.com/NomadBuilder/ontario-mpp-tracker)"},
    )
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, context=ctx, timeout=120) as resp:
        return resp.read()


def fetch_text(url: str) -> str:
    return fetch_bytes(url).decode("utf-8-sig", errors="replace")


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"^hon\.?\s*", "", s)
    s = re.sub(r"[^a-z0-9\s-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def money(raw) -> float:
    s = str(raw or "").replace(",", "").replace("$", "").strip()
    if not s:
        return 0.0
    return float(s)


def title_en(job_title: str) -> str:
    """Keep English portion before bilingual ' / ' separator."""
    t = (job_title or "").strip()
    if " / " in t:
        return t.split(" / ", 1)[0].strip()
    return t


def first_tokens(first: str) -> list[str]:
    return [t for t in norm(first).replace("-", " ").split() if t]


def firsts_compatible(a: str, b: str) -> bool:
    ta, tb = first_tokens(a), first_tokens(b)
    if not ta or not tb:
        return False
    if ta[0] == tb[0]:
        return True
    if ta[0] in FIRST_ALIASES.get(tb[0], set()):
        return True
    if tb[0] in FIRST_ALIASES.get(ta[0], set()):
        return True
    # "Dawn Gallagher" vs "Dawn"
    if ta[0] == tb[0] or (len(ta) > 1 and ta[0] == tb[0]):
        return True
    return False


def load_mpp_roster() -> list[dict]:
    """Prefer live spreadsheet; fall back to mpps.json."""
    roster: list[dict] = []
    if XLSX.exists():
        try:
            import openpyxl

            wb = openpyxl.load_workbook(XLSX, data_only=True)
            ws = wb["How They Voted"]
            for row in ws.iter_rows(min_row=5, max_col=10, values_only=True):
                if not row or not row[4]:
                    continue
                name = str(row[4]).strip()
                if name.lower() in {"name", "mpp name"}:
                    continue
                roster.append({
                    "name": name,
                    "lastName": str(row[1] or "").strip(),
                    "firstName": str(row[2] or "").strip(),
                    "sheetSalary": float(row[5]) if row[5] is not None else None,
                    "sheetBenefits": float(row[6]) if row[6] is not None else None,
                    "sheetAsOf": row[7],
                    "sheetRaisePct": float(row[8]) if row[8] is not None else None,
                })
            if roster:
                return roster
        except Exception as e:
            print(f"Spreadsheet roster failed ({e}); using mpps.json", file=sys.stderr)

    if MPPS_JSON.exists():
        data = json.loads(MPPS_JSON.read_text())
        for m in data.get("mpps", []):
            roster.append({
                "name": m["name"],
                "lastName": m.get("lastName") or "",
                "firstName": m.get("firstName") or "",
                "sheetSalary": m.get("salary"),
                "sheetBenefits": m.get("benefits"),
                "sheetAsOf": m.get("asOf"),
                "sheetRaisePct": m.get("raisePct"),
            })
    return roster


def csv_url_for_year(manifest: dict, year: str) -> str:
    path = manifest[year]["Compendium"]["en"]["csv"]
    if path.startswith("http"):
        return path
    return BASE + path


def load_la_rows(csv_text: str) -> list[dict]:
    rows: list[dict] = []
    reader = csv.DictReader(io.StringIO(csv_text))
    for row in reader:
        if (row.get("Employer") or "").strip() != EMPLOYER:
            continue
        rows.append({
            "lastName": (row.get("Last Name") or "").strip(),
            "firstName": (row.get("First Name") or "").strip(),
            "salary": money(row.get("Salary")),
            "benefits": money(row.get("Benefits")),
            "jobTitle": title_en(row.get("Job Title") or ""),
            "jobTitleFull": (row.get("Job Title") or "").strip(),
            "year": int(row["Year"]) if row.get("Year") else None,
            "sector": (row.get("Sector") or "").strip(),
        })
    return rows


def index_rows(rows: list[dict]) -> dict[tuple[str, str], dict]:
    """Index by (norm last, norm first) keeping highest salary on collision."""
    idx: dict[tuple[str, str], dict] = {}
    for r in rows:
        keys = [
            (norm(r["lastName"]), norm(r["firstName"])),
            (norm(r["lastName"]), first_tokens(r["firstName"])[0] if first_tokens(r["firstName"]) else ""),
        ]
        for k in keys:
            if not k[0] or not k[1]:
                continue
            prev = idx.get(k)
            if not prev or r["salary"] > prev["salary"]:
                idx[k] = r
    return idx


def find_row(last: str, first: str, rows: list[dict], idx: dict) -> dict | None:
    k1 = (norm(last), norm(first))
    if k1 in idx:
        return idx[k1]
    toks = first_tokens(first)
    if toks:
        k2 = (norm(last), toks[0])
        if k2 in idx:
            return idx[k2]

    last_n = norm(last)
    # Compound / hyphenated last-name variants
    cands = [r for r in rows if norm(r["lastName"]) == last_n]
    if not cands and "-" in last:
        base = last.split("-")[0]
        cands = [r for r in rows if norm(r["lastName"]) == norm(base)]
    if not cands:
        # last name might be "Gallagher Murphy" when sheet has Murphy
        cands = [r for r in rows if last_n in norm(r["lastName"]) or norm(r["lastName"]) in last_n]

    for r in cands:
        if firsts_compatible(first, r["firstName"]):
            return r
    return None


def match_mpp(mpp: dict, rows: list[dict], idx: dict) -> dict | None:
    key = norm(re.sub(r"^(Hon\.|Dr\.)\s*", "", mpp["name"]))
    if key in NAME_OVERRIDES:
        last, first = NAME_OVERRIDES[key]
        return find_row(last, first, rows, idx)
    return find_row(mpp["lastName"], mpp["firstName"], rows, idx)


def raise_pct(current: float | None, previous: float | None) -> float | None:
    if not current or not previous or previous <= 0:
        return None
    # Store as fraction (0.29 ≈ 29%) to match the Google Sheet convention
    return round((current - previous) / previous, 4)


def sheet_raise_as_fraction(raw) -> float | None:
    if raw is None:
        return None
    v = float(raw)
    # Sheet uses 0.29 for 29%; tolerate accidental whole-number percents
    if v > 2:
        return round(v / 100.0, 4)
    return round(v, 4)


def main() -> int:
    print("Loading PSSD file manifest…", flush=True)
    manifest = json.loads(fetch_text(MANIFEST_URL))
    years = sorted(y for y in manifest if y.isdigit())
    if not years:
        print("No years in PSSD manifest", file=sys.stderr)
        return 1
    year = years[-1]
    prev_year = years[-2] if len(years) > 1 else None
    print(f"Using years {year}" + (f" and {prev_year}" if prev_year else ""), flush=True)

    url = csv_url_for_year(manifest, year)
    print(f"Downloading {year} Compendium CSV…", flush=True)
    rows = load_la_rows(fetch_text(url))
    print(f"  Legislative Assembly rows: {len(rows)}", flush=True)

    prev_rows: list[dict] = []
    prev_idx: dict = {}
    if prev_year:
        print(f"Downloading {prev_year} Compendium CSV…", flush=True)
        prev_rows = load_la_rows(fetch_text(csv_url_for_year(manifest, prev_year)))
        prev_idx = index_rows(prev_rows)
        print(f"  Legislative Assembly rows: {len(prev_rows)}", flush=True)

    idx = index_rows(rows)
    roster = load_mpp_roster()
    print(f"Matching {len(roster)} MPPs…", flush=True)

    by_slug: dict[str, dict] = {}
    by_name: dict[str, str] = {}
    matches: list[dict] = []
    unmatched: list[str] = []
    discrepancies: list[dict] = []

    for mpp in roster:
        rec = match_mpp(mpp, rows, idx)
        display = re.sub(r"^(Hon\.|Dr\.)\s*", "", mpp["name"]).strip()
        slug = re.sub(r"[^a-z0-9\s-]", "", display.lower())
        slug = re.sub(r"\s+", "-", slug.strip())

        if not rec:
            unmatched.append(mpp["name"])
            continue

        prev = find_row(rec["lastName"], rec["firstName"], prev_rows, prev_idx) if prev_rows else None
        raise_f = raise_pct(rec["salary"], prev["salary"] if prev else None)

        entry = {
            "lastName": rec["lastName"],
            "firstName": rec["firstName"],
            "salary": round(rec["salary"], 2),
            "benefits": round(rec["benefits"], 2),
            "jobTitle": rec["jobTitle"],
            "year": rec["year"] or int(year),
            "priorSalary": round(prev["salary"], 2) if prev else None,
            "priorYear": prev["year"] if prev else None,
            "raisePct": raise_f,
            "employer": EMPLOYER,
            "source": f"{BASE}/public-sector-salary-disclosure/{year}/all-sectors-and-seconded-employees/",
        }
        by_slug[slug] = entry
        by_name[display.lower()] = slug
        by_name[norm(display)] = slug

        sheet_s = mpp.get("sheetSalary")
        sheet_b = mpp.get("sheetBenefits")
        sheet_r = sheet_raise_as_fraction(mpp.get("sheetRaisePct"))

        sal_delta = None if sheet_s is None else round(float(sheet_s) - entry["salary"], 2)
        ben_delta = None if sheet_b is None else round(float(sheet_b) - entry["benefits"], 2)
        raise_delta = None
        if sheet_r is not None and raise_f is not None:
            raise_delta = round(sheet_r - raise_f, 4)

        match_info = {
            "name": mpp["name"],
            "slug": slug,
            "sheetSalary": sheet_s,
            "pssdSalary": entry["salary"],
            "salaryDelta": sal_delta,
            "sheetBenefits": sheet_b,
            "pssdBenefits": entry["benefits"],
            "benefitsDelta": ben_delta,
            "sheetRaisePct": sheet_r,
            "pssdRaisePct": raise_f,
            "raiseDelta": raise_delta,
            "jobTitle": entry["jobTitle"],
        }
        matches.append(match_info)

        flags = []
        if sheet_s is None:
            flags.append("missing_sheet_salary")
        elif abs(sal_delta or 0) > 1:
            flags.append("salary_mismatch")
        if sheet_b is None and entry["benefits"]:
            flags.append("missing_sheet_benefits")
        elif sheet_b is not None and abs(ben_delta or 0) > 1:
            flags.append("benefits_mismatch")
        if raise_delta is not None and abs(raise_delta) > 0.005:  # > 0.5 percentage points
            flags.append("raise_mismatch")
        if flags:
            match_info["flags"] = flags
            discrepancies.append(match_info)

    payload = {
        "fetchedAt": date.today().isoformat(),
        "year": int(year),
        "priorYear": int(prev_year) if prev_year else None,
        "employer": EMPLOYER,
        "source": f"{BASE}/page/public-sector-salary-disclosure",
        "matched": len(matches),
        "unmatched": unmatched,
        "discrepancies": discrepancies,
        "bySlug": by_slug,
        "byName": by_name,
    }
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, indent=2))

    print(f"Matched {len(matches)}/{len(roster)} MPPs → {OUTPUT}")
    if unmatched:
        print(f"Unmatched ({len(unmatched)}): {', '.join(unmatched)}")
    if discrepancies:
        print(f"Discrepancies ({len(discrepancies)}):")
        for d in discrepancies:
            bits = []
            if d.get("salaryDelta") is not None and abs(d["salaryDelta"]) > 1:
                bits.append(f"salary sheet={d['sheetSalary']} pssd={d['pssdSalary']} Δ={d['salaryDelta']}")
            if d.get("benefitsDelta") is not None and abs(d["benefitsDelta"]) > 1:
                bits.append(f"benefits sheet={d['sheetBenefits']} pssd={d['pssdBenefits']} Δ={d['benefitsDelta']}")
            if "missing_sheet_salary" in d.get("flags", []):
                bits.append(f"sheet salary missing; pssd={d['pssdSalary']}")
            if d.get("raiseDelta") is not None and abs(d["raiseDelta"]) > 0.005:
                bits.append(f"raise sheet={d['sheetRaisePct']} pssd={d['pssdRaisePct']}")
            print(f"  • {d['name']}: {'; '.join(bits) or d.get('flags')}")
    else:
        print("No material salary/benefits/raise discrepancies (>$1 or >0.5pp).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
