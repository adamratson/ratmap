#!/usr/bin/env python3
"""Writes python-vectors.tsv, the golden file pyfloat_test.go checks against.

    python3 testdata/gen-vectors.py > testdata/python-vectors.tsv

Columns: the double's exact bit pattern (hex), repr(x), round(x,1), round(x,4),
round(x,7), format(x,'g'). Seeded, so a re-run writes the same file.
"""
import random
import struct

random.seed(20260925)
xs = [0.0, -0.0, 1.0, 708.0, 0.25, 0.35, 2.675, 0.05, 0.15, 1.45, 2.5, -2.5, 1e16,
      9999999999999998.0, 1e-4, 1e-5, 0.0001234, 123456789012345678.0, 5e-324,
      1.7976931348623157e308, 0.1, 0.2, 0.30000000000000004, 1234.5, 1234.55, 1234.45,
      20.0, 1e6, 999999.5, 100000.0, 0.000833333, 57.123456789]
for _ in range(4000):
    k = random.random()
    if k < 0.3:
        x = random.uniform(-9000, 9000)
    elif k < 0.5:
        # Values sitting on or next to a rounding tie, the case Python and Go disagree on.
        x = round(random.uniform(-9000, 9000), random.randint(0, 3)) + random.choice(
            [0, 0.05, 0.005, 0.00005])
    elif k < 0.7:
        x = random.randint(-10**6, 10**6) / random.choice([2, 4, 8, 16, 20, 40, 100, 1000])
    else:
        x = struct.unpack('<d', struct.pack('<Q', random.getrandbits(64)))[0]
        if x != x or x in (float('inf'), float('-inf')):
            continue
    xs.append(x)
for x in xs:
    bits = struct.unpack('<Q', struct.pack('<d', x))[0]
    try:
        r = [repr(round(x, n)) for n in (1, 4, 7)]
    except OverflowError:
        continue
    print('%016x\t%s\t%s\t%s\t%s\t%s' % (bits, repr(x), *r, format(x, 'g')))
