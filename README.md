# BITFLIP-64

A browser-playable Othello (Reversi) game backed by a WebAssembly **alpha-beta engine** with iterative deepening, transposition table caching, and a perfect endgame solver. Three difficulty levels from beginner-friendly to near-optimal play.

**[Play it live →](https://thodges314.github.io/BITFLIP64/)**

---

## Features

- **Three difficulty levels**
  - **Easy** — depth-3 fixed search, ~200 ms
  - **Medium** — iterative deepening ~1.2 s, perfect solve ≤10 empty
  - **Hard** — iterative deepening ~3 s, perfect solve ≤20 empty
- **Perfect endgame solver** — at ≤20 empty squares the engine switches from heuristic evaluation to exact disc-count negamax, guaranteeing mathematically optimal play in the final phase
- **Iterative-deepening-integrated perfect solver** — the perfect solve is reached via the same ID loop as the midgame, so the transposition table is fully seeded with strong move ordering before the deep exact search begins
- **Time-limit safety** — if a 20-ply perfect solve approaches the 3-second budget, the engine bails out and returns the best move found at the previous completed depth, preventing any browser UI freeze
- **Phase-adaptive evaluation** — weights shift between opening, midgame, and late-game phases automatically
- **Positional weight table** — corners (+120), X-squares (−40), C-squares (−20), edges (+20), with X-square correction when the adjacent corner is owned
- **Mobility evaluation** — rewards having more legal moves than the opponent (normalised ±100)
- **Frontier disc penalty** — penalises discs adjacent to empty squares, which are vulnerable to being flipped
- **Edge stability bonus** — rewards discs in stable runs connected to owned corners along each edge
- **Transposition table** — 1 M entries keyed by Zobrist hash with exact/lower/upper bound flags; avoids re-searching known positions across both midgame and perfect-solve phases
- **Move ordering** — TT best move tried first, then `MOVE_ORDER[]` (corners → edges → interior → X-squares last); dramatically improves alpha-beta pruning
- **Last-move indicator** — a red dot marks the most recently played disc on the board, matching standard Othello UI conventions
- **Disc flip animation** — CSS 3D `rotateY` gives authentic Othello flip visual
- **Auto-pass** — when a player has no legal moves, the turn passes automatically
- **Web Worker** — engine runs in a background thread; UI is always responsive

## Repository Layout

```
BITFLIP64/
├── engine/
│   ├── OthelloBoard.hpp    # 64-bit bitboard: legal moves, flips, scoring
│   └── OthelloAI.hpp       # Alpha-beta, evaluation, endgame solver
├── public/
│   ├── coi-serviceworker.js # Cross-Origin Isolation headers
│   ├── engine-worker.js    # Web Worker (WASM host)
│   ├── engine.js           # Emscripten output (committed)
│   └── engine.wasm         # Emscripten output (committed)
├── wasm_api.cpp            # C→WASM bridge
├── index.html              # Game UI
├── style.css               # Dark theme, LCD title, disc flip animation
├── app.js                  # Game controller
├── Makefile                # Build: make wasm | make serve
└── README.md
```

## Building

Requires [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html).

```bash
source ~/emsdk/emsdk_env.sh
make wasm    # outputs public/engine.js + public/engine.wasm
make serve   # python3 -m http.server 8000 → http://localhost:8000
```

## Engine Architecture

### Board Representation (`OthelloBoard.hpp`)

Two `uint64_t` bitmasks (`black`, `white`). Bit `i = 8×row + col`, bit 0 = top-left.

8-directional moves use column-edge masks to prevent row-wrapping:
- `0x7F7F…` strips col 7 before East/NE/SE shifts
- `0xFEFE…` strips col 0 before West/NW/SW shifts

Legal move generation and flip computation both use the same direction-scan loop: slide from the player stone through opponent stones until hitting an empty cell (legal) or a bracketing player stone (flip).

### Search (`OthelloAI.hpp`)

**Iterative deepening negamax alpha-beta:**
1. Starts at depth 1, deepens until time limit is hit
2. TT best move from the previous completed iteration tried first (dramatically improves pruning)
3. Remaining moves sorted by **history score** (descending), then by static `MOVE_ORDER[]`
4. Transposition table stores `(key, score, depth, flag, move)` with exact/lower/upper bound flags

**Aspiration windows:**
From depth 4 onward, each iteration opens with a narrow `[prevScore − 25, prevScore + 25]` window instead of `(−∞, +∞)`. A narrower window produces far more alpha-beta cutoffs in the common case where the score is stable across depths. On a fail-low or fail-high, the window widens by doubling the delta and re-searches at the same depth until the score falls inside — or the window expands to full range.

**History heuristic:**
A `history[64]` table accumulates `depth²` points every time a move causes a beta cutoff (`alpha ≥ beta`). This score is reset at the start of each move decision and builds up within the search tree across all branches and depths. `orderedMoves()` sorts non-TT moves by their history score descending, with the static positional `MOVE_ORDER` used as a tiebreaker via `std::stable_sort`. Moves that consistently produce cutoffs therefore float to the front of the list at the next depth, compounding the pruning benefit.

**Perfect endgame intercept:**
When the search depth within `negamax` reaches the number of empty squares and the position is within the endgame threshold (≤10 or ≤20 empty, per difficulty), the call is transparently redirected to `negamaxPerfect`. This means iterative deepening seeds the TT with well-ordered move hints before the exact deep search fires — far more efficient than a cold-start 20-ply search.

**Time-limit safety:**
`negamaxPerfect` checks `timeLimitHit` on every node entry and polls `timeUp()` every 1024 nodes. If the budget is exceeded, it aborts and the ID loop returns the best result from the previous completed depth.

**Evaluation function** (non-terminal leaves, phase-adaptive weights):

| Term | Early (>40 empty) | Mid (>20 empty) | Late (≤20 empty) |
|---|---|---|---|
| Positional weights | ×1 | ×2 | ×3 |
| Mobility (±100) | ×8 | ×5 | ×3 |
| Frontier discs (±100) | ×3 | ×4 | ×4 |
| Edge stability | ×2 | ×4 | ×6 |
| Disc count | ×0 | ×0 | ×0–20 |

Disc count weight ramps from 0 at 20 empty to 20 at 0 empty, bridging heuristic evaluation into the exact endgame phase.

### WASM API (`wasm_api.cpp`)

| Function | Parameters | Returns |
|---|---|---|
| `wasm_init()` | — | — |
| `wasm_getBestMove(cells, isBlack, difficulty)` | `int*[64], int, int` | cell 0–63, 64=PASS, −1=err |
| `wasm_getLegalMoves(cells, isBlack, outHi, outLo)` | `int*[64], int, int*, int*` | 64-bit mask split into two int32 |
| `wasm_getScore(cells)` | `int*[64]` | Black − White disc count |

## Compared to TENGEN5 (Go)

| | TENGEN5 | BITFLIP-64 |
|---|---|---|
| Game | 5×5 Go | 8×8 Othello |
| Algorithm | UCT-RAVE MCTS | Alpha-beta negamax |
| Parallelism | 4 pthreads | Single-threaded |
| Endgame | Greedy pass-suppress | Perfect exact solve (≤20 empty) |
| Evaluation | Chinese area scoring | Positional + mobility + frontier + edge stability |
| Opening | KataGo 10-ply book | None (strong from move 1) |
