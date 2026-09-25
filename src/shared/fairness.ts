import { createHash } from "node:crypto";

export const MAX_LEVEL = 10;
export const CELL_COUNT = 5;

export type Outcome = "WIN" | "LOSS";

export function getPoisonCountForLevel(level: number): number {
  if (level <= 4) return 1;
  if (level <= 7) return 2;
  return 3;
}

export function deriveHashHex(blockhash: string, roundId: string): string {
  return createHash("sha256")
    .update(`${blockhash}:${roundId}`)
    .digest("hex");
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;

  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generatePoisonCells(hashHex: string, level: number): Set<number> {
  const positions = Array.from({ length: CELL_COUNT }, (_, index) => index);
  const random = seededRandom(
    (parseInt(hashHex.slice(0, 8), 16) + level * 1009) >>> 0
  );

  for (let index = positions.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [positions[index], positions[swapIndex]] = [
      positions[swapIndex],
      positions[index]
    ];
  }

  return new Set(positions.slice(0, getPoisonCountForLevel(level)));
}

export function outcomeForChoice(poisonCells: Set<number>, choice: number): Outcome {
  return poisonCells.has(choice - 1) ? "LOSS" : "WIN";
}
