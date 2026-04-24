# BITFLIP-64

A browser-playable Othello (Reversi) game backed by a WebAssembly **alpha-beta engine** with iterative deepening, positional evaluation, and a perfect endgame solver. Three difficulty levels from beginner-friendly to near-optimal play.

**[Play it live →](https://thodges314.github.io/BITFLIP64/)**

---

## Features

- **Three difficulty levels**
  - **Easy** — depth-3 fixed search, ~200 ms
  - **Medium** — iterative deepening ~1.2 s, perfect solve ≤10 empty
  - **Hard** — iterative deepening ~3 s, perfect solve ≤20 empty
- **Perfect endgame solver** — switches from heuristic to exact disc-count negamax near game end
- **Positional weight table** — corners (+120), X-squares (−40), C-squares (−20), edges (+20)
- **Mobility evaluation** — penalises reducing your own options while expanding opponent's
- **Transposition table** — 1M entries keyed by Zobrist hash; avoids re-searching known positions
- **Move ordering** — corners first, X-squares last; dramatically improves alpha-beta pruning
- **Disc flip animation** — CSS 3D rotateY gives authentic Othello flip visual
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
2. TT move from the previous iteration tried first (dramatically improves pruning)
3. Remaining moves ordered by `MOVE_ORDER[]` (corners → edges → interior → X-squares)
4. Transposition table stores `(key, score, depth, flag, move)`

**Evaluation function** (non-terminal leaves):
```
score = positional_weights × 2   (POS_WEIGHTS[64] table)
      + mobility_ratio    × 5    (own − opp legal moves, normalised ±100)
      + disc_count        × 0–20  (weight increases as board fills)
```

**Perfect endgame** (≤10/20 empty depending on difficulty):
Pure negamax disc-count search, no evaluation needed. With corner-first move ordering and alpha-beta, solves 20-empty positions in < 1 s on WASM.

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
| Endgame | Greedy pass-suppress | Perfect exact solve |
| Evaluation | Chinese area scoring | Positional + mobility |
| Opening | KataGo 10-ply book | None (strong from move 1) |
