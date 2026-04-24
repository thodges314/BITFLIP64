// ============================================================================
// app.js — Bitflip-64 Othello — Game Controller
//
// Architecture:
//   WASM engine (alpha-beta) runs in engine-worker.js Web Worker.
//   Main thread sends/receives via workerRequest(type, payload) → Promise.
//   Board state kept as cells[64]: 0=empty, 1=Black, 2=White.
//   JS handles: legal move detection, flip computation, flip animation,
//               auto-pass, score display, game lifecycle.
// ============================================================================

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const BOARD_SIZE = 8;
const CELLS      = 64;
const PASS_MOVE  = 64;

// ── DOM references ─────────────────────────────────────────────────────────────
const boardEl      = document.getElementById('board');
const boardWrap    = document.getElementById('board-wrap');
const sideSelect   = document.getElementById('side-select');
const statusBar    = document.getElementById('status-bar');
const moveInfoEl   = document.getElementById('move-info');
const engineStatus = document.getElementById('engine-status');
const blackCountEl = document.getElementById('black-count');
const whiteCountEl = document.getElementById('white-count');
const resignBtn    = document.getElementById('resign-btn');
const replayBtn    = document.getElementById('replay-btn');
const modalBackdrop = document.getElementById('modal-backdrop');
const modalIcon    = document.getElementById('modal-icon');
const modalTitle   = document.getElementById('modal-title');
const modalSubtitle = document.getElementById('modal-subtitle');
const modalScore   = document.getElementById('modal-score-chip');
const modalMethod  = document.getElementById('modal-method');
const subtitle     = document.getElementById('subtitle');

// ── Game state ────────────────────────────────────────────────────────────────
let cells       = new Array(CELLS).fill(0);
let humanPlayer = 1;     // 1=Black, 2=White
let cpuPlayer   = 2;
let gameOver    = false;
let difficulty  = 1;     // 0=Easy 1=Medium 2=Hard
let moveHistory = [];

// ── Engine Worker ─────────────────────────────────────────────────────────────
let engineWorker  = null;
let engineReady   = false;
let _workerPending = {};
let _workerNextId  = 1;

function workerRequest(type, payload) {
  return new Promise((resolve, reject) => {
    const id = _workerNextId++;
    _workerPending[id] = { resolve, reject };
    engineWorker.postMessage({ id, type, payload });
  });
}

function onWorkerMessage({ data }) {
  const pending = _workerPending[data.id];
  if (!pending) return;
  delete _workerPending[data.id];
  if (data.error) pending.reject(new Error(data.error));
  else            pending.resolve(data.payload);
}

// ── Sound FX ──────────────────────────────────────────────────────────────────
const SoundFX = {
  ctx: null,
  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  playTone(freq, type, duration, vol = 0.18, sweep = 0) {
    if (!this.ctx) return;
    const osc  = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain); gain.connect(this.ctx.destination);
    osc.type            = type;
    osc.frequency.value = freq;
    if (sweep) osc.frequency.linearRampToValueAtTime(freq + sweep, this.ctx.currentTime + duration);
    gain.gain.setValueAtTime(vol, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    osc.start(); osc.stop(this.ctx.currentTime + duration);
  },
  playPlace()  { this.playTone(600, 'sine',     0.07, 0.15); },
  playCpu()    { this.playTone(380, 'triangle', 0.10, 0.12); },
  playFlip()   { this.playTone(440, 'sine',     0.06, 0.08, 60); },
  playPass()   { this.playTone(330, 'sine',     0.18, 0.12); },
  playWin()    {
    [523, 659, 784].forEach((f, i) =>
      setTimeout(() => this.playTone(f, 'sine', 0.25, 0.2), i * 110));
  },
  playLoss()   { this.playTone(240, 'sawtooth', 0.5,  0.15, -80); },
  playDraw()   {
    this.playTone(400, 'square', 0.15, 0.1);
    setTimeout(() => this.playTone(400, 'square', 0.15, 0.1), 200);
  },
};

// ── Difficulty selector ───────────────────────────────────────────────────────
document.querySelectorAll('.diff-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    difficulty = parseInt(btn.dataset.diff, 10);
  });
});

// ── Pure-JS Othello logic ─────────────────────────────────────────────────────
// Used for legal move highlighting and flip animation — avoids extra WASM round-trips.

const DIRS = [[-1,0],[1,0],[0,-1],[0,1],[-1,1],[-1,-1],[1,1],[1,-1]];

function isLegalMove(cells, idx, player) {
  if (cells[idx] !== 0) return false;
  const opp = player === 1 ? 2 : 1;
  const row = Math.floor(idx / BOARD_SIZE);
  const col = idx % BOARD_SIZE;
  for (const [dr, dc] of DIRS) {
    let r = row + dr, c = col + dc, found = false;
    while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && cells[r*BOARD_SIZE+c] === opp) {
      r += dr; c += dc; found = true;
    }
    if (found && r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && cells[r*BOARD_SIZE+c] === player)
      return true;
  }
  return false;
}

function getLegalMovesJS(cells, player) {
  const legal = [];
  for (let i = 0; i < CELLS; i++)
    if (isLegalMove(cells, i, player)) legal.push(i);
  return legal;
}

// Applies disc placement to newCells in-place; returns array of flipped cell indices.
function applyMoveJS(cells, idx, player) {
  if (idx === PASS_MOVE) return { newCells: [...cells], flipped: [] };
  const newCells = [...cells];
  const opp = player === 1 ? 2 : 1;
  const row = Math.floor(idx / BOARD_SIZE);
  const col = idx % BOARD_SIZE;
  const flipped = [];
  newCells[idx] = player;
  for (const [dr, dc] of DIRS) {
    const line = [];
    let r = row + dr, c = col + dc;
    while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && newCells[r*BOARD_SIZE+c] === opp) {
      line.push(r*BOARD_SIZE+c); r += dr; c += dc;
    }
    if (line.length > 0 && r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && newCells[r*BOARD_SIZE+c] === player) {
      for (const cell of line) { newCells[cell] = player; flipped.push(cell); }
    }
  }
  return { newCells, flipped };
}

// ── Status helpers ─────────────────────────────────────────────────────────────
function setStatus(msg, cls = '') {
  if (cls === 'cpu-turn') {
    statusBar.innerHTML = msg +
      ' <span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>';
  } else {
    statusBar.textContent = msg;
  }
  statusBar.className = 'status-bar ' + cls;
}

function setMoveInfo(text) {
  moveInfoEl.textContent = text;
  moveInfoEl.classList.remove('update');
  void moveInfoEl.offsetWidth;
  moveInfoEl.classList.add('update');
}

// ── Board building ─────────────────────────────────────────────────────────────
function buildBoard() {
  boardEl.innerHTML = '';
  for (let i = 0; i < CELLS; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.id = `cell-${i}`;
    cell.addEventListener('click', () => onCellClick(i));
    boardEl.appendChild(cell);
  }
}

// ── Render board ──────────────────────────────────────────────────────────────
// animFlips: Set of cell indices that should play a flip animation this turn.
// animNew:   Set of cell indices for newly placed discs (place animation).
function renderBoard(animFlips = new Set(), animNew = new Set()) {
  const legalMoves = !gameOver ? new Set(getLegalMovesJS(cells, humanPlayer)) : new Set();
  const cpuLegal   = !gameOver ? getLegalMovesJS(cells, cpuPlayer).length > 0 : false;

  for (let i = 0; i < CELLS; i++) {
    const cell = document.getElementById(`cell-${i}`);
    cell.innerHTML = '';
    const v = cells[i];

    if (v !== 0) {
      const disc = document.createElement('div');
      disc.className = `disc ${v === 1 ? 'b-disc' : 'w-disc'}`;

      if (animFlips.has(i)) {
        // Flip animation: was opponent, now player color
        disc.classList.add(v === 1 ? 'anim-flip-wb' : 'anim-flip-bw');
        SoundFX.playFlip();
      } else if (animNew.has(i)) {
        disc.classList.add('anim-place');
      }
      cell.appendChild(disc);
      cell.classList.remove('hoverable');
    } else if (!gameOver && legalMoves.has(i)) {
      // Legal move dot
      const dot = document.createElement('div');
      dot.className = 'legal-dot';
      cell.appendChild(dot);
      cell.classList.add('hoverable');
    } else {
      cell.classList.remove('hoverable');
    }
  }

  // Update disc counts
  const bCount = cells.filter(c => c === 1).length;
  const wCount = cells.filter(c => c === 2).length;
  blackCountEl.textContent = bCount;
  whiteCountEl.textContent = wCount;
}

function markThinking() {
  document.querySelector('.board-outer')?.classList.add('thinking-active');
  document.querySelectorAll('.cell').forEach(c => c.classList.add('thinking'));
  resignBtn.disabled = true;
}

function unmarkThinking() {
  document.querySelector('.board-outer')?.classList.remove('thinking-active');
  document.querySelectorAll('.cell').forEach(c => c.classList.remove('thinking'));
  resignBtn.disabled = false;
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function showModal({ icon, title, subtitle: sub, scoreText, scoreClass, method }) {
  modalIcon.textContent    = icon;
  modalTitle.textContent   = title;
  modalSubtitle.textContent = sub;
  modalScore.textContent   = scoreText;
  modalScore.className     = 'modal-score-chip ' + (scoreClass || '');
  modalMethod.textContent  = method || '';
  modalBackdrop.hidden = false;
}
function closeModal() { modalBackdrop.hidden = true; }

// ── End game ──────────────────────────────────────────────────────────────────
function endGame(method = 'score') {
  gameOver = true;
  renderBoard();

  const bCount = cells.filter(c => c === 1).length;
  const wCount = cells.filter(c => c === 2).length;
  const blackWins = method === 'resignation' ? (humanPlayer === 2) : bCount > wCount;
  const whiteWins = method === 'resignation' ? (humanPlayer === 1) : wCount > bCount;
  const draw      = method !== 'resignation' && bCount === wCount;
  const humanWins = (blackWins && humanPlayer === 1) || (whiteWins && humanPlayer === 2);

  let scoreText, scoreClass;
  if (draw) {
    SoundFX.playDraw();
    setStatus('Draw — perfectly balanced!', 'draw');
    scoreText = 'Tied · ' + bCount + ' – ' + wCount;
    scoreClass = 'draw';
  } else if (humanWins) {
    SoundFX.playWin();
    const leader = blackWins ? 'Black' : 'White';
    const extra  = bCount > wCount ? bCount + ' – ' + wCount : wCount + ' – ' + bCount;
    setStatus(method === 'resignation' ? 'Computer resigns — you win! 🎉'
                                       : `You win! 🎉  ${extra}`,
              blackWins ? 'b-wins' : 'w-wins');
    scoreText  = (blackWins ? 'Black' : 'White') + '  ' + (bCount > wCount ? bCount : wCount) +
                 ' – ' + (bCount > wCount ? wCount : bCount);
    scoreClass = blackWins ? 'b-wins' : 'w-wins';
  } else {
    SoundFX.playLoss();
    const extra = bCount > wCount ? bCount + ' – ' + wCount : wCount + ' – ' + bCount;
    setStatus(method === 'resignation' ? 'You resigned — computer wins'
                                       : `Computer wins — ${extra}`,
              blackWins ? 'b-wins' : 'w-wins');
    scoreText  = (blackWins ? 'Black' : 'White') + '  ' + (bCount > wCount ? bCount : wCount) +
                 ' – ' + (bCount > wCount ? wCount : bCount);
    scoreClass = blackWins ? 'b-wins' : 'w-wins';
  }

  resignBtn.disabled = true;
  replayBtn.hidden   = false;

  setTimeout(() => {
    if (draw) {
      showModal({
        icon: '🤝', title: 'Draw!',
        subtitle: bCount + ' discs each — a perfect game.',
        scoreText, scoreClass: 'draw',
        method: 'Final score · Disc count',
      });
    } else if (humanWins) {
      showModal({
        icon: '🏆', title: 'You Win!',
        subtitle: method === 'resignation'
          ? 'The computer resigned — well played!'
          : 'You outflipped the AI!',
        scoreText, scoreClass,
        method: method === 'resignation' ? 'Win by resignation' : 'Final score · Disc count',
      });
    } else {
      showModal({
        icon: '🤖', title: 'Computer Wins',
        subtitle: method === 'resignation'
          ? 'You resigned. Try again!'
          : 'The AI outflipped you this time.',
        scoreText, scoreClass,
        method: method === 'resignation' ? 'Win by resignation' : 'Final score · Disc count',
      });
    }
  }, 400);
}

// ── Check game over ───────────────────────────────────────────────────────────
function checkGameOver() {
  const bCanMove = getLegalMovesJS(cells, 1).length > 0;
  const wCanMove = getLegalMovesJS(cells, 2).length > 0;
  if (!bCanMove && !wCanMove) {
    endGame('score');
    return true;
  }
  return false;
}

// ── CPU turn ──────────────────────────────────────────────────────────────────
async function cpuTurn() {
  if (gameOver) return;

  // Check if CPU must pass
  if (getLegalMovesJS(cells, cpuPlayer).length === 0) {
    SoundFX.playPass();
    setMoveInfo('⏭ Computer has no moves — passes');
    setStatus('Your turn', 'your-turn');
    if (checkGameOver()) return;
    return;
  }

  setStatus('Thinking…', 'cpu-turn');
  markThinking();
  await new Promise(r => setTimeout(r, 40));

  const t0 = performance.now();

  let move = -1;
  try {
    const result = await workerRequest('getBestMove', {
      cells:      [...cells],
      isBlack:    cpuPlayer === 1,
      difficulty,
    });
    move = result.move;
  } catch (err) {
    console.error('Worker error:', err);
    move = -1;
  }

  const ms = Math.round(performance.now() - t0);
  unmarkThinking();

  if (move < 0) { setStatus('Engine error', ''); return; }

  if (move === PASS_MOVE) {
    SoundFX.playPass();
    moveHistory.push({ player: cpuPlayer, move: PASS_MOVE });
    setMoveInfo(`⏭ Computer passes · ${ms} ms`);
    if (checkGameOver()) return;
    setStatus('Your turn — computer passed', 'your-turn');
    return;
  }

  // Apply CPU move with flip animation
  const { newCells, flipped } = applyMoveJS(cells, move, cpuPlayer);
  const newSet    = new Set([move]);
  const flipSet   = new Set(flipped);
  cells = newCells;
  moveHistory.push({ player: cpuPlayer, move });

  SoundFX.playCpu();
  const diffLabel = ['Easy','Medium','Hard'][difficulty];
  setMoveInfo(`🤖 CPU (${diffLabel}) · ${ms} ms · ${flipped.length} flip${flipped.length !== 1 ? 's' : ''}`);

  renderBoard(flipSet, newSet);

  if (checkGameOver()) return;

  // Check if human must pass
  if (getLegalMovesJS(cells, humanPlayer).length === 0) {
    SoundFX.playPass();
    setMoveInfo('⏭ You have no moves — auto-pass');
    setStatus('Thinking…', 'cpu-turn');
    setTimeout(cpuTurn, 800);
    return;
  }

  setStatus('Your turn', 'your-turn');
}

// ── Human move ────────────────────────────────────────────────────────────────
function onCellClick(idx) {
  if (!engineReady || gameOver) return;
  if (!isLegalMove(cells, idx, humanPlayer)) return;

  const { newCells, flipped } = applyMoveJS(cells, idx, humanPlayer);
  const newSet  = new Set([idx]);
  const flipSet = new Set(flipped);
  cells = newCells;
  moveHistory.push({ player: humanPlayer, move: idx });

  SoundFX.playPlace();
  setMoveInfo(`▶ You played ${cellLabel(idx)} · ${flipped.length} flip${flipped.length !== 1 ? 's' : ''}`);
  renderBoard(flipSet, newSet);

  if (checkGameOver()) return;
  setStatus('Thinking…', 'cpu-turn');
  setTimeout(cpuTurn, 60);
}

// Human resign
function onHumanResign() {
  if (!engineReady || gameOver) return;
  endGame('resignation');
}

// Convenient cell label (e.g. "d4")
function cellLabel(idx) {
  const col = idx % BOARD_SIZE;
  const row = Math.floor(idx / BOARD_SIZE);
  return String.fromCharCode(97 + col) + (row + 1);
}

// ── Game lifecycle ────────────────────────────────────────────────────────────
function startGame(human) {
  SoundFX.init();
  humanPlayer = human;
  cpuPlayer   = human === 1 ? 2 : 1;

  // Standard Othello start
  cells = new Array(CELLS).fill(0);
  cells[27] = 2; cells[36] = 2;  // White: d4, e5
  cells[28] = 1; cells[35] = 1;  // Black: e4, d5

  gameOver    = false;
  moveHistory = [];

  const diffLabel = ['Easy','Medium','Hard'][difficulty];
  const color     = human === 1 ? 'Black' : 'White';
  subtitle.textContent = `Alpha-Beta AI · ${diffLabel} · Play as ${color}`;

  closeModal();
  sideSelect.hidden = false;
  boardWrap.hidden  = false;
  sideSelect.hidden = true;
  replayBtn.hidden  = true;
  resignBtn.disabled = false;

  buildBoard();
  renderBoard();

  if (cpuPlayer === 1) {
    setStatus('Thinking…', 'cpu-turn');
    setTimeout(cpuTurn, 80);
  } else {
    setStatus('Your turn — you play Black, go first', 'your-turn');
  }
}

function resetToSideSelect() {
  closeModal();
  boardWrap.hidden  = true;
  sideSelect.hidden = false;
  subtitle.textContent = 'Alpha-Beta AI · Perfect Endgame Solver · Play as —';
}

// ── Engine init ───────────────────────────────────────────────────────────────
async function initEngine() {
  try {
    // Note: COI ServiceWorker is loaded but alpha-beta is single-threaded,
    // so crossOriginIsolated is not strictly required. We skip the reload
    // check from TENGEN5 since there are no pthreads.
    engineWorker = new Worker('public/engine-worker.js');

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Engine Worker init timeout (30 s)')), 30_000
      );
      engineWorker.onerror = err => {
        clearTimeout(timeout);
        reject(new Error(err.message ?? 'Worker error'));
      };
      engineWorker.onmessage = function ({ data }) {
        if (data.type === 'ready') {
          clearTimeout(timeout);
          engineWorker.onmessage = onWorkerMessage;
          data.error ? reject(new Error(data.error)) : resolve();
        }
      };
    });

    engineStatus.textContent = 'Engine ready';
    engineStatus.className   = 'engine-status ready';
    engineReady = true;

  } catch (err) {
    engineStatus.textContent = `Engine failed: ${err.message}`;
    engineStatus.className   = 'engine-status error';
    console.error('Engine init error:', err);
  }
}

initEngine();
