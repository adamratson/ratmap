#!/usr/bin/env python3
"""Writes python-dumps.tsv, which pyjson_test.go checks Decode and Encode against:

    python3 testdata/gen-vectors.py > testdata/python-dumps.tsv

Each line, every column JSON-escaped: the input text, then json.dumps(json.loads(input))
with the option sets the pipeline's writers use — (indent=None), (indent=2), (indent=2,
ensure_ascii=False), (indent=0, sort_keys=True). Seeded.
"""
import json
import random

random.seed(20260926)
OPTS = [dict(), dict(indent=2), dict(indent=2, ensure_ascii=False), dict(indent=0, sort_keys=True)]

def rnd_str():
    pool = 'abcXYZ09 -_/\\"\'\n\t\x01\x1f\x7f\u00e9\u00f3\u2014\u2028\u4e2d\U0001F600°'
    return ''.join(random.choice(pool) for _ in range(random.randint(0, 8)))

def rnd_num():
    k = random.random()
    if k < 0.3: return random.randint(-10**6, 10**6)
    if k < 0.4: return random.randint(-10**30, 10**30)
    if k < 0.7: return round(random.uniform(-180, 180), random.randint(0, 9))
    if k < 0.85: return float(random.randint(-1000, 1000))
    return random.uniform(-1e20, 1e20) * 10 ** random.randint(-30, 30)

def rnd_val(d=0):
    k = random.random()
    if d > 3 or k < 0.45:
        return random.choice([rnd_num, rnd_num, rnd_str, lambda: random.choice([True, False, None])])()
    if k < 0.72:
        return [rnd_val(d + 1) for _ in range(random.randint(0, 4))]
    return {rnd_str(): rnd_val(d + 1) for _ in range(random.randint(0, 4))}

texts = ['{}', '[]', '{"a": []}', '{"b": {}, "a": 1}', '[[], {}]', '{"k": 1, "k": 2, "z": 3}',
         '0', '-0', '-0.0', '5.0', '1e5', '123456789012345678901234567890', '"\u00e9"',
         '{"bbox": [-14.8615, 54.54, 0.2161, 61.1356]}', '[1.5e-07, 1e16, 1e-4]']
for _ in range(2500):
    texts.append(json.dumps(rnd_val(), ensure_ascii=random.random() < 0.5,
                            indent=random.choice([None, 2])))
for t in texts:
    v = json.loads(t)
    print('\t'.join([json.dumps(t)] + [json.dumps(json.dumps(v, **o)) for o in OPTS]))
