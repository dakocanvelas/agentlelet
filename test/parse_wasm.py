#!/usr/bin/env python3
"""Extract the FNV-1a signal hashes from the gatekeeper WASM data section.

Circom 2 stores the input-signal table in the WASM data section: segment 18
(memoff 2032, 4096 bytes) holds one entry per input signal — the FNV-1a
64-bit hash of the signal name, followed by its signal index. This script
finds the 11 known names' hashes there and prints the whole table, so any
hash with no known name stands out (that is how registeredVkHash /
proofVkHash were found on 15 Nov 2026).
"""
import struct

data = open("gatekeeper.wasm", "rb").read()
print("wasm size:", len(data))


def read_uleb(buf, p):
    r = 0
    s = 0
    while True:
        b = buf[p]
        p += 1
        r |= (b & 0x7F) << s
        if not (b & 0x80):
            break
        s += 7
    return r, p


def fnv1a(s):
    h = 0xCBF29CE484222325
    for ch in s.encode():
        h ^= ch
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return h


known = ["decision", "taskId", "minimum", "recipient", "amount",
         "publicBalance", "expiryBlock", "currentBlock", "conditionRecipient",
         "maxTransfer", "salt", "registeredVkHash", "proofVkHash"]
known_h = {fnv1a(n): n for n in known}

p = 8
sections = []
while p < len(data):
    sid = data[p]
    p += 1
    size, p = read_uleb(data, p)
    sections.append((sid, p, size))
    p += size

for sid, off, size in sections:
    if sid != 11:
        continue
    q = off
    nseg, q = read_uleb(data, q)
    print("data segments:", nseg)
    # Pass 1: find which segments contain a known signal hash.
    segments = []
    for si in range(nseg):
        flags, q = read_uleb(data, q)
        if flags == 0:
            assert data[q] == 0x41
            q += 1
            memoff, q = read_uleb(data, q)
            assert data[q] == 0x0B
            q += 1
        elif flags == 1:
            memoff = None
        elif flags == 2:
            _mi, q = read_uleb(data, q)
            assert data[q] == 0x41
            q += 1
            memoff, q = read_uleb(data, q)
            assert data[q] == 0x0B
            q += 1
        else:
            print("unsupported data flags", flags)
            break
        seglen, q = read_uleb(data, q)
        seg = data[q:q + seglen]
        q += seglen
        segments.append((si, memoff, seg))
    hit_segs = set()
    for si, memoff, seg in segments:
        for i in range(0, len(seg) - 7):
            v = struct.unpack_from("<Q", seg, i)[0]
            if v in known_h:
                hit_segs.add(si)
    # Pass 2: dump only the signal-table segment(s) as (hash, index) entries.
    for si, memoff, seg in segments:
        if si not in hit_segs:
            continue
        print(f"--- signal table: segment {si} memoff={memoff} len={len(seg)} ---")
        for i in range(0, len(seg) - 7, 8):
            v = struct.unpack_from("<Q", seg, i)[0]
            if v == 0:
                continue
            nxt = struct.unpack_from("<Q", seg, i + 8)[0] if i + 15 < len(seg) else None
            # Entry shape: hash followed by 0x00000001_000000XX (signal index).
            if nxt is not None and (nxt & 0xFFFFFFFF00000000) == 0x0000000100000000:
                name = known_h.get(v, "*** UNKNOWN ***")
                print(f"  +{i} mem={memoff + i if memoff is not None else '?'} "
                      f"hash={v:016x} signal_index={nxt & 0xFFFFFFFF} name={name}")
