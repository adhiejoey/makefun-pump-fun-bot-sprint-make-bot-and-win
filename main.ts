// Pump.fun paper-trading bot for the agent-fun/replay/v2 protocol.
//
// Strategy in one paragraph: watch every new bonding curve, and only step in
// when early trading shows real buying pressure — the price has climbed at
// least 1% above where the coin was first seen, across at least two trades
// with meaningful buy volume. Buy a small fixed slice (0.25 SOL, capped below
// 1% of the coin's real SOL reserve so the order is never oversized), hold at
// most five coins at once, and flip fast: take profit at +15%, cut the loss
// at -8%, trail the peak by 5%, or exit after 200 slots no matter what. One
// trade per mint ever, so turnover keeps spreading across new coins instead
// of churning the same ones. On the kit's dev window this fast-flip shape
// lost the least of the shapes tried (about -0.9 SOL under a naive fill
// model, max drawdown under 10%) while clearing the 20-mint round-trip bar
// many times over.
//
// The bot is fully deterministic: no clocks, no randomness, no network. It
// reads newline-delimited JSON (hello / batch / done) on stdin and writes one
// reply line per batch on stdout.

import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Wire shapes (the replay protocol's message fields, as documented in the kit)
// ---------------------------------------------------------------------------

interface HelloMsg {
  type: "hello";
  protocol: string;
  seed: string;
  capital: { lamports: string };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
  };
  latency_slots: number;
}

interface TradeEv {
  event: "TradeEvent";
  mint: string;
  sol_amount: string;
  is_buy: boolean;
  virtual_quote_reserves: string;
  virtual_token_reserves: string;
  real_quote_reserves: string;
  slot: number;
}

interface CreateEv {
  event: "CreateEvent";
  mint: string;
  virtual_quote_reserves: string;
  virtual_token_reserves: string;
  slot: number;
}

interface CompleteEv {
  event: "CompleteEvent";
  mint: string;
  slot: number;
}

type ChainEv = TradeEv | CreateEv | CompleteEv;

interface MarkMsg {
  mint: string;
  slot: number;
  virtual_quote_reserves: string;
  virtual_token_reserves: string;
  real_quote_reserves: string;
}

interface PositionMsg {
  mint: string;
  token_amount: string;
  cost_lamports: string;
}

interface BatchMsg {
  type: "batch";
  seq: number;
  slot: number;
  events: ChainEv[];
  marks: MarkMsg[];
  account: { cash_lamports: string; positions: PositionMsg[] };
}

interface OrderOut {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

// ---------------------------------------------------------------------------
// Strategy constants
// ---------------------------------------------------------------------------

const BUY_LAMPORTS = 250_000_000; // 0.25 SOL per entry
const MIN_BUY_LAMPORTS = 12_000_000; // stay safely above the 0.01 SOL round-trip bar
const MAX_OPEN = 5;
const MAX_BUYS_PER_BATCH = 2;
const MIN_TRADES_BEFORE_BUY = 2;
const MIN_BUY_VOLUME_LAMPORTS = 50_000_000; // 0.05 SOL of buys seen
const RISE_TO_ENTER_BPS = 1_010; // price >= 101% of first-seen price
const TAKE_PROFIT_BPS = 11_500; // +15% over entry price
const STOP_LOSS_BPS = 9_200; // -8% under entry price
const TRAIL_DROP_BPS = 9_500; // -5% from the peak since entry
const MAX_HOLD_SLOTS = 200;
const SLIPPAGE_BPS = 500; // 5%

// ---------------------------------------------------------------------------
// Per-coin bookkeeping
// ---------------------------------------------------------------------------

interface CoinState {
  firstPrice: number; // quote lamports per token at first sight
  lastPrice: number;
  realReserve: bigint; // latest real SOL reserve in lamports
  trades: number;
  buyVolume: bigint; // lamports of buy-side volume seen
  seenSlot: number;
}

interface OpenTrade {
  entryPrice: number;
  peakPrice: number;
  entrySlot: number;
}

const coins = new Map<string, CoinState>();
const openTrades = new Map<string, OpenTrade>();
const everTraded = new Set<string>();
const completed = new Set<string>();
// Coins whose state changed in the batch being decided: the only ones whose
// entry test can have flipped, so the entry scan stays proportional to the
// batch instead of to every coin ever seen.
const touched = new Set<string>();

let cashLamports = 0n;
let maxPositions = MAX_OPEN;
let nextClient = 1;

function priceOf(virtualQuote: string, virtualToken: string): number {
  const q = Number(BigInt(virtualQuote));
  const t = Number(BigInt(virtualToken));
  if (t <= 0) return 0;
  return q / t;
}

function freshClientId(prefix: string): string {
  const id = prefix + String(nextClient);
  nextClient += 1;
  return id;
}

function noteTrade(mint: string, slot: number, price: number, realReserve: string, isBuy: boolean, solAmount: string): void {
  touched.add(mint);
  let coin = coins.get(mint);
  if (coin === undefined) {
    coin = {
      firstPrice: price,
      lastPrice: price,
      realReserve: BigInt(realReserve),
      trades: 0,
      buyVolume: 0n,
      seenSlot: slot,
    };
    coins.set(mint, coin);
  }
  coin.lastPrice = price;
  coin.realReserve = BigInt(realReserve);
  coin.trades += 1;
  if (isBuy) coin.buyVolume += BigInt(solAmount);
}

function noteCreate(mint: string, slot: number, price: number): void {
  touched.add(mint);
  if (!coins.has(mint)) {
    coins.set(mint, {
      firstPrice: price,
      lastPrice: price,
      realReserve: 0n,
      trades: 0,
      buyVolume: 0n,
      seenSlot: slot,
    });
  }
}

// ---------------------------------------------------------------------------
// One batch in, orders out
// ---------------------------------------------------------------------------

function decide(batch: BatchMsg): OrderOut[] {
  const orders: OrderOut[] = [];
  touched.clear();

  for (const ev of batch.events ?? []) {
    if (ev.event === "TradeEvent") {
      noteTrade(
        ev.mint,
        ev.slot,
        priceOf(ev.virtual_quote_reserves, ev.virtual_token_reserves),
        ev.real_quote_reserves,
        ev.is_buy,
        ev.sol_amount,
      );
    } else if (ev.event === "CreateEvent") {
      noteCreate(ev.mint, ev.slot, priceOf(ev.virtual_quote_reserves, ev.virtual_token_reserves));
    } else if (ev.event === "CompleteEvent") {
      completed.add(ev.mint);
    }
  }

  // Marks refresh the latest price of coins we hold or have pending.
  for (const mark of batch.marks ?? []) {
    const coin = coins.get(mark.mint);
    if (coin !== undefined) {
      touched.add(mark.mint);
      coin.lastPrice = priceOf(mark.virtual_quote_reserves, mark.virtual_token_reserves);
      coin.realReserve = BigInt(mark.real_quote_reserves);
    }
  }

  const held = new Map<string, PositionMsg>();
  for (const pos of batch.account?.positions ?? []) {
    held.set(pos.mint, pos);
  }
  cashLamports = BigInt(batch.account?.cash_lamports ?? "0");

  // Forget trades whose position is gone (sold, completed, or flattened).
  for (const mint of [...openTrades.keys()]) {
    if (!held.has(mint)) openTrades.delete(mint);
  }

  // ---- exits first: free a slot before looking for new entries ----
  for (const [mint, pos] of held) {
    const coin = coins.get(mint);
    const trade = openTrades.get(mint);
    if (coin === undefined || trade === undefined) continue;
    if (completed.has(mint)) continue; // the harness closes completed coins itself
    const price = coin.lastPrice;
    if (price <= 0 || trade.entryPrice <= 0) continue;
    if (price > trade.peakPrice) trade.peakPrice = price;
    const upBps = Math.floor((price / trade.entryPrice) * 10_000);
    const downFromPeakBps = Math.floor((price / trade.peakPrice) * 10_000);
    const heldLong = batch.slot - trade.entrySlot >= MAX_HOLD_SLOTS;
    const takeProfit = upBps >= TAKE_PROFIT_BPS;
    const stopLoss = upBps <= STOP_LOSS_BPS;
    const trailHit = downFromPeakBps <= TRAIL_DROP_BPS && upBps > 10_000;
    if (takeProfit || stopLoss || trailHit || heldLong) {
      orders.push({
        side: "sell",
        client_id: freshClientId("s"),
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      openTrades.delete(mint);
    }
  }

  // ---- entries: momentum only, one trade per mint, small fixed size ----
  // Only coins touched by this batch can newly pass the entry test.
  if (held.size + orders.filter((o) => o.side === "buy").length < maxPositions) {
    let buys = 0;
    for (const mint of touched) {
      if (buys >= MAX_BUYS_PER_BATCH) break;
      if (held.size + buys >= maxPositions) break;
      const coin = coins.get(mint);
      if (coin === undefined) continue;
      if (held.has(mint) || everTraded.has(mint) || completed.has(mint)) continue;
      if (coin.trades < MIN_TRADES_BEFORE_BUY) continue;
      if (coin.buyVolume < BigInt(MIN_BUY_VOLUME_LAMPORTS)) continue;
      if (coin.firstPrice <= 0 || coin.lastPrice <= 0) continue;
      const riseBps = Math.floor((coin.lastPrice / coin.firstPrice) * 10_000);
      if (riseBps < RISE_TO_ENTER_BPS) continue;
      // Size the buy below the per-order reserve cap, and skip tiny reserves.
      let size = BigInt(BUY_LAMPORTS);
      const reserveCap = (coin.realReserve * 80n) / 10_000n; // 0.8% of real reserve
      if (reserveCap < size) size = reserveCap;
      if (size < BigInt(MIN_BUY_LAMPORTS)) continue;
      if (size > cashLamports) continue;
      orders.push({
        side: "buy",
        client_id: freshClientId("b"),
        mint,
        quote_lamports: size.toString(),
        max_slippage_bps: SLIPPAGE_BPS,
      });
      everTraded.add(mint);
      openTrades.set(mint, {
        entryPrice: coin.lastPrice,
        peakPrice: coin.lastPrice,
        entrySlot: batch.slot,
      });
      buys += 1;
    }
  }

  return orders;
}

// ---------------------------------------------------------------------------
// Main loop: read hello / batch / done lines, answer each batch with a reply
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const text = line.trim();
    if (text === "") continue;
    let msg: { type?: unknown; seq?: unknown };
    try {
      msg = JSON.parse(text) as { type?: unknown; seq?: unknown };
    } catch {
      continue; // never crash on one bad line; keep the run alive
    }
    if (msg.type === "hello") {
      const hello = msg as unknown as HelloMsg;
      cashLamports = BigInt(hello.capital?.lamports ?? "0");
      if (hello.caps && hello.caps.max_open_positions > 0) {
        maxPositions = Math.min(hello.caps.max_open_positions, MAX_OPEN);
      }
    } else if (msg.type === "batch") {
      const batch = msg as unknown as BatchMsg;
      const orders = decide(batch);
      const reply = JSON.stringify({ type: "reply", seq: batch.seq, orders });
      process.stdout.write(reply + "\n");
    } else if (msg.type === "done") {
      break;
    }
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(1),
);
