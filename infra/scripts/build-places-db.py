#!/usr/bin/env python3
"""Build places.sqlite — the offline search index (C9: no geocoding API, ever).

Input: one or more **line-delimited** GeoJSON files of point features (places and peaks),
as produced by normalize-peaks.py. Read a line at a time rather than `json.load`-ing each
document: a continent's export is millions of features and the whole-document form costs
~1.16 kB of Python objects per feature.
Output: a SQLite DB with an FTS5 index over names.

Schema note: FTS5 is used in `content=` (external content) mode, so names aren't stored
twice. The whole DB ships to the client and is queried in-browser, so every byte counts.
"""
import json
import sqlite3
import sys

# Settlement kinds worth searching. Deliberately excludes isolated_dwelling/farm/locality:
# they add tens of thousands of rows for names nobody searches on a mountain map.
PLACE_KINDS = {"city", "town", "village", "hamlet", "suburb"}
PEAK_KINDS = {"peak", "volcano", "saddle"}


def to_int(value):
    try:
        return int(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def classify(props):
    """Return (kind, importance) or None to skip the feature."""
    place = props.get("place")
    if place in PLACE_KINDS:
        # Population drives ranking among settlements; a city with no population tag
        # still outranks a hamlet via the kind ordering below.
        return place, to_int(props.get("population")) or 0

    natural = props.get("natural")
    if natural in PEAK_KINDS:
        return natural, 0
    if props.get("mountain_pass") == "yes":
        return "mountain_pass", 0
    return None


# Higher sorts first when scores tie. Settlements above summits: someone typing "Fort"
# most likely wants Fort William the town, not a nearby cairn.
KIND_RANK = {
    "city": 60,
    "town": 50,
    "village": 40,
    "suburb": 35,
    "hamlet": 30,
    "peak": 25,
    "volcano": 25,
    "saddle": 12,
    "mountain_pass": 12,
}


def stream_features(paths):
    """Yield features one at a time from line-delimited GeoJSON files.

    Never holds more than a single feature, so peak memory is set by what build()
    accumulates (the rows list and the dedupe set) rather than by the size of the inputs.
    """
    for path in paths:
        with open(path) as f:
            for line in f:
                # RFC8142 record separator — see the note in normalize-peaks.py.
                line = line.lstrip("\x1e").strip()
                if line:
                    yield json.loads(line)


def build(sources, dest):
    db = sqlite3.connect(dest)
    db.executescript(
        """
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;

        DROP TABLE IF EXISTS places;
        CREATE TABLE places (
            id         INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            kind       TEXT NOT NULL,
            lat        REAL NOT NULL,
            lon        REAL NOT NULL,
            ele        REAL,
            population INTEGER,
            rank       INTEGER NOT NULL
        );
        """
    )

    rows = []
    seen = set()
    for feature in stream_features(sources):
        props = feature.get("properties", {})
        name = props.get("name")
        if not name or not isinstance(name, str):
            continue

        classified = classify(props)
        if classified is None:
            continue
        kind, population = classified

        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point":
            continue
        lon, lat = geometry["coordinates"][:2]

        # The same feature can appear in overlapping extracts; dedupe on
        # name+rounded position rather than OSM id, which differs across sources.
        key = (name, round(lat, 4), round(lon, 4), kind)
        if key in seen:
            continue
        seen.add(key)

        ele = props.get("ele")
        ele = float(ele) if isinstance(ele, (int, float)) else None

        rows.append(
            (
                name,
                kind,
                lat,
                lon,
                ele,
                population or None,
                KIND_RANK.get(kind, 0) + min(population // 1000, 40),
            )
        )

    db.executemany(
        "INSERT INTO places (name, kind, lat, lon, ele, population, rank)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        rows,
    )

    db.executescript(
        """
        DROP TABLE IF EXISTS places_fts;
        CREATE VIRTUAL TABLE places_fts USING fts5(
            name,
            content='places',
            content_rowid='id',
            tokenize="unicode61 remove_diacritics 2"
        );
        INSERT INTO places_fts (rowid, name) SELECT id, name FROM places;

        -- Distance ranking is done in the client against the live viewport, so the only
        -- index worth carrying is the one FTS5 needs plus a rank index for tie-breaks.
        CREATE INDEX idx_places_rank ON places(rank DESC);
        """
    )
    db.commit()
    db.execute("VACUUM")
    db.commit()

    counts = dict(db.execute("SELECT kind, COUNT(*) FROM places GROUP BY kind").fetchall())
    total = db.execute("SELECT COUNT(*) FROM places").fetchone()[0]
    db.close()

    print(f"places.sqlite: {total} rows")
    for kind, count in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {kind}: {count}")


if __name__ == "__main__":
    build(sys.argv[1:-1], sys.argv[-1])
