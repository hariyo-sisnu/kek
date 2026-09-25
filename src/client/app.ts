const MAX_LEVEL = 10;
const CELL_COUNT = 5;

const MULTIPLIERS = [
  1.23,
  1.54,
  1.93,
  2.41,
  4.02,
  6.71,
  11.18,
  27.92,
  69.93,
  349.68
];

/* =========================================================
   DOM
========================================================= */

type GameStatus = "idle" | "active" | "lost" | "completed" | "cashed_out";
type MessageTone = "neutral" | "success" | "danger";
type RoundOutcome = "WIN" | "LOSS" | "CASHED OUT" | "IN PROGRESS";
type LevelResult = "WIN" | "LOSS" | "—";

interface ProofLevel {
  level: number;
  choice: number | null;
  poisonCells: number[];
  result: LevelResult;
}

interface ProofRound {
  roundId: string;
  slot: string;
  blockhash: string;
  levels: ProofLevel[];
  outcome: RoundOutcome;
}

interface GameState {
  roundId: string;
  stake: number;
  currentLevel: number;
  currentMultiplier: number;
  status: GameStatus;
  poisonMap: Map<number, Set<number>>;
  revealedCells: Map<number, Set<number>>;
  finalPayout: number;
  completed: boolean;
  lastSelectedCell: number | null;
  lastSelectedLevel: number | null;
  selectedCells: Map<number, number>;
  solanaSlot: string;
  solanaBlockhash: string;
  randomnessResolved: boolean;
  roundHistory: ProofRound[];
  roundArchived: boolean;
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: ${id}`);
  return element as T;
}

const boardEl = getElement<HTMLDivElement>("board");
const stakeInputEl = getElement<HTMLInputElement>("stakeInput");

const startBtn = getElement<HTMLButtonElement>("startBtn");
const cashOutBtn = getElement<HTMLButtonElement>("cashOutBtn");

const roundValueEl = getElement<HTMLElement>("roundValue");
const levelValueEl = getElement<HTMLElement>("levelValue");
const multiplierValueEl = getElement<HTMLElement>("multiplierValue");
const payoutValueEl = getElement<HTMLElement>("payoutValue");

const statusValueEl = getElement<HTMLElement>("statusValue");
const roundMessageEl = getElement<HTMLElement>("roundMessage");

const verifyRoundBtn = getElement<HTMLButtonElement>("verifyRoundBtn");
const fairnessModal = getElement<HTMLElement>("fairnessModal");
const closeFairnessModal = getElement<HTMLButtonElement>("closeFairnessModal");
const proofRoundsEl = getElement<HTMLElement>("proofRounds");

/* =========================================================
   GAME STATE
========================================================= */

const state: GameState = {
  roundId: "—",

  stake: 10,

  currentLevel: 1,

  currentMultiplier: 1.0,

  status: "idle",
  // idle
  // active
  // lost
  // completed
  // cashed_out

  /*
    Map:
      level -> Set(cell indexes)

    Example:
      1 -> Set([2])
      2 -> Set([0])
      5 -> Set([1, 3])
  */
  poisonMap: new Map(),

  /*
    Map:
      level -> Set(revealed cell indexes)
  */
  revealedCells: new Map(),

  finalPayout: 0,

  completed: false,

  lastSelectedCell: null,

  lastSelectedLevel: null,
  selectedCells: new Map(),

  solanaSlot: "—",

  solanaBlockhash: "—",

  /*
    Randomness is generated after the player's
    choice is locked.

    This is the important part of the flow.
  */
  randomnessResolved: false,

  roundHistory: [],

  roundArchived: false
};

/* =========================================================
   GAME CONFIG
========================================================= */

function getPoisonCountForLevel(level: number): number {
  if (level >= 1 && level <= 4) return 1;

  if (level >= 5 && level <= 7) return 2;

  return 3;
}

function getMultiplierForLevel(level: number): number {
  return MULTIPLIERS[level - 1];
}

function generateRoundId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function resolveRandomness() {
  if (state.randomnessResolved) {
    return;
  }

  const lockResponse = await fetch("/api/rounds/lock", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      roundId: state.roundId,
      stake: state.stake,
      level: state.lastSelectedLevel,
      choice: state.lastSelectedCell
    })
  });

  const lockData = await lockResponse.json();

  if (!lockResponse.ok) {
    throw new Error(lockData.error || "Unable to lock round.");
  }

  const resolveResponse = await fetch("/api/rounds/resolve", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      roundId: state.roundId
    })
  });
  const resolveData = await resolveResponse.json();

  if (!resolveResponse.ok) {
    throw new Error(resolveData.error || "Unable to resolve locked slot.");
  }

  state.solanaSlot = String(lockData.targetSlot);
  state.solanaBlockhash = resolveData.blockhash;
  state.randomnessResolved = true;
}

async function submitChoice(level: number, choice: number): Promise<{ outcome: "WIN" | "LOSS"; poisonCells: number[] }> {
  const response = await fetch("/api/rounds/choose", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      roundId: state.roundId,
      level,
      choice
    })
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Unable to resolve selected cell.");
  }

  return data;
}


/* =========================================================
   PAYOUT
========================================================= */

function getCurrentPayout() {
  return state.stake * state.currentMultiplier;
}


/* =========================================================
   UI
========================================================= */

function updateRoundLabel() {
  roundValueEl.textContent =
    state.roundId || "—";

  levelValueEl.textContent =
    String(state.currentLevel);

  multiplierValueEl.textContent =
    `${state.currentMultiplier.toFixed(2)}x`;

  payoutValueEl.textContent =
    `$${getCurrentPayout().toFixed(2)}`;
}


function updateStatus(message: string, tone: MessageTone = "neutral"): void {
  statusValueEl.textContent = message;

  statusValueEl.className =
    `status-message ${tone}`;

  roundMessageEl.className =
    `round-message ${tone}`;
}


/* =========================================================
   PROVABLY FAIR UI
========================================================= */

function getProofRounds(): ProofRound[] {
  const rounds: ProofRound[] = [];

  if (
    state.roundId &&
    state.randomnessResolved &&
    !state.roundArchived
  ) {
    rounds.push(createRoundProof("IN PROGRESS"));
  }

  if (state.roundArchived && state.roundHistory.length) {
    rounds.push(state.roundHistory[0]);
  }

  return rounds;
}

function updateProofFields() {
  const rounds = getProofRounds();

  proofRoundsEl.replaceChildren();

  if (!rounds.length) {
    const empty = document.createElement("p");
    empty.className = "proof-empty";
    empty.textContent = "No round proof is available yet.";
    proofRoundsEl.appendChild(empty);
    return;
  }

  rounds.forEach((round) => {
    proofRoundsEl.appendChild(createProofCard(round));
  });
}

function createRoundProof(outcome: RoundOutcome): ProofRound {
  const levels: ProofLevel[] = [];

  for (let level = 1; level <= MAX_LEVEL; level += 1) {
    const choice = state.selectedCells.get(level) ?? null;
    const poisonSet = state.poisonMap.get(level) || new Set<number>();

    levels.push({
      level,
      choice,
      poisonCells: [...poisonSet].map((cellIndex) => cellIndex + 1),
      result: choice === null
        ? "—"
        : poisonSet.has(choice - 1) ? "LOSS" : "WIN"
    });
  }

  return {
    roundId: state.roundId,
    slot: state.solanaSlot,
    blockhash: state.solanaBlockhash,
    levels,
    outcome
  };
}

function createProofCard(round: ProofRound): HTMLElement {
  const card = document.createElement("article");
  card.className = "proof-card";
  card.dataset.roundId = round.roundId;

  const heading = document.createElement("div");
  heading.className = "proof-card-head";
  heading.innerHTML = `<strong>Round ${round.roundId}</strong><strong>${round.outcome}</strong>`;
  card.appendChild(heading);

  const details = [
    ["Solana slot", round.slot],
    ["Blockhash", round.blockhash]
  ];

  details.forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = "proof-row";
    row.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    card.appendChild(row);
  });

  const levels = document.createElement("div");
  levels.className = "proof-levels";

  round.levels.forEach((proofLevel) => {
    const row = document.createElement("div");
    row.className = "proof-level-row";
    row.dataset.level = String(proofLevel.level);

    const label = document.createElement("span");
    label.textContent = `Level ${proofLevel.level}`;

    const choice = document.createElement("strong");
    choice.textContent = `Choice ${proofLevel.choice ?? "—"}`;

    const result = document.createElement("span");
    result.className = "level-verification";
    result.textContent = proofLevel.choice === null ? "Not played" : "Not verified";

    const verifyButton = document.createElement("button");
    verifyButton.type = "button";
    verifyButton.className = "proof-level-verify";
    verifyButton.textContent = proofLevel.choice === null ? "—" : "Verify";
    verifyButton.disabled = proofLevel.choice === null;

    row.append(label, choice, result, verifyButton);
    levels.appendChild(row);
  });

  card.appendChild(levels);

  const verification = document.createElement("div");
  verification.className = "proof-verification pending";
  verification.textContent = "Verification pending";
  card.appendChild(verification);

  return card;
}


function openFairnessModal() {
  updateProofFields();

  fairnessModal.classList.remove("hidden");

  fairnessModal.setAttribute(
    "aria-hidden",
    "false"
  );
}


function closeFairnessModalFn() {
  fairnessModal.classList.add("hidden");

  fairnessModal.setAttribute(
    "aria-hidden",
    "true"
  );
}


async function verifyProofRound(round: ProofRound, proofLevel: ProofLevel): Promise<{ level: number; verified: boolean; message: string }> {
  const params = new URLSearchParams({
    roundId: round.roundId,
    slot: round.slot,
    level: String(proofLevel.level),
    choice: String(proofLevel.choice)
  });
  const response = await fetch(`/api/verify?${params.toString()}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Backend verification failed.");
  }

  return {
    level: proofLevel.level,
    verified: data.verified && data.outcome === proofLevel.result,
    message: `${data.outcome} reproduced from the public Solana proof.`
  };
}

async function verifyRoundResult() {
  openFairnessModal();
}


/* =========================================================
   BOARD RENDERING
========================================================= */

function setBoardState() {
  const rows = [];

  /*
    Render from Level 10 down to Level 1.
  */

  for (
    let level = MAX_LEVEL;
    level >= 1;
    level--
  ) {
    const row =
      document.createElement("div");

    row.className = "level-row";

    /*
      ROW STATE
    */

    if (
      state.status === "active" &&
      level === state.currentLevel
    ) {
      row.classList.add("active");
    }

    if (
      state.status === "lost" &&
      level === state.currentLevel
    ) {
      row.classList.add("lost");
    }

    if (level < state.currentLevel) {
      row.classList.add("passed");
    }

    /*
      LEVEL MULTIPLIER
    */

    const label =
      document.createElement("div");

    label.className = "level-tag";

    label.textContent =
      `${getMultiplierForLevel(level).toFixed(2)}x`;

    row.appendChild(label);

    /*
      CELLS
    */

    for (
      let index = 0;
      index < CELL_COUNT;
      index++
    ) {
      const cell =
        document.createElement("button");

      cell.type = "button";

      cell.className =
        "cell hidden-cell";

      cell.dataset.level =
        String(level);

      cell.dataset.index =
        String(index);

      /*
        Only current level is playable.
      */

      const isActiveLevel =
        state.status === "active" &&
        level === state.currentLevel;

      cell.disabled =
        !isActiveLevel;

      /*
        Poison state
      */

      const poisonSet =
        state.poisonMap.get(level) ||
        new Set();

      const isPoison =
        poisonSet.has(index);

      /*
        Revealed state
      */

      const levelRevealed =
        state.revealedCells.get(level) ||
        new Set();

      const isRevealed =
        levelRevealed.has(index);

      /*
        Icon
      */

      const tile =
        document.createElement("img");

      tile.className =
        "tile-icon";

      /*
        Hidden tile
      */

      if (!isRevealed) {
        tile.src = "assets/tile.png";

        tile.alt = "Hidden";

        tile.classList.add(
          "hidden-img"
        );
      }

      /*
        Revealed tile
      */

      else {
        cell.classList.remove(
          "hidden-cell"
        );

        if (isPoison) {
          cell.classList.add(
            "poison"
          );

          tile.src =
            "assets/poison.png";

          tile.alt =
            "Poison";
        }

        else {
          cell.classList.add(
            "safe"
          );

          tile.src =
            "assets/good.png";

          tile.alt =
            "Safe";
        }
      }

      cell.appendChild(tile);

      row.appendChild(cell);
    }

    rows.push(row);
  }

  boardEl.replaceChildren(...rows);
}


/* =========================================================
   ROUND INITIALIZATION
========================================================= */

function clearRoundState() {
  state.poisonMap.clear();

  state.revealedCells.clear();

  state.finalPayout = 0;

  state.completed = false;

  state.randomnessResolved = false;

  for (
    let level = 1;
    level <= MAX_LEVEL;
    level++
  ) {
    state.revealedCells.set(
      level,
      new Set()
    );
  }
}


/*
  Start a new round.

  IMPORTANT:
  We DO NOT generate the poison map here.

  The player must choose first.
*/
function resetRound() {
  const stake =
    Number(stakeInputEl.value);

  state.roundId = generateRoundId();

  state.stake =
    Number.isFinite(stake) && stake > 0
      ? stake
      : 1;

  state.currentLevel = 1;

  state.status = "active";

  state.currentMultiplier = 1.0;

  state.lastSelectedCell = null;

  state.lastSelectedLevel = null;

  state.selectedCells.clear();

  state.roundHistory = [];
  closeFairnessModalFn();

  state.roundArchived = false;

  state.solanaSlot = "Pending";

  state.solanaBlockhash = "Pending";

  clearRoundState();

  updateRoundLabel();

  updateProofFields();

  updateStatus(
    "Choose a cell from Level 1.",
    "neutral"
  );

  setBoardState();

  startBtn.disabled = true;

  cashOutBtn.disabled = true;
}

function archiveCurrentRound(outcome: RoundOutcome): void {
  if (state.roundArchived || !state.roundId) {
    return;
  }

  state.roundHistory.unshift(createRoundProof(outcome));
  state.roundArchived = true;
}


/* =========================================================
   LOSS
========================================================= */

function declareLoss(level: number): void {
  const poisonSet =
    state.poisonMap.get(level) ||
    new Set();

  const thisLevelRevealed =
    state.revealedCells.get(level) ||
    new Set();

  /*
    Reveal every poison cell on the
    failed level.
  */

  poisonSet.forEach(
    (poisonIndex) => {
      thisLevelRevealed.add(
        poisonIndex
      );
    }
  );

  state.revealedCells.set(
    level,
    thisLevelRevealed
  );

  state.status = "lost";

  state.finalPayout = 0;

  archiveCurrentRound("LOSS");

  updateStatus(
    `Poison hit! You lost on Level ${level}.`,
    "danger"
  );

  updateRoundLabel();

  updateProofFields();

  setBoardState();

  startBtn.disabled = false;

  cashOutBtn.disabled = true;
}


/* =========================================================
   CELL CLICK
========================================================= */

async function handleCellClick(cellElement: HTMLButtonElement): Promise<void> {
  if (state.status !== "active") {
    return;
  }

  const level =
    Number(cellElement.dataset.level);

  const index =
    Number(cellElement.dataset.index);

  /*
    Safety check.
  */

  if (
    level !== state.currentLevel
  ) {
    return;
  }

  /*
    Prevent double click.
  */

  cellElement.disabled = true;

  /*
    Record player's choice FIRST.

    This is critical for the future
    Solana randomness flow.
  */

  state.lastSelectedCell =
    index + 1;

  state.lastSelectedLevel =
    level;

  state.selectedCells.set(level, index + 1);

  updateStatus(
    "Choice locked. Resolving Solana randomness...",
    "neutral"
  );

  try {
    await resolveRandomness();
    const result = await submitChoice(level, index + 1);
    state.poisonMap.set(
      level,
      new Set(result.poisonCells.map((cell) => cell - 1))
    );

    const levelRevealed =
      state.revealedCells.get(level) ||
      new Set<number>();

    levelRevealed.add(index);
    state.revealedCells.set(level, levelRevealed);

    if (result.outcome === "LOSS") {
      declareLoss(level);
      return;
    }
  }

  catch (error) {
    console.error(
      "Randomness error:",
      error
    );

    const message = error instanceof Error ? error.message : "Unknown randomness error";
    updateStatus(`Unable to resolve game randomness: ${message}`, "danger");

    cellElement.disabled = false;

    return;
  }

  /*
    SAFE
  */

  state.currentMultiplier =
    getMultiplierForLevel(level);

  state.finalPayout =
    getCurrentPayout();

  /*
    Final level
  */

  if (level === MAX_LEVEL) {
    state.status = "completed";

    state.completed = true;

    archiveCurrentRound("WIN");

    updateStatus(
      `Safe run! You completed the full board and won $${state.finalPayout.toFixed(2)}.`,
      "success"
    );

    cashOutBtn.disabled = true;

    startBtn.disabled = false;
  }

  /*
    Continue to next level
  */

  else {
    state.currentLevel =
      level + 1;

    cashOutBtn.disabled = false;

    updateStatus(
      `Level ${level} cleared. Choose a cell for Level ${state.currentLevel}, or cash out.`,
      "success"
    );
  }

  updateRoundLabel();

  updateProofFields();

  setBoardState();
}


/* =========================================================
   CASH OUT
========================================================= */

function handleCashOut() {
  /*
    Can't cash out before completing
    at least one level.
  */

  if (
    state.status !== "active" ||
    state.currentLevel === 1
  ) {
    return;
  }

  const payout =
    getCurrentPayout();

  state.finalPayout =
    payout;

  state.status =
    "cashed_out";

  archiveCurrentRound("CASHED OUT");

  updateStatus(
    `Cashed out! You collected $${payout.toFixed(2)}.`,
    "success"
  );

  cashOutBtn.disabled = true;

  startBtn.disabled = false;

  updateRoundLabel();

  setBoardState();
}


/* =========================================================
   EVENT LISTENERS
========================================================= */

startBtn.addEventListener(
  "click",
  resetRound
);

cashOutBtn.addEventListener(
  "click",
  handleCashOut
);

verifyRoundBtn.addEventListener(
  "click",
  verifyRoundResult
);

proofRoundsEl.addEventListener(
  "click",
  async (event) => {
    const button =
      (event.target as Element | null)?.closest<HTMLButtonElement>(".proof-level-verify");

    if (!button || button.disabled) return;

    const row = button.closest<HTMLElement>(".proof-level-row");
    const card = button.closest<HTMLElement>(".proof-card");
    const round = getProofRounds().find(
      (candidate) => candidate.roundId === card?.dataset.roundId
    );
    const level = Number(row?.dataset.level);
    const proofLevel = round?.levels.find((candidate) => candidate.level === level);
    const result = row?.querySelector<HTMLElement>(".level-verification");

    if (!round || !proofLevel || !result) return;

    button.disabled = true;
    button.textContent = "...";

    try {
      const verification = await verifyProofRound(round, proofLevel);
      result.textContent = verification.verified ? "Verified" : "Mismatch";
      result.className =
        `level-verification ${verification.verified ? "verified" : "failed"}`;
    }
    catch (error) {
      result.textContent = "Unavailable";
      result.className = "level-verification failed";
      console.error("Level verification error:", error);
    }
    finally {
      button.textContent = "Checked";
    }
  }
);

closeFairnessModal.addEventListener(
  "click",
  closeFairnessModalFn
);


/*
  Close modal by clicking outside.
*/

fairnessModal.addEventListener(
  "click",
  (event) => {
    if (
      event.target === fairnessModal
    ) {
      closeFairnessModalFn();
    }
  }
);


/*
  Board event delegation.
*/

boardEl.addEventListener(
  "click",
  (event) => {
    const cell =
      (event.target as Element | null)?.closest<HTMLButtonElement>(".cell");

    if (
      cell &&
      !cell.disabled
    ) {
      handleCellClick(cell);
    }
  }
);


/* =========================================================
   INITIALIZATION
========================================================= */

function init() {
  state.roundId = "—";

  state.currentMultiplier = 1.0;

  state.solanaSlot = "—";

  state.solanaBlockhash = "—";

  state.randomnessResolved = false;

  clearRoundState();

  updateRoundLabel();

  updateProofFields();

  setBoardState();

  updateStatus(
    "Place a stake to begin.",
    "neutral"
  );

  startBtn.disabled = false;

  cashOutBtn.disabled = true;
}

init();