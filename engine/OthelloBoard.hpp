// ============================================================================
// OthelloBoard.hpp — Bitflip-64 Othello Board (64-bit bitboard)
//
// Board encoding:
//   uint64_t black, white
//   bit i = row (i/8), col (i%8)
//   bit 0 = top-left (a1), bit 63 = bottom-right (h8)
//
// Standard Othello starting position (viewed top-to-bottom):
//   . . . . . . . .
//   . . . . . . . .
//   . . . . . . . .
//   . . . W B . . .   d4=White(27), e4=Black(28)
//   . . . B W . . .   d5=Black(35), e5=White(36)
//   . . . . . . . .
//   . . . . . . . .
//   . . . . . . . .
//
// Sentinel: cell index 64 = PASS
// ============================================================================
#pragma once
#include <cstdint>
#include <vector>

struct OthelloBoard {
    static constexpr int SIZE  = 8;
    static constexpr int CELLS = 64;
    static constexpr int PASS  = 64;

    uint64_t black = 0, white = 0;

    // ── Constructors ──────────────────────────────────────────────────────────
    OthelloBoard() {
        // Standard starting position
        white = (1ULL << 27) | (1ULL << 36);  // d4, e5
        black = (1ULL << 28) | (1ULL << 35);  // e4, d5
    }
    OthelloBoard(uint64_t b, uint64_t w) : black(b), white(w) {}

    // ── Disc counting ─────────────────────────────────────────────────────────
    int countBlack() const { return __builtin_popcountll(black); }
    int countWhite() const { return __builtin_popcountll(white); }
    int countDiscs(bool isBlack) const { return isBlack ? countBlack() : countWhite(); }
    int emptyCount()  const { return CELLS - countBlack() - countWhite(); }
    // Positive = Black leads, negative = White leads
    int score()       const { return countBlack() - countWhite(); }

    // ── 8-directional shift helpers ──────────────────────────────────────────
    // Column masks prevent row-wrapping at board edges.
    //   0x7F7F... strips col 7 (MSB of each byte) — used before shifts that
    //             increase column index (E, NE, SE).
    //   0xFEFE... strips col 0 (LSB of each byte) — used before shifts that
    //             decrease column index (W, NW, SW).
    static constexpr uint64_t MASK_NO_COL7 = 0x7F7F7F7F7F7F7F7FULL;
    static constexpr uint64_t MASK_NO_COL0 = 0xFEFEFEFEFEFEFEFEULL;

    static inline uint64_t shiftN (uint64_t b) { return b >> 8; }
    static inline uint64_t shiftS (uint64_t b) { return b << 8; }
    static inline uint64_t shiftE (uint64_t b) { return (b & MASK_NO_COL7) << 1; }
    static inline uint64_t shiftW (uint64_t b) { return (b & MASK_NO_COL0) >> 1; }
    static inline uint64_t shiftNE(uint64_t b) { return (b & MASK_NO_COL7) >> 7; }
    static inline uint64_t shiftNW(uint64_t b) { return (b & MASK_NO_COL0) >> 9; }
    static inline uint64_t shiftSE(uint64_t b) { return (b & MASK_NO_COL7) << 9; }
    static inline uint64_t shiftSW(uint64_t b) { return (b & MASK_NO_COL0) << 7; }

    // ── Legal move generation ─────────────────────────────────────────────────
    // Returns bitmask of all cells where isBlack can legally place a disc.
    // A legal move must bracket ≥1 opponent disc between the new stone and an
    // existing friendly stone in at least one direction.
    uint64_t getLegalMoves(bool isBlack) const {
        uint64_t player = isBlack ? black : white;
        uint64_t opp    = isBlack ? white : black;
        uint64_t empty  = ~(black | white);
        uint64_t moves  = 0;

        // Scan each direction: find runs of opponent discs ending in an empty cell
        auto scan = [&](auto shiftFn) {
            uint64_t candidates = shiftFn(player) & opp;
            while (candidates) {
                uint64_t next = shiftFn(candidates);
                moves      |= next & empty;   // empty cell = legal move
                candidates  = next & opp;     // opponent disc = keep scanning
            }
        };

        scan([](uint64_t b){ return shiftN(b);  });
        scan([](uint64_t b){ return shiftS(b);  });
        scan([](uint64_t b){ return shiftE(b);  });
        scan([](uint64_t b){ return shiftW(b);  });
        scan([](uint64_t b){ return shiftNE(b); });
        scan([](uint64_t b){ return shiftNW(b); });
        scan([](uint64_t b){ return shiftSE(b); });
        scan([](uint64_t b){ return shiftSW(b); });

        return moves;
    }

    // ── Flip computation ──────────────────────────────────────────────────────
    // Returns bitmask of all opponent discs that would flip by placing at cell.
    uint64_t getFlips(int cell, bool isBlack) const {
        uint64_t pos    = 1ULL << cell;
        uint64_t player = isBlack ? black : white;
        uint64_t opp    = isBlack ? white : black;
        uint64_t flips  = 0;

        auto scanFlips = [&](auto shiftFn) {
            uint64_t candidates = shiftFn(pos) & opp;
            uint64_t potential  = 0;
            while (candidates) {
                potential |= candidates;
                uint64_t next = shiftFn(candidates);
                if (next & player) { flips |= potential; return; }  // bracketed!
                candidates = next & opp;
            }
            // No bracketing friendly disc found — nothing flips in this direction
        };

        scanFlips([](uint64_t b){ return shiftN(b);  });
        scanFlips([](uint64_t b){ return shiftS(b);  });
        scanFlips([](uint64_t b){ return shiftE(b);  });
        scanFlips([](uint64_t b){ return shiftW(b);  });
        scanFlips([](uint64_t b){ return shiftNE(b); });
        scanFlips([](uint64_t b){ return shiftNW(b); });
        scanFlips([](uint64_t b){ return shiftSE(b); });
        scanFlips([](uint64_t b){ return shiftSW(b); });

        return flips;
    }

    // ── Apply a move ──────────────────────────────────────────────────────────
    // Returns a new board with the move applied (does NOT mutate this board).
    OthelloBoard afterMove(int cell, bool isBlack) const {
        if (cell == PASS) return *this;  // pass: board unchanged
        uint64_t pos   = 1ULL << cell;
        uint64_t flips = getFlips(cell, isBlack);
        OthelloBoard nb = *this;
        if (isBlack) {
            nb.black |=  pos | flips;
            nb.white &= ~flips;
        } else {
            nb.white |=  pos | flips;
            nb.black &= ~flips;
        }
        return nb;
    }

    // ── Game state helpers ────────────────────────────────────────────────────
    bool mustPass  (bool isBlack) const { return getLegalMoves(isBlack) == 0; }
    bool isGameOver()             const { return mustPass(true) && mustPass(false); }

    // Canonical key for transposition table: combine both bitmasks
    uint64_t hashKey() const {
        return black * 0x9E3779B97F4A7C15ULL ^ white * 0x517CC1B727220A95ULL;
    }
};
