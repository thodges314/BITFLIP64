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
const CELLS = 64;
const PASS_MOVE = 64;

// ── DOM references ─────────────────────────────────────────────────────────────
const boardEl = document.getElementById('board');
const boardWrap = document.getElementById('board-wrap');
const sideSelect = document.getElementById('side-select');
const statusBar = document.getElementById('status-bar');
const moveInfoEl = document.getElementById('move-info');
const engineStatus = document.getElementById('engine-status');
const blackCountEl = document.getElementById('black-count');
const whiteCountEl = document.getElementById('white-count');
const resignBtn = document.getElementById('resign-btn');
const replayBtn = document.getElementById('replay-btn');
const modalBackdrop = document.getElementById('modal-backdrop');
const modalIcon = document.getElementById('modal-icon');
const modalTitle = document.getElementById('modal-title');
const modalSubtitle = document.getElementById('modal-subtitle');
const modalScore = document.getElementById('modal-score-chip');
const modalMethod = document.getElementById('modal-method');
const subtitle = document.getElementById('subtitle');

// ── Game state ────────────────────────────────────────────────────────────────
let cells = new Array(CELLS).fill(0);
let humanPlayer = 1;     // 1=Black, 2=White
let cpuPlayer = 2;
let gameOver = false;
let difficulty = 1;     // 0=Easy 1=Medium 2=Hard
let moveHistory = [];
let lastMove = -1;    // index of the most recently played cell (-1 = none)

// ── Engine Worker ─────────────────────────────────────────────────────────────
let engineWorker = null;
let engineReady = false;
let _workerPending = {};
let _workerNextId = 1;

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
  else pending.resolve(data.payload);
}

// ── Sound FX ──────────────────────────────────────────────────────────────────
const SoundFX = {
  ctx: null,
  enabled: true,   // toggled by the SFX button
  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  playTone(freq, type, duration, vol = 0.18, sweep = 0) {
    if (!this.enabled || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain); gain.connect(this.ctx.destination);
    osc.type = type;
    osc.frequency.value = freq;
    if (sweep) osc.frequency.linearRampToValueAtTime(freq + sweep, this.ctx.currentTime + duration);
    gain.gain.setValueAtTime(vol, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    osc.start(); osc.stop(this.ctx.currentTime + duration);
  },
  playPlace() { this.playTone(600, 'sine', 0.07, 0.15); },
  playCpu() { this.playTone(380, 'triangle', 0.10, 0.12); },
  playFlip() { this.playTone(440, 'sine', 0.06, 0.08, 60); },
  playPass() { this.playTone(330, 'sine', 0.18, 0.12); },
  playWin() {
    [523, 659, 784].forEach((f, i) =>
      setTimeout(() => this.playTone(f, 'sine', 0.25, 0.2), i * 110));
  },
  playLoss() { this.playTone(240, 'sawtooth', 0.5, 0.15, -80); },
  playDraw() {
    this.playTone(400, 'square', 0.15, 0.1);
    setTimeout(() => this.playTone(400, 'square', 0.15, 0.1), 200);
  },
};

// ── Cyber-baroque Music Engine ────────────────────────────────────────────────
// Bach-style D-minor toccata, techno tempo. Sixteenth-note scalar runs
// in the RH (square waves) over a driving quarter-note sawtooth bass.
// Progression: Dm | C | Gm | A (harmonic minor, 4-bar loop x 2 = 8 bars).
const MusicEngine = {
  ctx: null,
  masterGain: null,
  enabled: false,

  BPM: 132,
  get QL() { return 60 / this.BPM; },           // quarter-note (s)
  get S16() { return this.QL / 4; },              // sixteenth-note (s) ← melody unit

  // ── 64 sixteenth-note melody (4 bars at 132BPM) ───────────────────────────
  // Inspired by Bach’s toccata style: scale runs, broken thirds, cadential turns.
  // Bar 1 (Dm): rising D minor scale D4→D5, then falling back
  // Bar 2 (C):  C major arpeggio + turn figures
  // Bar 3 (Gm): G minor arpeggio run
  // Bar 4 (A):  A major dominant resolution with C# (harmonic minor)
  MELODY: [
    // Bar 1 — D minor ascending scale run
    293.66, 329.63, 349.23, 392.00, 440.00, 466.16, 523.25, 587.33,
    // Bar 1 — descend with passing notes
    523.25, 466.16, 440.00, 392.00, 349.23, 329.63, 293.66, 261.63,
    // Bar 2 — C major broken chord + sequence figure
    261.63, 329.63, 392.00, 523.25, 392.00, 329.63, 261.63, 196.00,
    // Bar 2 — return upward with approachnotes
    261.63, 349.23, 440.00, 523.25, 466.16, 392.00, 349.23, 261.63,
    // Bar 3 — G minor arpeggio + scale fragment
    196.00, 233.08, 293.66, 349.23, 392.00, 349.23, 293.66, 233.08,
    // Bar 3 — rising sequence (Gm→Dm) broken thirds
    293.66, 349.23, 329.63, 392.00, 392.00, 466.16, 440.00, 523.25,
    // Bar 4 — A major cadence: scale run up to E5 with C# (harmonic minor)
    220.00, 277.18, 329.63, 440.00, 329.63, 277.18, 369.99, 440.00,
    // Bar 4 — final flourish descending to low D (toccata ending gesture)
    440.00, 554.37, 493.88, 440.00, 392.00, 329.63, 277.18, 220.00,
  ],

  // ── 16 quarter-note bass (4 bars) ─────────────────────────────────────
  // Organum + walking bass: each beat gets one note, driving forward motion.
  BASS: [
    73.42, 87.31, 55.00, 73.42,   // Bar 1 Dm: D2 F2 A1 D2
    65.41, 82.41, 65.41, 49.00,   // Bar 2 C:  C2 E2 C2 G1
    49.00, 58.27, 73.42, 98.00,   // Bar 3 Gm: G1 Bb1 D2 G2
    55.00, 69.30, 55.00, 110.00,   // Bar 4 A:  A1 C#2 A1 A2 (dominant)
  ],

  pos: 0,
  nextTime: 0,
  timerID: null,

  start() {
    if (!SoundFX.ctx) SoundFX.init();
    this.ctx = SoundFX.ctx;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.001, this.ctx.currentTime);
    this.masterGain.gain.linearRampToValueAtTime(0.35, this.ctx.currentTime + 1.5);
    this.masterGain.connect(this.ctx.destination);
    this.pos = 0;
    this.nextTime = this.ctx.currentTime + 0.08;
    this.enabled = true;
    this._tick();
  },

  stop() {
    this.enabled = false;
    clearTimeout(this.timerID);
    if (this.masterGain) {
      const t = this.ctx.currentTime;
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, t);
      this.masterGain.gain.linearRampToValueAtTime(0.001, t + 0.6);
      const mg = this.masterGain; this.masterGain = null;
      setTimeout(() => { try { mg.disconnect(); } catch (e) { } }, 700);
    }
  },

  _tick() {
    if (!this.enabled) return;
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      const i = this.pos;
      this._playMelody(this.MELODY[i], this.nextTime);
      // Bass every quarter note (every 4 sixteenth notes)
      if (i % 4 === 0) {
        this._playBass(this.BASS[Math.floor(i / 4)], this.nextTime);
        this._playBeat(this.nextTime);
      }
      this.nextTime += this.S16;
      this.pos = (i + 1) % 64;
    }
    this.timerID = setTimeout(() => this._tick(), 20);
  },

  // Square-wave melody: very short staccato (harpsichord chop), slight detune
  _playMelody(freq, time) {
    if (!freq || !this.masterGain) return;
    const dur = this.S16 * 0.48;  // tight staccato — leaves space between notes
    [[0, 0.065], [11, 0.028]].forEach(([det, vol]) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'square'; osc.frequency.value = freq; osc.detune.value = det;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.001, time);
      g.gain.linearRampToValueAtTime(vol, time + 0.003);
      g.gain.exponentialRampToValueAtTime(0.001, time + dur);
      osc.connect(g); g.connect(this.masterGain);
      osc.start(time); osc.stop(time + dur + 0.008);
    });
  },

  // Filtered sawtooth bass: punchy attack, quick decay — drives the techno feel
  _playBass(freq, time) {
    if (!freq || !this.masterGain) return;
    const dur = this.QL * 0.78;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth'; osc.frequency.value = freq;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 300; lp.Q.value = 2.2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, time);
    g.gain.linearRampToValueAtTime(0.50, time + 0.010);
    g.gain.exponentialRampToValueAtTime(0.08, time + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    osc.connect(lp); lp.connect(g); g.connect(this.masterGain);
    osc.start(time); osc.stop(time + dur + 0.01);
  },

  // Techno beat pulse: short sine-sweep kick on every quarter note
  _playBeat(time) {
    if (!this.masterGain) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, time);
    osc.frequency.exponentialRampToValueAtTime(55, time + 0.055);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.38, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.07);
    osc.connect(g); g.connect(this.masterGain);
    osc.start(time); osc.stop(time + 0.08);
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

// ── Audio toggle controls ─────────────────────────────────────────────────────
const sfxToggle = document.getElementById('sfx-toggle');
const musicToggle = document.getElementById('music-toggle');
const probcutToggle = document.getElementById('probcut-toggle');
const sfxIcon = document.getElementById('sfx-icon');
const musicIcon = document.getElementById('music-icon');
let useProbCut = true;

sfxToggle.addEventListener('click', () => {
  SoundFX.enabled = !SoundFX.enabled;
  sfxToggle.classList.toggle('active', SoundFX.enabled);
  sfxIcon.textContent = SoundFX.enabled ? '🔊' : '🔇';
});

musicToggle.addEventListener('click', () => {
  if (MusicEngine.enabled) {
    MusicEngine.stop();
    musicToggle.classList.remove('active');
    musicIcon.textContent = '🎵';
  } else {
    MusicEngine.start();
    musicToggle.classList.add('active');
    musicIcon.textContent = '🎶';
  }
});

probcutToggle.addEventListener('click', () => {
  useProbCut = !useProbCut;
  probcutToggle.classList.toggle('active', useProbCut);
});

// ── Pure-JS Othello logic ─────────────────────────────────────────────────────
// Used for legal move highlighting and flip animation — avoids extra WASM round-trips.

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, 1], [-1, -1], [1, 1], [1, -1]];

function isLegalMove(cells, idx, player) {
  if (cells[idx] !== 0) return false;
  const opp = player === 1 ? 2 : 1;
  const row = Math.floor(idx / BOARD_SIZE);
  const col = idx % BOARD_SIZE;
  for (const [dr, dc] of DIRS) {
    let r = row + dr, c = col + dc, found = false;
    while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && cells[r * BOARD_SIZE + c] === opp) {
      r += dr; c += dc; found = true;
    }
    if (found && r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && cells[r * BOARD_SIZE + c] === player)
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
    while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && newCells[r * BOARD_SIZE + c] === opp) {
      line.push(r * BOARD_SIZE + c); r += dr; c += dc;
    }
    if (line.length > 0 && r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && newCells[r * BOARD_SIZE + c] === player) {
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

      // Last-move red dot marker
      if (i === lastMove) {
        const marker = document.createElement('div');
        marker.className = 'last-move-dot';
        disc.appendChild(marker);
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
  modalIcon.textContent = icon;
  modalTitle.textContent = title;
  modalSubtitle.textContent = sub;
  modalScore.textContent = scoreText;
  modalScore.className = 'modal-score-chip ' + (scoreClass || '');
  modalMethod.textContent = method || '';
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
  const draw = method !== 'resignation' && bCount === wCount;
  const humanWins = (blackWins && humanPlayer === 1) || (whiteWins && humanPlayer === 2);

  let scoreText, scoreClass;
  if (draw) {
    SoundFX.playDraw();
    setStatus('Draw — perfectly balanced!', 'draw');
    scoreText = 'Tied · ' + bCount + ' – ' + wCount;
    scoreClass = 'draw';
  } else if (humanWins) {
    SoundFX.playWin();
    const extra = bCount > wCount ? bCount + ' – ' + wCount : wCount + ' – ' + bCount;
    setStatus(method === 'resignation' ? 'Computer resigns — you win! 🎉'
      : `You win! 🎉  ${extra}`,
      blackWins ? 'b-wins' : 'w-wins');
    scoreText = (blackWins ? 'Black' : 'White') + '  ' + (bCount > wCount ? bCount : wCount) +
      ' – ' + (bCount > wCount ? wCount : bCount);
    scoreClass = blackWins ? 'b-wins' : 'w-wins';
  } else {
    SoundFX.playLoss();
    const extra = bCount > wCount ? bCount + ' – ' + wCount : wCount + ' – ' + bCount;
    setStatus(method === 'resignation' ? 'You resigned — computer wins'
      : `Computer wins — ${extra}`,
      blackWins ? 'b-wins' : 'w-wins');
    scoreText = (blackWins ? 'Black' : 'White') + '  ' + (bCount > wCount ? bCount : wCount) +
      ' – ' + (bCount > wCount ? wCount : bCount);
    scoreClass = blackWins ? 'b-wins' : 'w-wins';
  }

  resignBtn.disabled = true;
  replayBtn.hidden = false;

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

  // ── JS fast-check: if JS also finds no CPU moves, skip WASM call ────────────
  if (getLegalMovesJS(cells, cpuPlayer).length === 0) {
    SoundFX.playPass();
    setMoveInfo('⏭ Computer has no moves — passes');
    if (getLegalMovesJS(cells, humanPlayer).length === 0) { endGame('score'); return; }
    renderBoard();
    setStatus('Your turn — computer passed', 'your-turn');
    return;
  }

  setStatus('Thinking…', 'cpu-turn');
  markThinking();
  await new Promise(r => setTimeout(r, 40));

  const t0 = performance.now();

  let move = -1;
  let fromBook = false;
  try {
    const result = await workerRequest('getBestMove', {
      cells: [...cells],
      isBlack: cpuPlayer === 1,
      difficulty,
      useProbCut,
    });
    move     = result.move;
    fromBook = result.fromBook === true;
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
    // If human also has no moves, game ends (board is stuck).
    // Check directly; don't rely on JS/WASM consistency via checkGameOver().
    if (getLegalMovesJS(cells, humanPlayer).length === 0) { endGame('score'); return; }
    renderBoard();   // refresh legal-move dots for human
    setStatus('Your turn — computer passed', 'your-turn');
    return;
  }

  // Apply CPU move with flip animation.
  // Guard: if JS finds 0 flips for the WASM-chosen move, the engines have
  // diverged (JS/WASM mismatch). Treat as a CPU pass rather than silently
  // placing a disc without flipping — which corrupts the board state.
  const { newCells, flipped } = applyMoveJS(cells, move, cpuPlayer);
  if (flipped.length === 0) {
    console.warn(`[Bitflip-64] WASM/JS mismatch: WASM chose cell ${move} but JS finds 0 flips. Treating as CPU pass.`);
    SoundFX.playPass();
    moveHistory.push({ player: cpuPlayer, move: PASS_MOVE });
    setMoveInfo(`⏭ Computer passes · ${ms} ms`);
    if (getLegalMovesJS(cells, humanPlayer).length === 0) { endGame('score'); return; }
    renderBoard();
    setStatus('Your turn — computer passed', 'your-turn');
    return;
  }

  const newSet = new Set([move]);
  const flipSet = new Set(flipped);
  cells = newCells;
  lastMove = move;
  moveHistory.push({ player: cpuPlayer, move });

  SoundFX.playCpu();
  const diffLabel  = ['Easy', 'Medium', 'Hard'][difficulty];
  const sourceBadge = fromBook
    ? '📖 Book'
    : `⚡ ${ms} ms`;
  setMoveInfo(`🤖 CPU (${diffLabel}) · ${sourceBadge} · ${flipped.length} flip${flipped.length !== 1 ? 's' : ''}`);

  renderBoard(flipSet, newSet);

  if (checkGameOver()) return;

  // Check if human must pass
  if (getLegalMovesJS(cells, humanPlayer).length === 0) {
    SoundFX.playPass();
    setMoveInfo('⏭ You have no moves — auto-pass');
    if (getLegalMovesJS(cells, cpuPlayer).length === 0) { endGame('score'); return; }
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
  const newSet = new Set([idx]);
  const flipSet = new Set(flipped);
  cells = newCells;
  lastMove = idx;
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
  cpuPlayer = human === 1 ? 2 : 1;

  // Standard Othello start
  cells = new Array(CELLS).fill(0);
  cells[27] = 2; cells[36] = 2;  // White: d4, e5
  cells[28] = 1; cells[35] = 1;  // Black: e4, d5

  gameOver = false;
  moveHistory = [];
  lastMove = -1;

  const diffLabel = ['Easy', 'Medium', 'Hard'][difficulty];
  const color = human === 1 ? 'Black' : 'White';
  subtitle.textContent = `Alpha-Beta AI · ${diffLabel} · Play as ${color}`;

  closeModal();
  sideSelect.hidden = false;
  boardWrap.hidden = false;
  sideSelect.hidden = true;
  replayBtn.hidden = true;
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
  boardWrap.hidden = true;
  sideSelect.hidden = false;
  subtitle.textContent = 'Alpha-Beta AI · Perfect Endgame Solver';
}

// ── Engine init ───────────────────────────────────────────────────────────────
async function initEngine() {
  try {
    // Note: COI ServiceWorker is loaded but alpha-beta is single-threaded,
    // so crossOriginIsolated is not strictly required. We skip the reload
    // check from TENGEN5 since there are no pthreads.
    // The ?v= cache-buster ensures the browser always loads the current worker
    // script. Update this string on every engine-worker.js deployment to avoid
    // mismatches between a stale worker and freshly-built WASM.
    const WORKER_VERSION = '20250425-8';
    engineWorker = new Worker(`public/engine-worker.js?v=${WORKER_VERSION}`);

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
    engineStatus.className = 'engine-status ready';
    engineReady = true;

  } catch (err) {
    engineStatus.textContent = `Engine failed: ${err.message}`;
    engineStatus.className = 'engine-status error';
    console.error('Engine init error:', err);
  }
}

initEngine();
