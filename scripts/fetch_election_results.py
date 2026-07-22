#!/usr/bin/env python3
"""Build data/election-results.json from Elections Ontario EFRS (2025 GE)."""

from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "election-results.json"

API = "https://results.elections.on.ca/api/election-explorer"
ELECTION_ID = 527  # 2025 Provincial General Election
YEAR = 2025

PARTY = {
    "PCP": "PC",
    "LIB": "Liberal",
    "NDP": "NDP",
    "GPO": "Green",
    "NBO": "New Blue",
    "ONP": "Ontario Party",
    "IND": "Independent",
}


def post(path: str, payload: dict):
    req = urllib.request.Request(
        f"{API}/{path}",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Accept-Language": "en",
            "User-Agent": "OAC-MPP-Tracker/1.0 (accountability research)",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)


def normalize_riding(name: str) -> str:
    return re.sub(r"^\d+\s*-\s*", "", str(name or "")).strip()


def main() -> None:
    base = {
        "fromYear": str(YEAR),
        "toYear": str(YEAR),
        "electionId": ELECTION_ID,
        "levelOfDetail": "district",
        "electionType": "GE",
        "partyNames": "",
        "candidateNames": "",
        "isCandidateWinner": False,
        "edIds": "",
        "pageSize": 200,
        "pageIndex": 0,
        "sortByPropertyName": "electoralDistrictName",
        "sortByAscending": True,
    }

    districts = post("electoral-districts", {**base, "pageSize": 200})["results"]
    district_by = {normalize_riding(d["electoralDistrictName"]): d for d in districts}

    cand_payload = {
        **base,
        "levelOfDetail": "candidate",
        "pageSize": 2000,
        "pageIndex": 0,
    }
    cand_chunk = post("candidates", cand_payload)
    candidates = cand_chunk.get("results") or []
    total_records = cand_chunk.get("totalRecords") or len(candidates)
    page = 1
    while len(candidates) < total_records and page < 30:
        more = post("candidates", {**cand_payload, "pageIndex": page})
        rows = more.get("results") or []
        if not rows:
            break
        candidates.extend(rows)
        page += 1

    by_riding: dict[str, list] = {}
    for c in candidates:
        riding = normalize_riding(c["electoralDistrictName"])
        by_riding.setdefault(riding, []).append(c)

    out = {
        "year": YEAR,
        "electionId": ELECTION_ID,
        "source": "https://results.elections.on.ca/en/data-explorer?electionId=527",
        "asOf": None,
        "ridings": {},
    }

    for riding, rows in sorted(by_riding.items()):
        rows = sorted(rows, key=lambda r: r.get("validBallotCount") or 0, reverse=True)
        winner = rows[0]
        second = rows[1] if len(rows) > 1 else None
        d = district_by.get(riding, {})
        total = d.get("validBallotCount") or sum((r.get("validBallotCount") or 0) for r in rows)
        turnout_raw = d.get("voterTurnoutPercent")
        turnout = round(float(turnout_raw) * 100, 1) if turnout_raw is not None and float(turnout_raw) <= 1.5 else (
            round(float(turnout_raw), 1) if turnout_raw is not None else None
        )
        margin_votes = None
        margin_pct = None
        if second and total:
            margin_votes = (winner.get("validBallotCount") or 0) - (second.get("validBallotCount") or 0)
            margin_pct = round(margin_votes / total * 100, 1)

        out["ridings"][riding] = {
            "winnerParty": PARTY.get(winner.get("partyAbbreviation"), winner.get("partyAbbreviation")),
            "winnerName": winner.get("candidateName"),
            "secondParty": PARTY.get(second.get("partyAbbreviation"), second.get("partyAbbreviation")) if second else None,
            "marginVotes": margin_votes,
            "marginPct": margin_pct,
            "turnoutPct": turnout,
            "winnerVotes": winner.get("validBallotCount"),
            "secondVotes": second.get("validBallotCount") if second else 0,
            "totalVotes": total,
            "registeredVoters": d.get("registeredVoterCount"),
        }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(out['ridings'])} ridings → {OUT}")


if __name__ == "__main__":
    main()
