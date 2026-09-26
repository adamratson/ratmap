#!/usr/bin/env python3
"""Writes python-int.tsv, which main_test.go checks toInt's string parsing against:

    python3 testdata/gen-int-vectors.py > testdata/python-int.tsv

Each line: a population string (JSON-escaped) and what build-places-db.py's to_int made
of it — `int(s.replace(",", "").strip())` — or ERR where that raised. Seeded.
"""
import json
import random

random.seed(1)
cases = ['1200', ' 1200 ', '1,200', '1_200', '1__200', '_1200', '1200_', '+5', '-5', '007', '', ' ',
         '12.0', '1e3', '١٢٣', '１２３', '𝟙𝟚𝟛', '१२', 'abc', '12a', '−5', '9223372036854775807',
         '-9223372036854775808', '1 200', '\u00a01200\u00a0', '12\u200b', '٣_٤', '1,2,3', ',', '+', '-',
         '\x1c12\x1f', '+_1', '1_', '0_0', '٠', '߀߁']
for _ in range(3000):
    cases.append(''.join(random.choice('0123456789_ +-,.٣٤१२𝟙𝟠𝟵a\u00a0０９') for _ in range(random.randint(0, 7))))
for c in cases:
    try:
        out = str(int(c.replace(',', '').strip()))
    except ValueError:
        out = 'ERR'
    print(json.dumps(c) + '\t' + out)
