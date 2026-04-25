// ============================================================================
// OthelloAI.hpp — Bitflip-64 Othello AI
//
// Algorithm: Iterative-deepening alpha-beta negamax with:
//   • Positional weight table, mobility bonus, frontier penalty, edge stability
//   • Transposition table (1M entries, Zobrist-keyed)
//   • Aspiration windows (narrows α-β window using previous iteration score)
//   • Principal Variation Search (PVS) in both midgame and perfect endgame
//   • Late Move Reductions (LMR) — depth-1 probe for low-priority moves;
//       re-searches at full depth only if the reduced probe fails high
//   • Killer move heuristic (2 killers per depth, promoted above history)
//   • History heuristic (cutoff moves sorted to front at each depth)
//   • Move ordering: TT move → killers → history score → MOVE_ORDER
//   • Perfect endgame solver when empty ≤ endgame threshold
//
// Difficulty levels:
//   0 = Easy   — depth 3 fixed, no endgame solver
//   1 = Medium  — iterative deepening ~1.2 s, perfect solve ≤10 empty
//   2 = Hard    — iterative deepening ~4.0 s, perfect solve ≤26 empty
// ============================================================================
#pragma once
#include "OthelloBoard.hpp"
#include "opening_book.hpp"
#include <algorithm>
#include <array>
#include <chrono>
#include <climits>
#include <cstring>
#include <tuple>
#include <vector>

// ── Positional weight table ───────────────────────────────────────────────────
// Corners (+120) are the strongest positions; X-squares (-40, diagonal to
// corners) are the weakest because they gift corners to the opponent.
// C-squares (-20, edge-adjacent to corners) are also dangerous early.
static constexpr int POS_WEIGHTS[64] = {
    120,-20, 20,  5,  5, 20,-20,120,
    -20,-40, -5, -5, -5, -5,-40,-20,
     20, -5, 15,  3,  3, 15, -5, 20,
      5, -5,  3,  3,  3,  3, -5,  5,
      5, -5,  3,  3,  3,  3, -5,  5,
     20, -5, 15,  3,  3, 15, -5, 20,
    -20,-40, -5, -5, -5, -5,-40,-20,
    120,-20, 20,  5,  5, 20,-20,120,
};

// ── Move ordering priority list ───────────────────────────────────────────────
// Pre-sorted once: corners → edges → interior → X/C-squares.
// Used to iterate legal moves in best-first order inside the search.
static const int MOVE_ORDER[64] = {
     0,  7, 56, 63,   // corners
     2,  5, 16, 23, 40, 47, 58, 61,   // C-squares (edge, 2 from corner)
     3,  4, 24, 31, 32, 39, 59, 60,   // stable edges
     1,  6,  8, 15, 48, 55, 57, 62,   // "A" edge squares
    18, 21, 34, 37,   // near center
    19, 20, 26, 27, 28, 29, 35, 36, 43, 44, // center 4 and near
    10, 13, 50, 53,   // interior near edges
    11, 12, 51, 52,
    17, 22, 33, 38, 25, 30, 41, 46,
     9, 14, 49, 54,   // X-squares (worst — last)
};

// ── Transposition table ───────────────────────────────────────────────────────
struct TTEntry {
    uint64_t key   = 0;
    int      score = 0;
    int8_t   depth = 0;
    int8_t   flag  = 0;   // 0=exact  1=lower(fail-high)  2=upper(fail-low)
    int8_t   move  = -1;  // best move cell (0–63) or 64=pass
};

static constexpr size_t TT_SIZE = 1 << 20;  // ~1M entries
static TTEntry g_tt[TT_SIZE];

inline TTEntry* ttLookup(uint64_t key) { return &g_tt[key & (TT_SIZE - 1)]; }
inline void     ttClear()              { std::memset(g_tt, 0, sizeof(g_tt)); }

// ── OthelloAI ─────────────────────────────────────────────────────────────────
class OthelloAI {
public:
    int  nodesSearched    = 0;
    bool timeLimitHit     = false;
    bool lastMoveWasBook  = false;   // set true when getBestMove returns a book move
    std::chrono::steady_clock::time_point searchStart;
    int  timeLimitMs   = 1000;

    // History heuristic: tracks how often each square (0-63) caused a
    // beta cutoff, weighted by depth².  Reset each call to getBestMove.
    int  history[64]    = {};

    // Killer move heuristic: up to 2 moves per depth that recently caused
    // a beta cutoff.  Promoted above history-sorted moves in orderedMoves.
    // Stored as killers[depth][slot]; -1 = empty.  Reset each call.
    int  killers[64][2] = {};

    // ── D4 symmetry utilities for opening book ────────────────────────────────
    // 8 isometries of the square (identity, 3 rotations, 4 reflections).
    // Used to normalise a board position to its lexicographically smallest
    // equivalent orientation (canonical form) before book lookup.
    //
    // transform index:  0=id  1=r90CW  2=r180  3=r270CW
    //                   4=flipH  5=flipV  6=transposeMain  7=transposeAnti
    static constexpr int INVERSE_T[8] = {0, 3, 2, 1, 4, 5, 6, 7};

    static uint64_t transformMask(uint64_t mask, int t) noexcept {
        uint64_t result = 0;
        for (uint64_t m = mask; m; ) {
            uint64_t bit  = m & (-m);  m ^= bit;
            int cell      = __builtin_ctzll(bit);
            int r = cell >> 3, c = cell & 7, nr, nc;
            switch (t) {
                case 0: nr=r;   nc=c;   break;
                case 1: nr=c;   nc=7-r; break;
                case 2: nr=7-r; nc=7-c; break;
                case 3: nr=7-c; nc=r;   break;
                case 4: nr=7-r; nc=c;   break;
                case 5: nr=r;   nc=7-c; break;
                case 6: nr=c;   nc=r;   break;
                default:nr=7-c; nc=7-r; break;
            }
            result |= 1ULL << (nr*8+nc);
        }
        return result;
    }

    // Returns (canon_black, canon_white, transform_index).
    // canon = lexicographically smallest (black,white) pair across all 8 D4 transforms.
    static std::tuple<uint64_t,uint64_t,int>
    canonForm(uint64_t black, uint64_t white) noexcept {
        uint64_t best_b = black, best_w = white;  int best_t = 0;
        for (int t = 1; t < 8; ++t) {
            uint64_t tb = transformMask(black, t);
            uint64_t tw = transformMask(white, t);
            if (tb < best_b || (tb == best_b && tw < best_w)) {
                best_b = tb; best_w = tw; best_t = t;
            }
        }
        return {best_b, best_w, best_t};
    }

    static int applyTransformCell(int cell, int t) noexcept {
        int r = cell >> 3, c = cell & 7, nr, nc;
        switch (t) {
            case 0: nr=r;   nc=c;   break;
            case 1: nr=c;   nc=7-r; break;
            case 2: nr=7-r; nc=7-c; break;
            case 3: nr=7-c; nc=r;   break;
            case 4: nr=7-r; nc=c;   break;
            case 5: nr=r;   nc=7-c; break;
            case 6: nr=c;   nc=r;   break;
            default:nr=7-c; nc=7-r; break;
        }
        return nr*8+nc;
    }

    // ── Public API ────────────────────────────────────────────────────────────
    // Returns best cell index (0–63) or OthelloBoard::PASS.
    // difficulty: 0=Easy, 1=Medium, 2=Hard
    int getBestMove(const OthelloBoard& board, bool isBlack, int difficulty) {
        nodesSearched = 0;
        timeLimitHit  = false;
        searchStart   = std::chrono::steady_clock::now();

        int maxDepth, endgameThresh;
        switch (difficulty) {
            case 0:  timeLimitMs = 200;  endgameThresh =  0; maxDepth =  3; break;
            case 1:  timeLimitMs = 1200; endgameThresh = 10; maxDepth = 60; break;
            default: timeLimitMs = 5000; endgameThresh = 32; maxDepth = 60; break;
        }

        return getBestMoveAB(board, isBlack, maxDepth, endgameThresh);
    }

private:
    // ── Frontier discs ────────────────────────────────────────────────
    // A frontier disc is adjacent to at least one empty square — it can
    // be targeted for flipping. Fewer frontier discs = better structure.
    static int frontierCount(uint64_t player, uint64_t empty) {
        uint64_t adj = OthelloBoard::shiftN(empty)  | OthelloBoard::shiftS(empty)
                     | OthelloBoard::shiftE(empty)  | OthelloBoard::shiftW(empty)
                     | OthelloBoard::shiftNE(empty) | OthelloBoard::shiftNW(empty)
                     | OthelloBoard::shiftSE(empty) | OthelloBoard::shiftSW(empty);
        return __builtin_popcountll(player & adj);
    }

    // ── Edge stability ────────────────────────────────────────────────
    static int edgeStabilityCount(uint64_t player) {
        int count = 0;

        // Top edge: cells 0–7
        {
            uint64_t mask = 0;
            if ((player >> 0) & 1)
                for (int c = 0; c < 8 && ((player >> c) & 1); ++c) mask |= 1ULL << c;
            if ((player >> 7) & 1)
                for (int c = 7; c >= 0 && ((player >> c) & 1); --c) mask |= 1ULL << c;
            count += __builtin_popcountll(mask);
        }
        // Bottom edge: cells 56–63
        {
            uint64_t mask = 0;
            if ((player >> 56) & 1)
                for (int c = 56; c < 64 && ((player >> c) & 1); ++c) mask |= 1ULL << c;
            if ((player >> 63) & 1)
                for (int c = 63; c >= 56 && ((player >> c) & 1); --c) mask |= 1ULL << c;
            count += __builtin_popcountll(mask);
        }
        // Left edge: cells 0,8,16,24,32,40,48,56
        {
            uint64_t mask = 0;
            if ((player >> 0) & 1)
                for (int c = 0; c < 64 && ((player >> c) & 1); c += 8) mask |= 1ULL << c;
            if ((player >> 56) & 1)
                for (int c = 56; c >= 0 && ((player >> c) & 1); c -= 8) mask |= 1ULL << c;
            count += __builtin_popcountll(mask);
        }
        // Right edge: cells 7,15,23,31,39,47,55,63
        {
            uint64_t mask = 0;
            if ((player >> 7) & 1)
                for (int c = 7; c < 64 && ((player >> c) & 1); c += 8) mask |= 1ULL << c;
            if ((player >> 63) & 1)
                for (int c = 63; c >= 7 && ((player >> c) & 1); c -= 8) mask |= 1ULL << c;
            count += __builtin_popcountll(mask);
        }
        return count;
    }

    // ── Evaluation function ───────────────────────────────────────────
    int evaluate(const OthelloBoard& board, bool isBlack) const {
        uint64_t mine  = isBlack ? board.black : board.white;
        uint64_t opp   = isBlack ? board.white : board.black;
        uint64_t empty = ~(mine | opp);
        int emptyCount = board.emptyCount();

        int posScore = 0;
        uint64_t tmp = mine;
        while (tmp) { int c = __builtin_ctzll(tmp); posScore += POS_WEIGHTS[c]; tmp &= tmp-1; }
        tmp = opp;
        while (tmp) { int c = __builtin_ctzll(tmp); posScore -= POS_WEIGHTS[c]; tmp &= tmp-1; }

        static constexpr int XS[4] = { 9, 14, 49, 54 };
        static constexpr int XC[4] = { 0,  7, 56, 63 };
        for (int i = 0; i < 4; i++) {
            uint64_t xBit = 1ULL << XS[i], cBit = 1ULL << XC[i];
            if ((mine & xBit) && (mine & cBit)) posScore += 40;
            if ((opp  & xBit) && (opp  & cBit)) posScore -= 40;
        }

        int stability = edgeStabilityCount(mine) - edgeStabilityCount(opp);

        int myFront  = frontierCount(mine, empty);
        int oppFront = frontierCount(opp,  empty);
        int frontier = (myFront + oppFront > 0)
                     ? -100 * (myFront - oppFront) / (myFront + oppFront)
                     : 0;

        int myMoves  = __builtin_popcountll(board.getLegalMoves(isBlack));
        int oppMoves = __builtin_popcountll(board.getLegalMoves(!isBlack));
        int mobility = (myMoves + oppMoves > 0)
                     ? 100 * (myMoves - oppMoves) / (myMoves + oppMoves) : 0;

        int discW    = (emptyCount < 20) ? (20 - emptyCount) : 0;
        int discDiff = __builtin_popcountll(mine) - __builtin_popcountll(opp);

        int posW, mobW, frontW, stabW;
        if      (emptyCount > 40) { posW=1; mobW=8; frontW=3; stabW=2; }
        else if (emptyCount > 20) { posW=2; mobW=5; frontW=4; stabW=4; }
        else                      { posW=3; mobW=3; frontW=4; stabW=6; }

        return posScore  * posW
             + mobility  * mobW
             + frontier  * frontW
             + stability * stabW
             + discDiff  * discW;
    }

    // ── Time check ────────────────────────────────────────────────────────────
    bool timeUp() {
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - searchStart).count();
        return elapsed >= timeLimitMs;
    }

    // ── Ordered move iteration ────────────────────────────────────────────────
    // Priority: (1) TT best move, (2) killer moves for this depth,
    // (3) history score descending, (4) static MOVE_ORDER as tiebreaker.
    std::vector<int> orderedMoves(uint64_t legalMask, int ttMove = -1, int depth = -1) const {
        std::vector<int> moves;
        moves.reserve(__builtin_popcountll(legalMask));
        bool inList[64] = {};

        // 1. TT best move.
        if (ttMove >= 0 && ttMove < 64 && (legalMask >> ttMove & 1)) {
            moves.push_back(ttMove);
            inList[ttMove] = true;
        }

        // 2. Killer moves (depth-keyed; promoted above history-sorted moves).
        if (depth >= 0 && depth < 64) {
            for (int k = 0; k < 2; k++) {
                int km = killers[depth][k];
                if (km >= 0 && km < 64 && (legalMask >> km & 1) && !inList[km]) {
                    moves.push_back(km);
                    inList[km] = true;
                }
            }
        }

        // Priority front: TT + killers are already in correct order.
        int priority = (int)moves.size();

        // 3. Remaining moves in static MOVE_ORDER.
        for (int c : MOVE_ORDER)
            if ((legalMask >> c & 1) && !inList[c])
                moves.push_back(c);

        // Sort non-priority section by history score descending.
        // stable_sort preserves MOVE_ORDER as tiebreaker.
        std::stable_sort(moves.begin() + priority, moves.end(),
            [this](int a, int b) { return history[a] > history[b]; });

        return moves;
    }

    // ── Perfect endgame solver ────────────────────────────────────────────────
    int negamaxPerfect(const OthelloBoard& board, bool isBlack, int alpha, int beta) {
        if (timeLimitHit) return 0;
        nodesSearched++;

        if ((nodesSearched & 1023) == 0 && timeUp()) {
            timeLimitHit = true;
            return 0;
        }

        uint64_t key = board.hashKey() ^ (isBlack ? 0xAAAAAAAAAAAAAAAAULL : 0);
        TTEntry* tte = ttLookup(key);
        int ttMove = -1;
        
        if (tte->key == key && tte->depth >= 64) {
            if (tte->flag == 0) return tte->score;
            if (tte->flag == 1) alpha = std::max(alpha, tte->score);
            if (tte->flag == 2) beta  = std::min(beta,  tte->score);
            if (alpha >= beta)  return tte->score;
            ttMove = tte->move;
        } else if (tte->key == key) {
            ttMove = tte->move;
        }

        uint64_t legalMask = board.getLegalMoves(isBlack);

        if (legalMask == 0) {
            if (board.mustPass(!isBlack)) {
                int s = board.score();
                return isBlack ? s : -s; 
            }
            return -negamaxPerfect(board, !isBlack, -beta, -alpha);
        }

        int best = INT_MIN;
        int bestMove = -1;
        int origAlpha = alpha;
        bool firstChild = true;

        for (int cell : orderedMoves(legalMask, ttMove)) {
            int val;
            if (firstChild) {
                // First (best-ordered) child: full-window search.
                val = -negamaxPerfect(board.afterMove(cell, isBlack), !isBlack, -beta, -alpha);
                firstChild = false;
            } else {
                // PVS: null-window probe.
                val = -negamaxPerfect(board.afterMove(cell, isBlack), !isBlack, -(alpha + 1), -alpha);
                // Re-search with full window only if null-window fails high.
                if (!timeLimitHit && val > alpha && val < beta)
                    val = -negamaxPerfect(board.afterMove(cell, isBlack), !isBlack, -beta, -alpha);
            }
            if (timeLimitHit) return 0;
            if (val > best) { best = val; bestMove = cell; }
            if (val > alpha) alpha = val;
            if (alpha >= beta) break;
        }

        if (!timeLimitHit) {
            tte->key   = key;
            tte->score = best;
            tte->depth = 64; 
            tte->move  = (int8_t)(bestMove < 0 ? OthelloBoard::PASS : bestMove);
            tte->flag  = (int8_t)(best <= origAlpha ? 2 : (best >= beta ? 1 : 0));
        }

        return best;
    }

    // ── Negamax alpha-beta ────────────────────────────────────────────────────
    int negamax(const OthelloBoard& board, bool isBlack, int depth, int alpha, int beta, int endgameThresh) {
        if (timeLimitHit) return 0;

        int empty = board.emptyCount();
        if (empty <= endgameThresh && depth >= empty) {
            return negamaxPerfect(board, isBlack, alpha, beta);
        }

        nodesSearched++;

        uint64_t key = board.hashKey() ^ (isBlack ? 0xAAAAAAAAAAAAAAAAULL : 0);
        TTEntry* tte = ttLookup(key);
        int ttMove = -1;
        if (tte->key == key && tte->depth >= depth) {
            if (tte->flag == 0) return tte->score;
            if (tte->flag == 1) alpha = std::max(alpha, tte->score);
            if (tte->flag == 2) beta  = std::min(beta,  tte->score);
            if (alpha >= beta)  return tte->score;
            ttMove = tte->move;
        } else if (tte->key == key) {
            ttMove = tte->move;
        }

        uint64_t legalMask = board.getLegalMoves(isBlack);

        if (legalMask == 0) {
            if (board.mustPass(!isBlack)) {
                int s = board.score();
                int raw = isBlack ? s : -s;
                return raw + (raw > 0 ? 1000 : (raw < 0 ? -1000 : 0));
            }
            return -negamax(board, !isBlack, depth, -beta, -alpha, endgameThresh);
        }

        if (depth == 0) return evaluate(board, isBlack);

        if ((nodesSearched & 1023) == 0 && timeUp()) {
            timeLimitHit = true;
            return 0;
        }

        int best = INT_MIN;
        int bestMove = -1;
        int origAlpha = alpha;
        bool firstChild = true;
        int moveIdx = 0;

        for (int cell : orderedMoves(legalMask, ttMove, depth)) {
            int val;
            if (firstChild) {
                // First (best-ordered) child: full-window, full-depth search.
                val = -negamax(board.afterMove(cell, isBlack), !isBlack, depth - 1, -beta, -alpha, endgameThresh);
                firstChild = false;
            } else {
                // LMR: reduce depth for late, low-priority moves.
                // Applies at depth ≥ 3, after the first 3 moves (TT + 2 killers)
                // have already been tried at full depth.
                bool lmr = depth >= 3 && moveIdx >= 3;
                int d = lmr ? depth - 2 : depth - 1;

                // PVS: null-window probe at possibly reduced depth.
                val = -negamax(board.afterMove(cell, isBlack), !isBlack, d, -(alpha + 1), -alpha, endgameThresh);

                if (!timeLimitHit && val > alpha) {
                    // Promising: if LMR was applied, re-search at full depth with null window.
                    if (lmr)
                        val = -negamax(board.afterMove(cell, isBlack), !isBlack, depth - 1, -(alpha + 1), -alpha, endgameThresh);
                    // If still above alpha and inside beta, do full-window re-search.
                    if (!timeLimitHit && val > alpha && val < beta)
                        val = -negamax(board.afterMove(cell, isBlack), !isBlack, depth - 1, -beta, -alpha, endgameThresh);
                }
            }
            if (timeLimitHit) return 0;
            if (val > best) { best = val; bestMove = cell; }
            if (val > alpha) alpha = val;
            if (alpha >= beta) {
                // Beta cutoff — update history and killer tables.
                history[cell] += depth * depth;
                if (depth < 64 && killers[depth][0] != cell) {
                    killers[depth][1] = killers[depth][0];
                    killers[depth][0] = cell;
                }
                break;
            }
            moveIdx++;
        }

        if (!timeLimitHit) {
            tte->key   = key;
            tte->score = best;
            tte->depth = (int8_t)depth;
            tte->move  = (int8_t)(bestMove < 0 ? OthelloBoard::PASS : bestMove);
            tte->flag  = (int8_t)(best <= origAlpha ? 2 : (best >= beta ? 1 : 0));
        }

        return best;
    }

    // ── Iterative deepening driver ────────────────────────────────────────────
    int getBestMoveAB(const OthelloBoard& board, bool isBlack, int maxDepth, int endgameThresh) {
        uint64_t legalMask = board.getLegalMoves(isBlack);
        if (legalMask == 0) return OthelloBoard::PASS;

        if (__builtin_popcountll(legalMask) == 1)
            return __builtin_ctzll(legalMask);

        // ── Opening book probe ────────────────────────────────────────────────
        // Only active for the first MAX_DEPTH=32 moves (empty ≥ 28).
        // Compute canonical D4 form, look up in book, reverse transform.
        // Sets lastMoveWasBook = true on hit (queried by wasm_wasBookMove).
        lastMoveWasBook = false;
        if (board.emptyCount() >= 28) {
            auto [cb, cw, t] = canonForm(board.black, board.white);
            uint64_t key = OpeningBook::hash_pos(cb, cw);
            int canon_cell  = OpeningBook::lookup(key);
            if (canon_cell >= 0) {
                int actual_cell = applyTransformCell(canon_cell, INVERSE_T[t]);
                if (legalMask >> actual_cell & 1) {
                    lastMoveWasBook = true;
                    return actual_cell;   // instant book move
                }
            }
        }

        ttClear();
        std::fill(std::begin(history), std::end(history), 0);
        std::memset(killers, -1, sizeof(killers));
        int bestMove  = __builtin_ctzll(legalMask);
        int prevScore = 0;   // score from the previous completed iteration

        // Initial aspiration window half-width.
        // Chosen to be wider than typical eval noise at shallow depth but
        // narrow enough to produce meaningful cutoffs in the midgame.
        static constexpr int ASPIRATION_DELTA = 25;

        for (int depth = 1; depth <= maxDepth && !timeLimitHit; depth++) {

            int alpha, beta;

            // Aspiration windows are only useful once the score is stable
            // enough to be predictive.  Use a full window for depth ≤ 3.
            if (depth <= 3 || prevScore == 0) {
                alpha = INT_MIN + 1;
                beta  = INT_MAX;
            } else {
                alpha = prevScore - ASPIRATION_DELTA;
                beta  = prevScore + ASPIRATION_DELTA;
            }

            int bestAtDepth = -1;
            int bestScore   = INT_MIN;
            int delta       = ASPIRATION_DELTA;

            // Re-search loop — widens the window on fail-low / fail-high.
            while (true) {
                bestAtDepth = -1;
                bestScore   = INT_MIN;
                int searchAlpha = alpha;

                bool firstChild = true;
                for (int cell : orderedMoves(legalMask, bestMove)) {
                    int val;
                    if (firstChild) {
                        val = -negamax(board.afterMove(cell, isBlack), !isBlack, depth - 1, -beta, -searchAlpha, endgameThresh);
                        firstChild = false;
                    } else {
                        // PVS: null-window probe.
                        val = -negamax(board.afterMove(cell, isBlack), !isBlack, depth - 1, -(searchAlpha + 1), -searchAlpha, endgameThresh);
                        // Re-search if null-window fails high inside the aspiration window.
                        if (!timeLimitHit && val > searchAlpha && val < beta)
                            val = -negamax(board.afterMove(cell, isBlack), !isBlack, depth - 1, -beta, -searchAlpha, endgameThresh);
                    }
                    if (timeLimitHit) break;
                    if (val > bestScore) { bestScore = val; bestAtDepth = cell; }
                    if (val > searchAlpha) searchAlpha = val;
                }

                if (timeLimitHit) break;

                if (bestScore <= alpha) {
                    // Fail-low: the position is worse than expected.
                    // Widen alpha downward and retry.
                    delta *= 2;
                    alpha = bestScore - delta;
                    if (alpha < INT_MIN + 1) alpha = INT_MIN + 1;
                } else if (bestScore >= beta) {
                    // Fail-high: the position is better than expected.
                    // Widen beta upward and retry.
                    delta *= 2;
                    beta = bestScore + delta;
                    if (beta > INT_MAX) beta = INT_MAX;
                } else {
                    // Score fell inside the window — search succeeded.
                    break;
                }

                // Safety: if window has expanded to full range, just accept.
                if (alpha <= INT_MIN + 1 && beta >= INT_MAX) break;
            }

            if (!timeLimitHit && bestAtDepth >= 0) {
                bestMove  = bestAtDepth;
                prevScore = bestScore;
            }
        }

        return bestMove;
    }
};
