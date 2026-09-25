# Pepe Fortune

A compact browser game inspired by a high-risk grid challenge. The base rules are a 10-level, 5-cell ladder where each successful selection advances the round and increases the payout multiplier.

## Overview

- 10 levels
- 5 cells per level
- Poison cells increase with level difficulty
- Each round is intended to be checked against a future Solana block hash for provable fairness
- The browser UI derives its board from a recorded Solana slot and independently verifies recorded results

## Core gameplay

The current game logic follows this pattern:

- player places a stake
- round starts at level 1
- player chooses a cell
- if the cell is safe, the round continues
- if the cell is poisoned, the round ends in loss
- the player may cash out at any safe point

## Fairness model

The typed backend and shared fairness module use a Solana future blockhash and a round ID to create deterministic randomness.

### 1) Lock and get a future block

The backend records the target slot before waiting, then fetches that exact future block through the configured RPC:

```js
const currentSlot = await connection.getSlot("confirmed");
const targetSlot = currentSlot + 5;
const block = await connection.getBlock(targetSlot, {
  commitment: "confirmed",
  transactionDetails: "none",
});
```

This produces:

- a block hash
- a target slot number

### 2) Derive randomness

The hash is produced with SHA-256 over the future blockhash and the round ID:

```js
const hashHex = deriveHashHex(blockhash, roundId);
```

This is deterministic: the same `blockhash:roundId` will always reproduce the same hash.

### 3) Map randomness to level-specific poison cells

The shared fairness module deterministically shuffles the five cells and selects one, two, or three poison cells depending on the level. The result is reproducible by anyone who knows:

- the round ID
- the target slot
- the Solana blockhash at that slot

## Verification flow

The backend verification endpoint recomputes the same result. It does the following:

1. looks up the block at the recorded slot
2. reads the blockhash
3. rebuilds the same SHA-256 hash using `blockhash:roundId`
4. derives the level-specific poison cells again
5. compares it to the player choice

This is the classic provably-fair pattern: if the same inputs are used, the result can be reproduced and checked by the player.

## Current limitation

The Node backend now locks the round, player choice, and target slot before waiting for the block. The browser never receives the RPC URL or decides the target slot. The backend currently keeps round records in memory, so persistent storage and a Solana program are still required before using this for real wagering.

Round IDs use `crypto.getRandomValues()` in the browser. The CLI tools use `SOLANA_RPC_URL` from a local `.env` file when provided, and fall back to devnet.

The browser flow uses these same-origin backend endpoints:

- `POST /api/rounds/lock` records the choice and precommits `currentSlot + 3`
- `POST /api/rounds/resolve` waits for the locked slot and records its blockhash
- `POST /api/rounds/choose` computes the authoritative result for the selected level
- `GET /api/verify` independently recomputes a result from `roundId`, `slot`, `level`, and `choice`
- `GET /api/health` checks Helius RPC and WebSocket availability and returns timings

Round resolution uses Helius WebSockets for slot notifications instead of polling. Set both `SOLANA_RPC_URL` and `SOLANA_WS_URL` in `.env`; the WebSocket URL is derived from the RPC URL when the second variable is omitted.

The backend writes structured JSON timing logs for RPC calls, WebSocket fallback, round locking, block resolution, choices, and verification. Error responses are surfaced in the game message instead of being reduced to a generic failure.

## Production requirements

For a real-money or real-risk game, the authoritative result should come from a trusted server or backend service that:

- validates the round ID
- waits for a future Solana block
- records the slot and blockhash
- computes the hash deterministically
- stores the result before revealing it to the client
- exposes a verification endpoint for players

## Project structure

- `src/client/app.ts` — typed browser game controller and UI state
- `src/server/server.ts` — typed HTTP server, round locking, Solana RPC, and verification API
- `src/shared/fairness.ts` — shared typed hash and poison-cell rules
- `public/index.html` — browser app shell
- `public/styles.css` — game styling
- `public/assets/` — tile and game image assets
- `dist/` — generated TypeScript output; do not edit manually
- `.env.example` — safe RPC configuration template
- `concepts.md` — game design reference
- `todo` — remaining product and production tasks

## Local run

Install dependencies:

```bash
npm install
```

Start the backend and browser app:

```bash
npm start
```

Typecheck without generating output:

```bash
npm run typecheck
```

## Notes

- The backend uses `SOLANA_RPC_URL` from `.env`, falling back to Solana devnet.
- Round records are currently in memory; persistent storage and settlement authorization are still required for real wagering.
