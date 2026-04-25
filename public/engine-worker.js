/* engine-worker.js — Web Worker that owns the WASM Othello engine
 *
 * Protocol (postMessage both directions):
 *
 *   OUT on ready:
 *     { id: 0, type: 'ready' }
 *     { id: 0, type: 'ready', error: 'message' }   ← on failure
 *
 *   IN  for a move:
 *     { id, type: 'getBestMove',
 *       payload: { cells: number[64], isBlack: bool, difficulty: 0|1|2 } }
 *   OUT for a move:
 *     { id, type: 'bestMove', payload: { move: number } }
 *     { id, error: 'message' }                      ← on failure
 *
 * Why a Worker?
 *   Alpha-beta for Hard difficulty can take 2–3 seconds. Running it in a
 *   Worker keeps the main thread (and the board UI) fully responsive.
 *   Unlike TENGEN5, no pthreads are needed — the search is single-threaded.
 */

const CELLS = 64;

let engine = null;  // WASM module instance
let bufPtr  = null; // malloc'd Int32[64] in WASM heap
                    // (no cached view — HEAP32 accessed live to survive memory growth)

// Resolve WASM assets relative to THIS worker's URL, not the page URL.
const BASE = self.location.href.replace(/[^/]*$/, '');

async function init() {
  try {
    importScripts(`${BASE}engine.js`);

    engine = await createEngineModule({
      locateFile: path => `${BASE}${path}`,
    });

    engine.ccall('wasm_init', null, [], []);

    bufPtr = engine._malloc(CELLS * 4);
    // Do NOT cache a typed-array view here — if WASM memory grows the
    // underlying ArrayBuffer changes and any cached view becomes detached.
    // Instead we write via engine.HEAP32 live in every message handler.

    self.postMessage({ id: 0, type: 'ready' });
  } catch (err) {
    self.postMessage({ id: 0, type: 'ready', error: String(err) });
  }
}

self.onmessage = function ({ data }) {
  const { id, type, payload } = data;
  try {
    if (type === 'getBestMove') {
      const { cells, isBlack, difficulty } = payload;

      // Write board into WASM heap (live access, safe after memory growth)
      const base = bufPtr >> 2;  // byte offset → Int32 index
      for (let i = 0; i < CELLS; i++) engine.HEAP32[base + i] = cells[i];

      // Run alpha-beta search (or instant book lookup).
      // Return value encoding:
      //   bits 0-6 : move cell (0-63) or 64 (PASS) or -1 (error)
      //   bit  8   : set if the move came from the opening book
      const raw      = engine.ccall(
        'wasm_getBestMove', 'number',
        ['number', 'number', 'number'],
        [bufPtr, isBlack ? 1 : 0, difficulty]
      );

      const fromBook = (raw & 0x100) !== 0;
      const move     = raw & ~0x100;   // strip book flag → clean cell index

      self.postMessage({ id, type: 'bestMove', payload: { move, fromBook } });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};

init();
