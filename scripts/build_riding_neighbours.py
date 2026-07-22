#!/usr/bin/env python3
"""Build data/riding-neighbours.json from ontario-ridings.geojson (shared borders)."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GEO = ROOT / "data" / "ontario-ridings.geojson"
OUT = ROOT / "data" / "riding-neighbours.json"


def ring_edges(ring):
    edges = set()
    for i in range(len(ring) - 1):
        a = (round(ring[i][0], 2), round(ring[i][1], 2))
        b = (round(ring[i + 1][0], 2), round(ring[i + 1][1], 2))
        if a == b:
            continue
        edges.add(tuple(sorted((a, b))))
    return edges


def feature_edges(geom):
    edges = set()
    if not geom:
        return edges
    t = geom["type"]
    coords = geom["coordinates"]
    if t == "Polygon":
        polys = [coords]
    elif t == "MultiPolygon":
        polys = coords
    else:
        return edges
    for poly in polys:
        for ring in poly:
            edges |= ring_edges(ring)
    return edges


def main() -> None:
    geo = json.loads(GEO.read_text(encoding="utf-8"))
    edge_owners = defaultdict(set)
    names = []
    for f in geo["features"]:
        name = f["properties"]["name"]
        names.append(name)
        for e in feature_edges(f["geometry"]):
            edge_owners[e].add(name)

    neighbours = {n: set() for n in names}
    for owners in edge_owners.values():
        if len(owners) < 2:
            continue
        own = list(owners)
        for i, a in enumerate(own):
            for b in own[i + 1 :]:
                neighbours[a].add(b)
                neighbours[b].add(a)

    out = {k: sorted(v) for k, v in sorted(neighbours.items())}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    avg = sum(len(v) for v in out.values()) / max(len(out), 1)
    print(f"Wrote neighbours for {len(out)} ridings (avg {avg:.1f} neighbours) → {OUT}")


if __name__ == "__main__":
    main()
