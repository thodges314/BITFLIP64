#!/usr/bin/env python3
"""
build_book.py — BITFLIP-64 Opening Book Builder
================================================
Parses the WThor grandmaster game database (.wtb files), replays each game
to MAX_DEPTH moves, votes on the best move per canonical D4 position, and
writes a sorted C++ array to engine/opening_book.hpp.

Features
  • Auto-downloads missing WThor files from GitHub / ffothello mirrors
  • Saves a checkpoint every CHECKPOINT_INTERVAL games (restartable)
  • Prints progress with games/sec and ETA every PROGRESS_INTERVAL games
  • D4 symmetry reduces book size by up to 8× in the opening
  • Output: sorted (hash, cell) array with binary-search lookup (no STL map)

Usage
  python3 tools/build_book.py                # fresh run (download + build)
  python3 tools/build_book.py --resume       # resume from checkpoint
  python3 tools/build_book.py --output-only  # write C++ from existing checkpoint
"""

import os, sys, struct, pickle, time, urllib.request
from pathlib import Path
from collections import defaultdict
from typing import Tuple

# ══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════════════════════
MAX_DEPTH            = 24       # Book positions for the first N moves
MIN_FREQ             = 10       # Drop positions seen < N times
CHECKPOINT_INTERVAL  = 10_000   # Pickle checkpoint every N games
PROGRESS_INTERVAL    = 1_000    # Console update every N games

ROOT            = Path(__file__).resolve().parent.parent   # BITFLIP64/
WTHOR_DIR       = ROOT / "tools" / "wthor"
CHECKPOINT_FILE = ROOT / "tools" / "book_checkpoint.pkl"
OUTPUT_FILE     = ROOT / "engine" / "opening_book.hpp"

# WThor download sources tried in order for each year
# Primary: ffothello.org/wthor/base/ (verified 2025)
WTHOR_URL_TEMPLATES = [
    "http://www.ffothello.org/wthor/base/WTH_{year}.wtb",
    "https://www.ffothello.org/wthor/base/WTH_{year}.wtb",
]
YEARS = range(1977, 2026)   # 1977–2025 available

# ══════════════════════════════════════════════════════════════════════════════
# OTHELLO BOARD  (mirrors OthelloBoard.hpp exactly)
# ══════════════════════════════════════════════════════════════════════════════
MASK64    = 0xFFFF_FFFF_FFFF_FFFF
NO_COL7   = 0x7F7F_7F7F_7F7F_7F7F   # strip col 7 (H) before E/NE/SE shifts
NO_COL0   = 0xFEFE_FEFE_FEFE_FEFE   # strip col 0 (A) before W/NW/SW shifts

# Starting position: black = e4 + d5, white = d4 + e5
START_BLACK = (1 << 28) | (1 << 35)
START_WHITE = (1 << 27) | (1 << 36)

# Each direction: (shift_amount, is_left_shift, pre_mask)
#   - left shift  = moving toward higher bit index (south / east)
#   - right shift = moving toward lower  bit index (north / west)
_DIRS = [
    (1, True,  NO_COL7),   # E   (col+1)
    (1, False, NO_COL0),   # W   (col-1)
    (8, True,  MASK64),    # S   (row+1)
    (8, False, MASK64),    # N   (row-1)
    (9, True,  NO_COL7),   # SE  (row+1, col+1)
    (9, False, NO_COL0),   # NW  (row-1, col-1)
    (7, True,  NO_COL0),   # SW  (row+1, col-1)
    (7, False, NO_COL7),   # NE  (row-1, col+1)
]

def _step(src: int, amt: int, left: bool, pmask: int) -> int:
    masked = src & pmask
    return ((masked << amt) & MASK64) if left else (masked >> amt)

def legal_moves(black: int, white: int, is_black: bool) -> int:
    player = black if is_black else white
    opp    = white if is_black else black
    empty  = (~(black | white)) & MASK64
    moves  = 0
    for amt, left, pmask in _DIRS:
        s = _step(player, amt, left, pmask) & opp
        while s:
            nxt    = _step(s, amt, left, pmask)
            moves |= nxt & empty   # empty cell beyond opponent run = legal
            s      = nxt & opp     # keep sliding through more opponent pieces
    return moves

def apply_move(black: int, white: int, cell: int, is_black: bool) -> Tuple[int, int]:
    player  = black if is_black else white
    opp     = white if is_black else black
    disc    = 1 << cell
    flipped = 0
    for amt, left, pmask in _DIRS:
        s = _step(disc, amt, left, pmask) & opp
        t = 0
        while s:
            t |= s
            s = _step(s, amt, left, pmask) & opp
        if t and (_step(t, amt, left, pmask) & player):
            flipped |= t
    player = (player | disc | flipped) & MASK64
    opp    = (opp    & ~flipped)       & MASK64
    return (player, opp) if is_black else (opp, player)

# ══════════════════════════════════════════════════════════════════════════════
# D4 SYMMETRY GROUP
# ══════════════════════════════════════════════════════════════════════════════
# 8 isometries of the square: 4 rotations + 4 reflections.
# Label  Operation        (r,c) → (nr,nc)          Inverse
#   0    identity         (r,   c  )                0
#   1    rot 90° CW       (c,   7-r)                3
#   2    rot 180°         (7-r, 7-c)                2
#   3    rot 270° CW      (7-c, r  )                1
#   4    flip rows (H)    (7-r, c  )                4
#   5    flip cols (V)    (r,   7-c)                5
#   6    transpose main   (c,   r  )                6
#   7    transpose anti   (7-c, 7-r)                7
_INVERSE_T = [0, 3, 2, 1, 4, 5, 6, 7]

def _make_cell_table(fn) -> list:
    tbl = [0] * 64
    for cell in range(64):
        r, c = cell >> 3, cell & 7
        nr, nc = fn(r, c)
        tbl[cell] = (nr << 3) | nc
    return tbl

_CELL_XFORM = [
    _make_cell_table(lambda r, c: (r,   c  )),   # 0
    _make_cell_table(lambda r, c: (c,   7-r)),   # 1
    _make_cell_table(lambda r, c: (7-r, 7-c)),   # 2
    _make_cell_table(lambda r, c: (7-c, r  )),   # 3
    _make_cell_table(lambda r, c: (7-r, c  )),   # 4
    _make_cell_table(lambda r, c: (r,   7-c)),   # 5
    _make_cell_table(lambda r, c: (c,   r  )),   # 6
    _make_cell_table(lambda r, c: (7-c, 7-r)),   # 7
]

def _transform_mask(mask: int, t: int) -> int:
    result = 0
    tbl    = _CELL_XFORM[t]
    m      = mask
    while m:
        bit     = m & (-m)
        result |= 1 << tbl[bit.bit_length() - 1]
        m      ^= bit
    return result

def canonical(black: int, white: int) -> Tuple[int, int, int]:
    """Return (canon_black, canon_white, transform_index).

    The canonical form is the lexicographically smallest (black, white) pair
    across all 8 D4 transforms. transform_index is the t that achieves it.
    """
    best_b, best_w, best_t = black, white, 0
    for t in range(1, 8):
        tb = _transform_mask(black, t)
        tw = _transform_mask(white, t)
        if (tb, tw) < (best_b, best_w):
            best_b, best_w, best_t = tb, tw, t
    return best_b, best_w, best_t

def transform_cell(cell: int, t: int) -> int:
    return _CELL_XFORM[t][cell]

def inverse_transform_cell(cell: int, t: int) -> int:
    return _CELL_XFORM[_INVERSE_T[t]][cell]

# ══════════════════════════════════════════════════════════════════════════════
# WTHOR FILE PARSING
# ══════════════════════════════════════════════════════════════════════════════
# WThor binary format:
#   16-byte file header (n_games at offset 4 as uint32 LE)
#   N × 68-byte game records:
#     bytes  0-1  : tournament id  (uint16)
#     bytes  2-3  : black player   (uint16)
#     bytes  4-5  : white player   (uint16)
#     byte   6    : best disc count for black (perfect play)
#     byte   7    : actual black disc count at game end
#     bytes  8-67 : 60 move bytes, each = (row+1)*10 + (col+1), 0 = no move
#
def _wthor_cell(byte: int) -> int:
    """Convert WThor move byte → cell index (0-63), or -1 for pass/none."""
    if byte == 0:
        return -1
    row = (byte // 10) - 1
    col = (byte %  10) - 1
    if not (0 <= row < 8 and 0 <= col < 8):
        return -1
    return row * 8 + col

def parse_wtb(path: Path):
    """Yield move-byte tuples (up to 60) for each game in a .wtb file."""
    data = path.read_bytes()
    if len(data) < 16:
        return
    # Infer n_games from header and file size; take the smaller sane value
    n_hdr  = struct.unpack_from('<I', data, 4)[0]
    n_size = (len(data) - 16) // 68
    n_games = min(n_hdr, n_size) if n_hdr <= n_size + 1 else n_size
    for i in range(n_games):
        off = 16 + i * 68
        if off + 68 > len(data):
            break
        yield struct.unpack_from('60B', data, off + 8)

# ══════════════════════════════════════════════════════════════════════════════
# DOWNLOAD
# ══════════════════════════════════════════════════════════════════════════════
def download_wthor():
    WTHOR_DIR.mkdir(parents=True, exist_ok=True)
    for year in YEARS:
        path = WTHOR_DIR / f"WTH_{year}.wtb"
        if path.exists() and path.stat().st_size > 100:
            continue
        for template in WTHOR_URL_TEMPLATES:
            url = template.format(year=year)
            try:
                print(f"  ↓ {url}", end='', flush=True)
                urllib.request.urlretrieve(url, path)
                print(f"  ({path.stat().st_size:,} B)")
                break
            except Exception as e:
                print(f"  ✗ {e}")
        else:
            print(f"  ! WTH_{year}.wtb unavailable from all sources — skipping")

# ══════════════════════════════════════════════════════════════════════════════
# CHECKPOINT
# ══════════════════════════════════════════════════════════════════════════════
def load_checkpoint():
    if CHECKPOINT_FILE.exists():
        with open(CHECKPOINT_FILE, 'rb') as f:
            return pickle.load(f)
    return None

def save_checkpoint(state: dict):
    CHECKPOINT_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CHECKPOINT_FILE.with_suffix('.tmp')
    with open(tmp, 'wb') as f:
        pickle.dump(state, f, protocol=pickle.HIGHEST_PROTOCOL)
    tmp.replace(CHECKPOINT_FILE)   # atomic rename
    print(f"  💾 checkpoint saved ({CHECKPOINT_FILE.stat().st_size / 1e6:.1f} MB)")

# ══════════════════════════════════════════════════════════════════════════════
# C++ OUTPUT
# ══════════════════════════════════════════════════════════════════════════════
def _fnv1a(black: int, white: int) -> int:
    """FNV-1a 64-bit hash — MUST match opening_book.hpp hash_pos()."""
    h = 0xCBF2_9CE4_8422_2325
    for b in (black.to_bytes(8, 'little') + white.to_bytes(8, 'little')):
        h = ((h ^ b) * 0x0000_0001_0000_01B3) & MASK64
    return h

def write_cpp(book: dict):
    """Filter, sort, and write the C++ header."""
    entries = []
    skipped = 0
    for (cb, cw), cell_votes in book.items():
        total = sum(cell_votes.values())
        if total < MIN_FREQ:
            skipped += 1
            continue
        best_cell = max(cell_votes, key=cell_votes.get)
        entries.append((_fnv1a(cb, cw), best_cell))

    entries.sort()

    # Deduplicate hash collisions (keep first occurrence)
    seen, deduped = set(), []
    for h, cell in entries:
        if h not in seen:
            seen.add(h)
            deduped.append((h, cell))
    entries = deduped

    print(f"\n  {len(entries):,} positions kept, {skipped:,} below MIN_FREQ={MIN_FREQ}")

    lines = [
        "// opening_book.hpp — AUTO-GENERATED by tools/build_book.py",
        "// Do NOT edit manually. Rebuild with: python3 tools/build_book.py",
        "//",
        f"// Source: WThor grandmaster database  MAX_DEPTH={MAX_DEPTH}  MIN_FREQ={MIN_FREQ}",
        f"// Positions: {len(entries):,}",
        "//",
        "// Lookup protocol (see OthelloAI.hpp):",
        "//   1. Compute canonical D4 form → (canon_black, canon_white, transform t)",
        "//   2. Hash with hash_pos(canon_black, canon_white)",
        "//   3. Binary-search BOOK_ENTRIES for the hash → canonical cell c",
        "//   4. Apply inverse D4 transform t to c → actual move cell",
        "#pragma once",
        "#include <cstdint>",
        "#include <cstddef>",
        "",
        "namespace OpeningBook {",
        "",
        "struct Entry { uint64_t key; uint8_t cell; };",
        "",
        f"static constexpr std::size_t BOOK_SIZE = {len(entries)}ULL;",
        "// Entries are sorted ascending by key for O(log N) binary search.",
        "static constexpr Entry BOOK_ENTRIES[] = {",
    ]
    for h, cell in entries:
        lines.append(f"    {{ 0x{h:016X}ULL, {cell:2d} }},")
    lines += [
        "};",
        "",
        "/// Returns canonical best-cell [0-63] or -1 if position not in book.",
        "inline int lookup(uint64_t key) noexcept {",
        "    std::size_t lo = 0, hi = BOOK_SIZE;",
        "    while (lo < hi) {",
        "        std::size_t mid = (lo + hi) >> 1;",
        "        const Entry& e  = BOOK_ENTRIES[mid];",
        "        if (e.key == key) return e.cell;",
        "        if (e.key  < key) lo = mid + 1;",
        "        else              hi = mid;",
        "    }",
        "    return -1;",
        "}",
        "",
        "/// FNV-1a 64-bit hash of (canonical_black, canonical_white).",
        "/// Must match the Python build script exactly.",
        "inline uint64_t hash_pos(uint64_t black, uint64_t white) noexcept {",
        "    uint64_t h = 0xCBF29CE484222325ULL;",
        "    for (int i = 0; i < 8; ++i) { h ^= (black >> (i*8)) & 0xFF; h *= 0x100000001B3ULL; }",
        "    for (int i = 0; i < 8; ++i) { h ^= (white >> (i*8)) & 0xFF; h *= 0x100000001B3ULL; }",
        "    return h;",
        "}",
        "",
        "} // namespace OpeningBook",
        "",
    ]
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text('\n'.join(lines))
    print(f"  ✓ Wrote {OUTPUT_FILE}  ({OUTPUT_FILE.stat().st_size / 1e6:.2f} MB)")

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════
def main():
    resume      = '--resume'      in sys.argv
    output_only = '--output-only' in sys.argv

    # ── Load or initialise state ─────────────────────────────────────────────
    state = load_checkpoint() if (resume or output_only) else None
    if state is None:
        state = {
            'book':        {},    # {(cb, cw): {cell: count}}  (plain dict → pickleable)
            'done':        set(), # WTB basenames fully processed
            'total_games': 0,
        }
        print("Starting fresh book build.")
    else:
        print(f"♻  Resumed: {state['total_games']:,} games, "
              f"{len(state['book']):,} canonical positions so far.")

    if output_only:
        write_cpp(state['book'])
        return

    # ── Download ─────────────────────────────────────────────────────────────
    print("\n── Downloading missing WThor files ──────────────────────────────────")
    download_wthor()

    wtb_files = sorted(WTHOR_DIR.glob("WTH_*.wtb"))
    if not wtb_files:
        print(f"\nERROR: No .wtb files found in {WTHOR_DIR}")
        print("  Place WTH_YYYY.wtb files there and re-run.")
        sys.exit(1)

    pending = [f for f in wtb_files if f.name not in state['done']]
    print(f"\n── Processing {len(pending)} WThor files  "
          f"({len(state['done'])} already done) ────────────────")

    book = state['book']
    t0   = time.perf_counter()
    wall_batch_start  = t0
    games_since_batch = 0

    for wtb_path in pending:
        file_games = 0
        for moves in parse_wtb(wtb_path):
            # ── Replay one game ──────────────────────────────────────────────
            black, white = START_BLACK, START_WHITE
            is_black = True

            for depth, mbyte in enumerate(moves):
                if depth >= MAX_DEPTH:
                    break
                cell = _wthor_cell(mbyte)
                if cell == -1:
                    # Pass or end-of-game marker
                    if legal_moves(black, white, is_black) == 0:
                        if legal_moves(black, white, not is_black) == 0:
                            break       # game over
                        is_black = not is_black
                    continue

                lm = legal_moves(black, white, is_black)
                if not (lm >> cell & 1):
                    break  # invalid move in this record — skip rest of game

                # Record canonical position → canonical move
                cb, cw, t = canonical(black, white)
                cc = transform_cell(cell, t)
                key = (cb, cw)
                if key not in book:
                    book[key] = {}
                sub = book[key]
                sub[cc] = sub.get(cc, 0) + 1

                black, white = apply_move(black, white, cell, is_black)
                is_black = not is_black

            file_games        += 1
            games_since_batch += 1
            state['total_games'] += 1

            # ── Progress report ──────────────────────────────────────────────
            if state['total_games'] % PROGRESS_INTERVAL == 0:
                now     = time.perf_counter()
                elapsed = now - wall_batch_start
                rate    = games_since_batch / elapsed if elapsed > 0 else 0
                # Rough total: scale by fraction of files done
                frac_done = (len(state['done']) + (file_games /
                             max(1, file_games + 1))) / len(wtb_files)
                total_est = state['total_games'] / max(frac_done, 1e-6)
                remaining = max(0.0, total_est - state['total_games'])
                eta_s   = remaining / rate if rate > 0 else 0
                h_, rem = divmod(int(eta_s), 3600)
                m_, s_  = divmod(rem, 60)
                print(f"  {state['total_games']:>9,} games | "
                      f"{len(book):>8,} positions | "
                      f"{rate:6.0f} g/s | "
                      f"ETA {h_}h{m_:02d}m{s_:02d}s | "
                      f"{wtb_path.name}")

            # ── Checkpoint ───────────────────────────────────────────────────
            if state['total_games'] % CHECKPOINT_INTERVAL == 0:
                save_checkpoint(state)
                wall_batch_start  = time.perf_counter()
                games_since_batch = 0

        state['done'].add(wtb_path.name)
        print(f"  ✓ {wtb_path.name}: {file_games:,} games "
              f"(total {state['total_games']:,})")
        save_checkpoint(state)

    # ── Final output ─────────────────────────────────────────────────────────
    elapsed = time.perf_counter() - t0
    print(f"\n── Done in {elapsed/60:.1f} min ────────────────────────────────────")
    write_cpp(book)

if __name__ == '__main__':
    main()
