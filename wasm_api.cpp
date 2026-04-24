// ============================================================================
// wasm_api.cpp — C→WASM bridge for Bitflip-64 Othello
//
// Board encoding: int* cells, length 64
//   cells[i] = 0 (empty) | 1 (Black) | 2 (White)
//   index i = 8*row + col (row 0 = top, col 0 = left)
//
// All exported functions are decorated with EMSCRIPTEN_KEEPALIVE to prevent
// dead-code elimination by the Emscripten linker.
// ============================================================================
#include "engine/OthelloBoard.hpp"
#include "engine/OthelloAI.hpp"
#include <emscripten.h>
#include <cstdlib>

static OthelloAI* g_ai = nullptr;

// ── Board reconstruction from flat int array ──────────────────────────────────
static OthelloBoard boardFromCells(const int* cells) {
    uint64_t black = 0, white = 0;
    for (int i = 0; i < OthelloBoard::CELLS; i++) {
        if      (cells[i] == 1) black |= (1ULL << i);
        else if (cells[i] == 2) white |= (1ULL << i);
    }
    return OthelloBoard(black, white);
}

extern "C" {

// ── wasm_init ─────────────────────────────────────────────────────────────────
// Must be called once after createEngineModule() resolves.
EMSCRIPTEN_KEEPALIVE
void wasm_init() {
    if (!g_ai) g_ai = new OthelloAI();
}

// ── wasm_getBestMove ──────────────────────────────────────────────────────────
// Parameters:
//   cells       — pointer to int[64] in WASM heap (0=empty, 1=Black, 2=White)
//   isBlack     — 1 if it is Black's turn, 0 for White
//   difficulty  — 0=Easy, 1=Medium, 2=Hard
//
// Returns: cell index 0–63, 64 (PASS), or -1 on error.
EMSCRIPTEN_KEEPALIVE
int wasm_getBestMove(const int* cells, int isBlack, int difficulty) {
    if (!g_ai) return -1;
    OthelloBoard board = boardFromCells(cells);
    return g_ai->getBestMove(board, isBlack == 1, difficulty);
}

// ── wasm_getLegalMoves ────────────────────────────────────────────────────────
// Writes the 64-bit legal move bitmask as two int32 halves into outHi/outLo.
// In JS: legal cell i is set if (i < 32 ? (lo >>> i) & 1 : (hi >>> (i-32)) & 1).
EMSCRIPTEN_KEEPALIVE
void wasm_getLegalMoves(const int* cells, int isBlack, int* outHi, int* outLo) {
    OthelloBoard board = boardFromCells(cells);
    uint64_t mask = board.getLegalMoves(isBlack == 1);
    *outHi = static_cast<int32_t>(mask >> 32);
    *outLo = static_cast<int32_t>(mask & 0xFFFFFFFFULL);
}

// ── wasm_getScore ─────────────────────────────────────────────────────────────
// Returns Black_discs - White_discs. Positive = Black leads.
EMSCRIPTEN_KEEPALIVE
int wasm_getScore(const int* cells) {
    return boardFromCells(cells).score();
}

} // extern "C"
