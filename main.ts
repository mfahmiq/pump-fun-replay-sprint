// Sprint — a momentum paper-trading bot for the make.fun pump.fun replay
// (agent-fun/replay/v2, competition u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122).
//
// The bot trades 10 SOL of paper money on a 24-hour replay of pump.fun
// bonding-curve activity. It is long-only, deterministic and self-contained:
// no clock, no environment, no randomness, no network — every decision comes
// from the batches the harness streams on stdin, so the two graded runs
// produce identical action logs.
//
// Strategy in one paragraph (the full reasoning lives in README.md and in
// strategy.ts): snipe launches — buy a curve in its first few slots only if
// it passes a rug filter (small creator buy, few early wallets, creator has
// not sold), take profit fast, cut losers fast, and never hold past a short
// time limit. Tiny stakes cycle through hundreds of launches, so one rug
// costs ~0.1 SOL and the rare runner pays for the losers.
//
// Wire protocol: the harness sends newline-delimited JSON (hello, then one
// batch per slot, then done) on stdin; the bot answers every batch with
// exactly one reply line on stdout echoing its seq. Only the Node standard
// library is used, and nothing is read from outside this repository.

import { createInterface } from "node:readline";
import { createStrategy } from "./strategy.ts";

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const BPS = 10_000n;

export type U64 = string;
export type Pubkey = string;

export interface Hello {
  type: "hello";
  protocol: string;
  seed: U64;
  universe: unknown;
  capital: { lamports: U64 };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: U64;
    priority_fee_lamports: U64;
    failed_tx_bps: number;
  };
}

export interface ChainMeta {
  slot: number;
  signature: string;
  block_time: number | null;
  chain_seq: number;
}

export interface TradeEventRecord extends ChainMeta {
  event: "TradeEvent";
  mint: Pubkey;
  sol_amount: U64;
  token_amount: U64;
  is_buy: boolean;
  user: Pubkey;
  timestamp: string;
  virtual_sol_reserves: U64;
  virtual_token_reserves: U64;
  real_sol_reserves: U64;
  real_token_reserves: U64;
  fee_basis_points: U64;
  creator_fee_basis_points: U64;
}

export interface CreateEventRecord extends ChainMeta {
  event: "CreateEvent";
  name: string;
  symbol: string;
  uri: string;
  mint: Pubkey;
  bonding_curve: Pubkey;
  user: Pubkey;
  creator: Pubkey;
  timestamp: string;
  virtual_token_reserves: U64;
  virtual_sol_reserves: U64;
  real_token_reserves: U64;
  token_total_supply: U64;
  is_mayhem_mode: boolean;
  is_cashback_enabled: boolean;
  quote_mint: Pubkey;
  virtual_quote_reserves: U64;
  creator_fee_bps: U64;
}

export interface CompleteEventRecord extends ChainMeta {
  event: "CompleteEvent";
  user: Pubkey;
  mint: Pubkey;
  bonding_curve: Pubkey;
  timestamp: string;
  quote_mint: Pubkey;
}

export type ChainEvent = TradeEventRecord | CreateEventRecord | CompleteEventRecord;

export interface Mark {
  mint: Pubkey;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

export interface Position {
  mint: Pubkey;
  token_amount: U64;
  cost_lamports: U64;
}

export interface Account {
  cash_lamports: U64;
  positions: Position[];
}

export type Side = "buy" | "sell";

export interface Fill {
  client_id: string;
  mint: Pubkey;
  side: Side;
  status: "filled" | "rejected" | "failed";
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: U64;
  token_amount: U64;
  fee_lamports: U64;
  tx_fee_lamports: U64;
  fee_fallback: boolean;
}

export interface Batch {
  type: "batch";
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: Account;
}

export interface Done {
  type: "done";
  seq: number;
  reason: "end_of_data" | "aborted";
  account: Account;
}

export interface BuyInput {
  side: "buy";
  mint: Pubkey;
  quote_lamports: bigint | string | number;
  max_slippage_bps: number;
  client_id?: string;
}

export interface SellInput {
  side: "sell";
  mint: Pubkey;
  token_amount: bigint | string | number;
  max_slippage_bps: number;
  client_id?: string;
}

export type OrderInput = BuyInput | SellInput;

export interface BuyOrder {
  side: "buy";
  client_id: string;
  mint: Pubkey;
  quote_lamports: U64;
  max_slippage_bps: number;
}

export interface SellOrder {
  side: "sell";
  client_id: string;
  mint: Pubkey;
  token_amount: U64;
  max_slippage_bps: number;
}

export type Order = BuyOrder | SellOrder;

/** A bonding curve the bot has seen, at its latest known reserves. */
export interface Curve {
  mint: Pubkey;
  created_slot: number | null;
  virtual_token_reserves: bigint;
  virtual_quote_reserves: bigint;
  real_token_reserves: bigint;
  real_quote_reserves: bigint;
  reserves_slot: number;
  trades: number;
  complete: boolean;
}

export interface Holding {
  token_amount: bigint;
  cost_lamports: bigint;
}

export interface PendingOrder {
  order: Order;
  seq: number;
  decided_slot: number;
}

const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;

function toU64(value: unknown, what: string): U64 {
  let n: bigint | null = null;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === "string" && U64_RE.test(value)) n = BigInt(value);
  if (n === null || n < 0n || n > 18_446_744_073_709_551_615n) {
    throw new Error(`${what} must be a u64, got ${String(value)}`);
  }
  return n.toString();
}

/**
 * Everything the bot knows, kept current before each strategy call. The
 * strategy reads this state and never touches the wire itself.
 */
export class BotState {
  readonly hello: Hello;
  seq = -1;
  slot = -1;
  account: Account;
  cash: bigint;
  readonly positions = new Map<Pubkey, Holding>();
  readonly curves = new Map<Pubkey, Curve>();
  readonly pending = new Map<string, PendingOrder>();
  private usedIds = new Set<string>();
  private nextId = 1;

  constructor(hello: Hello) {
    this.hello = hello;
    this.account = { cash_lamports: hello.capital.lamports, positions: [] };
    this.cash = BigInt(hello.capital.lamports);
  }

  clientId(): string {
    for (;;) {
      const id = `o${this.nextId++}`;
      if (!this.usedIds.has(id)) {
        this.usedIds.add(id);
        return id;
      }
    }
  }

  /** Base + priority fee every sent order pays, filled or not. */
  txFeeLamports(): bigint {
    return BigInt(this.hello.fees.base_fee_lamports) + BigInt(this.hello.fees.priority_fee_lamports);
  }

  /**
   * The size cap on this mint now: the most this batch's buys on it may
   * spend together. 0n when unknown or complete.
   */
  maxBuyLamports(mint: Pubkey): bigint {
    const c = this.curves.get(mint);
    if (c === undefined || c.complete) return 0n;
    return (c.real_quote_reserves * BigInt(this.hello.caps.max_order_bps_of_real_reserve)) / BPS;
  }

  /** Mints held plus mints with a buy pending: what counts against the cap. */
  committedPositionCount(): number {
    const mints = new Set<Pubkey>(this.positions.keys());
    for (const p of this.pending.values()) if (p.order.side === "buy") mints.add(p.order.mint);
    return mints.size;
  }

  /** Cash minus what pending orders will take if they fill. May go negative. */
  freeCashLamports(): bigint {
    const tx = this.txFeeLamports();
    let free = this.cash;
    for (const p of this.pending.values()) {
      free -= tx;
      if (p.order.side === "buy") free -= BigInt(p.order.quote_lamports);
    }
    return free;
  }

  /** Fold a batch in: its fills, account, marks and events, in that order. */
  applyBatch(batch: Batch): void {
    this.seq = batch.seq;
    this.slot = batch.slot;
    for (const f of batch.fills) this.pending.delete(f.client_id);
    this.setAccount(batch.account);
    for (const m of batch.marks) {
      const c = this.curves.get(m.mint);
      if (c !== undefined && m.slot < c.reserves_slot) continue;
      const curve = c ?? this.newCurve(m.mint, null, m.slot);
      curve.virtual_token_reserves = BigInt(m.virtual_token_reserves);
      curve.virtual_quote_reserves = BigInt(m.virtual_quote_reserves);
      curve.real_token_reserves = BigInt(m.real_token_reserves);
      curve.real_quote_reserves = BigInt(m.real_quote_reserves);
      curve.reserves_slot = m.slot;
    }
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        const curve = this.newCurve(e.mint, e.slot, e.slot);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(e.real_token_reserves);
        curve.real_quote_reserves = 0n;
      } else if (e.event === "TradeEvent") {
        const curve = this.curves.get(e.mint) ?? this.newCurve(e.mint, null, e.slot);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(e.real_token_reserves);
        curve.real_quote_reserves = BigInt(e.real_quote_reserves);
        curve.reserves_slot = e.slot;
        curve.trades += 1;
      } else {
        const curve = this.curves.get(e.mint) ?? this.newCurve(e.mint, null, e.slot);
        curve.complete = true;
      }
    }
  }

  applyDone(done: Done): void {
    this.seq = done.seq;
    this.setAccount(done.account);
  }

  /**
   * Validate what the strategy returned and turn it into wire orders
   * (assigning missing client_ids). Throws on anything the harness would
   * call a protocol violation, so a broken bot fails here, not in grading.
   */
  toOrders(result: unknown): Order[] {
    if (result === undefined || result === null) return [];
    if (!Array.isArray(result)) throw new Error(`batch ${this.seq}: strategy must return an array of orders`);
    const cap = this.hello.caps.max_orders_per_batch;
    if (result.length > cap) {
      throw new Error(`batch ${this.seq}: ${result.length} orders over the per-batch cap of ${cap}`);
    }
    const taken = new Set<string>();
    const orders: Order[] = [];
    for (let i = 0; i < result.length; i++) {
      const o = result[i] as Record<string, unknown>;
      if (typeof o !== "object" || o === null || Array.isArray(o)) {
        throw new Error(`batch ${this.seq} order ${i}: expected an order object`);
      }
      if (o.side !== "buy" && o.side !== "sell") {
        throw new Error(`batch ${this.seq} order ${i}: side must be "buy" or "sell"`);
      }
      const allowed = o.side === "buy"
        ? ["side", "client_id", "mint", "quote_lamports", "max_slippage_bps"]
        : ["side", "client_id", "mint", "token_amount", "max_slippage_bps"];
      for (const k of Object.keys(o)) {
        if (!allowed.includes(k)) throw new Error(`batch ${this.seq} order ${i}: unknown key "${k}"`);
      }
      if (typeof o.mint !== "string" || !PUBKEY_RE.test(o.mint)) {
        throw new Error(`batch ${this.seq} order ${i}: mint must be a base58 address`);
      }
      const amountKey = o.side === "buy" ? "quote_lamports" : "token_amount";
      const amount = toU64(o[amountKey], `batch ${this.seq} order ${i}: ${amountKey}`);
      const bps = o.max_slippage_bps;
      if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
        throw new Error(`batch ${this.seq} order ${i}: max_slippage_bps must be an integer 0..10000`);
      }
      let clientId: string | undefined;
      if (o.client_id !== undefined) {
        if (typeof o.client_id !== "string" || !CLIENT_ID_RE.test(o.client_id)) {
          throw new Error(`batch ${this.seq} order ${i}: bad client_id`);
        }
        clientId = o.client_id;
      }
      if (clientId !== undefined) {
        if (taken.has(clientId) || this.usedIds.has(clientId)) {
          throw new Error(`batch ${this.seq} order ${i}: duplicate client_id ${clientId}`);
        }
        taken.add(clientId);
      }
      const id = clientId ?? this.freshId(taken);
      taken.add(id);
      if (o.side === "buy") {
        orders.push({ side: "buy", client_id: id, mint: o.mint as string, quote_lamports: amount, max_slippage_bps: bps });
      } else {
        orders.push({ side: "sell", client_id: id, mint: o.mint as string, token_amount: amount, max_slippage_bps: bps });
      }
    }
    return orders;
  }

  /** Record orders as sent on the current batch. */
  recordOrders(orders: readonly Order[]): void {
    for (const order of orders) {
      this.usedIds.add(order.client_id);
      this.pending.set(order.client_id, { order, seq: this.seq, decided_slot: this.slot });
    }
  }

  private freshId(taken: Set<string>): string {
    for (;;) {
      const id = `o${this.nextId++}`;
      if (!this.usedIds.has(id) && !taken.has(id)) return id;
    }
  }

  private newCurve(mint: Pubkey, created: number | null, slot: number): Curve {
    const curve: Curve = {
      mint,
      created_slot: created,
      virtual_token_reserves: 0n,
      virtual_quote_reserves: 0n,
      real_token_reserves: 0n,
      real_quote_reserves: 0n,
      reserves_slot: slot,
      trades: 0,
      complete: false,
    };
    this.curves.set(mint, curve);
    return curve;
  }

  private setAccount(account: Account): void {
    this.account = account;
    this.cash = BigInt(account.cash_lamports);
    this.positions.clear();
    for (const p of account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) {
        this.positions.set(p.mint, { token_amount: tokens, cost_lamports: BigInt(p.cost_lamports) });
      }
    }
  }
}

async function main(): Promise<void> {
  const strategy = createStrategy();
  let state: BotState | null = null;
  let batches = 0;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === "") continue;
    const msg = JSON.parse(line) as { type?: unknown };
    if (msg.type === "hello") {
      if (state !== null) throw new Error("a second hello");
      state = new BotState(msg as unknown as Hello);
    } else if (msg.type === "batch") {
      const batch = msg as unknown as Batch;
      if (state === null) throw new Error("a batch before hello");
      state.applyBatch(batch);
      const orders = state.toOrders(strategy.onBatch(state, batch));
      const reply = JSON.stringify({ type: "reply", seq: batch.seq, orders });
      state.recordOrders(orders);
      process.stdout.write(`${reply}\n`);
      batches++;
    } else if (msg.type === "done") {
      const done = msg as unknown as Done;
      if (state === null) throw new Error("done before hello");
      state.applyDone(done);
      strategy.onDone?.(state, done);
      console.error(`sprint: done after ${batches} batches, cash ${state.cash} lamports`);
      return;
    } else {
      throw new Error(`unknown message type ${String(msg.type)}`);
    }
  }
  throw new Error(state === null ? "input ended before hello" : `input ended before done (after ${batches} batches)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
