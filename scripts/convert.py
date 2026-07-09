#!/usr/bin/env python3
"""Convert the MPP Excel spreadsheet to JSON for the web showcase."""

import json
import sys
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
XLSX = ROOT / "Current Ontario MPPs & How They Vote..xlsx"
OUTPUT = ROOT / "data" / "mpps.json"


def simplify_bill_name(name: str) -> str:
    if name and name.startswith("Bill "):
        parts = name.split(" ")
        return f"{parts[0]} {parts[1]}"
    return name


def vote_display(vote: str) -> dict:
    if vote == "Aye":
        return {"label": "Yes", "yes": True}
    if vote == "Nay":
        return {"label": "No", "yes": False}
    if vote == "No Show":
        return {"label": "No Show", "yes": None}
    return {"label": "N/A", "yes": None}


def main() -> None:
    if not XLSX.exists():
        print(f"Error: {XLSX} not found", file=sys.stderr)
        sys.exit(1)

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
    for i in range(11, ws.max_column + 1):
        h = ws.cell(2, i).value
        if h:
            bill_headers.append((i, h))

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

        votes = []
        aligned = total = 0
        for col_idx, bill_name in bill_headers:
            vote = row[col_idx - 1]
            if vote in ("Aye", "Nay"):
                total += 1
                majority = party_majority.get(party, {}).get(bill_name)
                if majority and vote == majority:
                    aligned += 1
            vd = vote_display(vote)
            votes.append({
                "bill": simplify_bill_name(bill_name),
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
            "votingAlignment": round(aligned / total * 100) if total else None,
            "votes": votes,
        })

    mpps.sort(key=lambda m: m["lastName"].lower())

    OUTPUT.parent.mkdir(exist_ok=True)
    with open(OUTPUT, "w") as f:
        json.dump({"featuredBills": ["Bill 5", "Bill 17", "Bill 24", "Bill 48", "Bill 60", "Bill 68", "Bill 97"], "mpps": mpps}, f, indent=2)

    print(f"Wrote {len(mpps)} MPPs to {OUTPUT}")


if __name__ == "__main__":
    main()
