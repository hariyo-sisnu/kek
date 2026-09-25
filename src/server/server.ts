import { config as loadEnvironment } from "dotenv";
import http, { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Connection, clusterApiUrl } from "@solana/web3.js";
import {
  deriveHashHex,
  generatePoisonCells,
  outcomeForChoice,
  Outcome
} from "../shared/fairness";

loadEnvironment();

interface RoundInput {
  roundId: string;
  level: number;
  choice: number;
  stake: number;
}

interface RoundRecord extends RoundInput {
  targetSlot: number;
  blockhash: string | null;
  resolvedAt: string | null;
  choices: Map<number, number>;
  status: "active" | "lost" | "completed";
}

interface JsonObject {
  [key: string]: unknown;
}

interface RpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

interface SolanaBlock {
  blockhash: string;
}

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(__dirname, "../../public");
const ROUND_OFFSET = 3;
const rounds = new Map<string, RoundRecord>();
const rpcUrl = process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");
const wsUrl = process.env.SOLANA_WS_URL || rpcUrl.replace(/^http/, "ws");
const connection = new Connection(
  rpcUrl,
  {
    commitment: "confirmed",
    wsEndpoint: wsUrl
  }
);

function logEvent(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...details
  }));
}

async function rpcRequest<T>(method: string, params: unknown[]): Promise<T> {
  const startedAt = Date.now();

  logEvent("rpc.start", { method });

  try {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params
    })
  });

  if (!response.ok) {
    throw new Error(`Solana RPC returned HTTP ${response.status}.`);
  }

  const payload = await response.json() as RpcResponse<T>;

  if (payload.error) {
    throw new Error(payload.error.message || "Solana RPC request failed.");
  }

  if (payload.result === undefined) {
    throw new Error("Solana RPC returned no result.");
  }

    logEvent("rpc.success", {
      method,
      durationMs: Date.now() - startedAt
    });

  return payload.result;
  }
  catch (error) {
    logEvent("rpc.failure", {
      method,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown RPC error"
    });
    throw error;
  }
}

async function getConfirmedSlot(): Promise<number> {
  return rpcRequest<number>("getSlot", [{ commitment: "confirmed" }]);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function readJson(request: IncomingMessage): Promise<JsonObject> {
  return new Promise<JsonObject>((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });

    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      }
      catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    request.on("error", reject);
  });
}

function validateRoundInput(input: JsonObject): RoundInput {
  const roundId = String(input.roundId || "");
  const level = Number(input.level);
  const choice = Number(input.choice);
  const stake = Number(input.stake);

  if (!/^[a-f0-9]{32}$/.test(roundId)) {
    throw new Error("Invalid round ID.");
  }

  if (!Number.isInteger(level) || level < 1 || level > 10) {
    throw new Error("Invalid level.");
  }

  if (!Number.isInteger(choice) || choice < 1 || choice > 5) {
    throw new Error("Invalid choice.");
  }

  if (!Number.isFinite(stake) || stake <= 0) {
    throw new Error("Invalid stake.");
  }

  return { roundId, level, choice, stake };
}

async function waitForSlot(targetSlot: number): Promise<void> {
  const startedAt = Date.now();
  const currentSlot = await getConfirmedSlot();
  if (currentSlot >= targetSlot) {
    logEvent("slot.ready", { targetSlot, durationMs: Date.now() - startedAt, mode: "already-reached" });
    return;
  }

  try {
    await waitForSlotWithWebSocket(targetSlot);
    logEvent("slot.ready", { targetSlot, durationMs: Date.now() - startedAt, mode: "websocket" });
  }
  catch (error) {
    logEvent("websocket.fallback", {
      targetSlot,
      error: error instanceof Error ? error.message : "Unknown WebSocket error"
    });
    await waitForSlotWithPolling(targetSlot);
    logEvent("slot.ready", { targetSlot, durationMs: Date.now() - startedAt, mode: "polling-fallback" });
  }
}

async function checkWebSocketHealth(): Promise<{ ok: boolean; slot: number | null; durationMs: number; error?: string }> {
  const startedAt = Date.now();

  try {
    const currentSlot = await getConfirmedSlot();
    const result = await new Promise<number>((resolve, reject) => {
      let subscriptionId: number | null = null;
      const timeout = setTimeout(() => {
        if (subscriptionId !== null) void connection.removeSlotChangeListener(subscriptionId);
        reject(new Error("WebSocket slot notification timed out."));
      }, 3000);

      try {
        subscriptionId = connection.onSlotChange(({ slot }) => {
          clearTimeout(timeout);
          if (subscriptionId !== null) void connection.removeSlotChangeListener(subscriptionId);
          resolve(slot);
        });
      }
      catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });

    return { ok: result >= currentSlot, slot: result, durationMs: Date.now() - startedAt };
  }
  catch (error) {
    return {
      ok: false,
      slot: null,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown WebSocket error"
    };
  }
}

async function healthCheck() {
  const startedAt = Date.now();
  let rpc: { ok: boolean; slot: number | null; durationMs: number; error?: string };

  try {
    const rpcStartedAt = Date.now();
    const slot = await getConfirmedSlot();
    rpc = { ok: true, slot, durationMs: Date.now() - rpcStartedAt };
  }
  catch (error) {
    rpc = {
      ok: false,
      slot: null,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown RPC error"
    };
  }

  const websocket = await checkWebSocketHealth();
  return {
    ok: rpc.ok && websocket.ok,
    rpc,
    websocket,
    durationMs: Date.now() - startedAt
  };
}

async function waitForSlotWithWebSocket(targetSlot: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let subscriptionId: number | null = null;
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for the Solana slot."));
    }, 10000);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (subscriptionId !== null) {
        void connection.removeSlotChangeListener(subscriptionId);
      }
      if (error) reject(error);
      else resolve();
    };

    try {
      subscriptionId = connection.onSlotChange(({ slot }) => {
        if (slot >= targetSlot) finish();
      });
      if (settled) void connection.removeSlotChangeListener(subscriptionId);
    }
    catch (error) {
      finish(error instanceof Error ? error : new Error("Solana WebSocket failed."));
    }
  });
}

async function waitForSlotWithPolling(targetSlot: number): Promise<void> {
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    if (await getConfirmedSlot() >= targetSlot) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error("Timed out waiting for the Solana slot.");
}

async function getBlockWithRetry(slot: number): Promise<SolanaBlock> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const block = await rpcRequest<SolanaBlock | null>("getBlock", [
        slot,
        {
          commitment: "confirmed",
          transactionDetails: "none"
        }
      ]);

      if (block) return block;
    }
    catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error("Solana block not found for the locked slot.");
}

async function lockRound(input: JsonObject): Promise<{ roundId: string; targetSlot: number }> {
  const round = validateRoundInput(input);

  if (rounds.has(round.roundId)) {
    throw new Error("Round ID is already locked.");
  }

  const currentSlot = await getConfirmedSlot();
  const record: RoundRecord = {
    ...round,
    targetSlot: currentSlot + ROUND_OFFSET,
    blockhash: null,
    resolvedAt: null,
    choices: new Map(),
    status: "active"
  };

  rounds.set(round.roundId, record);

  return {
    roundId: record.roundId,
    targetSlot: record.targetSlot
  };
}

async function resolveRound(roundId: string): Promise<RoundRecord> {
  const record = rounds.get(String(roundId || ""));

  if (!record) {
    throw new Error("Round is not locked.");
  }

  if (record.blockhash) {
    return record;
  }

  await waitForSlot(record.targetSlot);
  const block = await getBlockWithRetry(record.targetSlot);

  record.blockhash = block.blockhash;
  record.resolvedAt = new Date().toISOString();

  return record;
}

function validateChoice(levelValue: unknown, choiceValue: unknown): { level: number; choice: number } {
  const level = Number(levelValue);
  const choice = Number(choiceValue);

  if (!Number.isInteger(level) || level < 1 || level > 10) {
    throw new Error("Invalid verification level.");
  }

  if (!Number.isInteger(choice) || choice < 1 || choice > 5) {
    throw new Error("Invalid verification choice.");
  }

  return { level, choice };
}

function calculateResult(roundId: string, blockhash: string, level: number, choice: number) {
  const hashHex = deriveHashHex(blockhash, roundId);
  const poison = generatePoisonCells(hashHex, level);
  const outcome: Outcome = outcomeForChoice(poison, choice);

  return {
    blockhash,
    outcome,
    poisonCells: [...poison].map((cell) => cell + 1)
  };
}

async function chooseRound(roundId: string, levelValue: unknown, choiceValue: unknown) {
  const record = rounds.get(roundId);

  if (!record || !record.blockhash) {
    throw new Error("Round randomness has not resolved yet.");
  }

  if (record.status !== "active") {
    throw new Error("Round is already finished.");
  }

  const { level, choice } = validateChoice(levelValue, choiceValue);

  if (level !== record.choices.size + 1 || record.choices.has(level)) {
    throw new Error("Choice must be made for the current level.");
  }

  const result = calculateResult(roundId, record.blockhash, level, choice);
  record.choices.set(level, choice);

  if (result.outcome === "LOSS") {
    record.status = "lost";
  }
  else if (level === 10) {
    record.status = "completed";
  }

  return {
    level,
    choice,
    outcome: result.outcome,
    poisonCells: result.poisonCells
  };
}

async function verifyPublic(input: JsonObject) {
  const roundId = String(input.roundId || "");
  const slot = Number(input.slot);
  const { level, choice } = validateChoice(input.level, input.choice);

  if (!/^[a-f0-9]{32}$/.test(roundId) || !Number.isSafeInteger(slot) || slot <= 0) {
    throw new Error("Invalid public verification input.");
  }

  const block = await getBlockWithRetry(slot);
  const result = calculateResult(roundId, block.blockhash, level, choice);

  return {
    verified: result.blockhash.length > 0,
    outcome: result.outcome,
    blockhash: result.blockhash
  };
}

function contentType(filePath: string): string {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".md": "text/plain; charset=utf-8"
  }[path.extname(filePath)] || "application/octet-stream";
}

function serveStatic(request: IncomingMessage, response: ServerResponse, pathname: string): void {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(ROOT, relativePath);

  if (!filePath.startsWith(`${ROOT}${path.sep}`)) {
    sendJson(response, 403, { error: "Forbidden." });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }

    response.writeHead(200, { "Content-Type": contentType(filePath) });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "POST" && url.pathname === "/api/rounds/lock") {
      const startedAt = Date.now();
      const result = await lockRound(await readJson(request));
      logEvent("round.locked", { ...result, durationMs: Date.now() - startedAt });
      sendJson(response, 201, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/rounds/resolve") {
      const startedAt = Date.now();
      const body = await readJson(request);
      const record = await resolveRound(String(body.roundId || ""));
      const result = {
        roundId: record.roundId,
        targetSlot: record.targetSlot,
        blockhash: record.blockhash
      };
      logEvent("round.resolved", { ...result, durationMs: Date.now() - startedAt });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/rounds/choose") {
      const startedAt = Date.now();
      const body = await readJson(request);
      const result = await chooseRound(
        String(body.roundId || ""),
        body.level,
        body.choice
      );
      logEvent("round.choice", { ...result, durationMs: Date.now() - startedAt });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/verify") {
      const startedAt = Date.now();
      const result = await verifyPublic({
        roundId: url.searchParams.get("roundId"),
        slot: url.searchParams.get("slot"),
        level: url.searchParams.get("level"),
        choice: url.searchParams.get("choice")
      });
      logEvent("round.verified", { ...result, durationMs: Date.now() - startedAt });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      const result = await healthCheck();
      logEvent("health.check", result);
      sendJson(response, result.ok ? 200 : 503, result);
      return;
    }

    if (request.method === "GET") {
      serveStatic(request, response, url.pathname);
      return;
    }

    sendJson(response, 405, { error: "Method not allowed." });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    logEvent("request.failure", {
      method: request.method,
      path: request.url,
      error: message
    });
    sendJson(response, 400, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`Pepe Fortune server listening on http://localhost:${PORT}`);
});

export {};
