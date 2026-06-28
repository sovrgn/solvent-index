/**
 * Stress test: run thousands of cohorts through the real on-chain program
 * via bankrun with time warping. Vault serves as market maker of first resort;
 * overflow demand routes to pooled P2P writers. Drives the same on-chain
 * instructions the keeper calls:
 *   start_cohort → buy_call (vault) → buy_call_p2p (overflow) →
 *   submit_mhi → settle_batch → settle_batch_p2p (payouts atomic) →
 *   close_position / close_p2p_position → close_cohort
 *
 * Uses the keeper's MHI computation library with empirical return data.
 *
 * Usage: npx ts-mocha -p ./tsconfig.json -t 600000 tests/stress/stress-cohorts.test.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import {
  setupProtocol,
  warpTime,
  fundedKeypair,
  assertVaultConservation,
  findCohortPda,
  findPositionPda,
  findP2pPositionPda,
  deriveStrikes,
  SOL,
  FAST_CLAIM_EXPIRY,
  FAST_TRADING_WINDOW,
  FAST_MEASUREMENT,
  FAST_OBSERVATION,
  FAST_SETTLEMENT_DEADLINE,
  type TestCtx,
} from "../instructions/_setup";
// Inline the keeper's computeMhi logic (can't import ESM keeper modules from CJS tests)
function computeMhi(returns: number[]): number {
  const sorted = [...returns].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
  return Math.round(median * 10_000);
}

// Default is the full 10K-cohort run. Override with STRESS_COHORTS=<n> for a
// fast smoke run (e.g. STRESS_COHORTS=50) — coverage of the full path is
// identical, only the iteration count changes.
const NUM_COHORTS = Number(process.env.STRESS_COHORTS ?? 10_000);
const VAULT_SEED_SOL = 200;
const POOL_SEED_SOL = 30;         // Total P2P pool deposit across all writers
const NUM_WRITERS = 5;
const LOG_EVERY = 1_000;

// Buyer growth: starts at 3, grows 33% every 300 cohorts, max 15
const BASE_BUYERS = 3;
const GROWTH_INTERVAL = 300;
const GROWTH_RATE = 1.33;
const MAX_BUYERS = 15;

const FULL_CYCLE_WARP =
  FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION +
  FAST_SETTLEMENT_DEADLINE + FAST_CLAIM_EXPIRY + 3;

// Source: pool-creations-21-03.jsonl via simulations/mhi-real-21-03.js
// These are individual token returns, NOT cohort medians.
const RETURN_PCTS = [
  0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35,
  0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75,
  0.80, 0.85, 0.90, 0.95, 1.00,
];
const RETURN_VALUES = [
  0.0001,  // p0 rug
  0.032,   // p5
  0.157,   // p10
  0.568,   // p15
  1.000,   // p20
  1.007,   // p25
  1.074,   // p30
  1.139,   // p35
  1.212,   // p40
  1.277,   // p45
  1.377,   // p50
  1.523,   // p55
  1.755,   // p60
  2.084,   // p65
  2.164,   // p70
  2.215,   // p75
  2.263,   // p80
  2.347,   // p85
  3.149,   // p90
  20.407,  // p95
  100.0,   // p100
];

/** Sample a single token's 15-min return from the empirical distribution. */
function sampleReturn(): number {
  const u = Math.random();
  for (let i = 1; i < RETURN_PCTS.length; i++) {
    if (u <= RETURN_PCTS[i]!) {
      const t = (u - RETURN_PCTS[i - 1]!) / (RETURN_PCTS[i]! - RETURN_PCTS[i - 1]!);
      return RETURN_VALUES[i - 1]! + t * (RETURN_VALUES[i]! - RETURN_VALUES[i - 1]!);
    }
  }
  return RETURN_VALUES[RETURN_VALUES.length - 1]!;
}

/**
 * Compute a realistic MHI using the keeper's actual computeMhi() function
 * with 20 token returns sampled from the empirical distribution.
 */
function sampleMhiBps(): number {
  const returns: number[] = [];
  for (let i = 0; i < 20; i++) {
    returns.push(sampleReturn());
  }
  return computeMhi(returns);
}

function randomStrike(strikes: number[]): number {
  return strikes[Math.floor(Math.random() * strikes.length)]!;
}

const MHI_CAP_BPS = 30_000;
const VAULT_RISK_BPS = 2_500;    // 25% per cohort
const MIN_BET_LAMPORTS = 50_000_000;       // 0.05 SOL
const MAX_BET_LAMPORTS = 10_000_000_000;   // 10 SOL

/**
 * Compute a random position size that fits within the cohort collateral cap,
 * clamped to [0.05, 10] SOL. No per-position cap - bonding curve midpoint
 * pricing naturally charges whales more for taking large capacity.
 */
function randomSize(vaultTotal: number, strike: number): anchor.BN {
  const cohortCap = vaultTotal * VAULT_RISK_BPS / 10_000;
  const perUnitBps = MHI_CAP_BPS - strike;
  if (perUnitBps <= 0) return new anchor.BN(MIN_BET_LAMPORTS);
  const maxSize = cohortCap * 10_000 / perUnitBps;
  let maxLamports = Math.min(Math.floor(maxSize * 1e9), MAX_BET_LAMPORTS);
  if (maxLamports < MIN_BET_LAMPORTS) maxLamports = MIN_BET_LAMPORTS;
  const size = MIN_BET_LAMPORTS + Math.floor(Math.random() * (maxLamports - MIN_BET_LAMPORTS));
  return new anchor.BN(size);
}

/**
 * Compute rolling APR the way DeFi protocols do:
 *   APR = (sum of net earnings over window) / (avg TVL over window) × (365 / days_in_window)
 * This is the rate a new depositor would earn at current conditions.
 */
function computeRollingApr(
  history: Array<{ poolTvl: number; poolEarnings: number; vaultTvl: number; vaultEarnings: number }>,
  windowCohorts: number,
  cohortsPerDay: number,
): { poolApr: number; vaultApr: number } {
  const n = Math.min(history.length, windowCohorts);
  if (n === 0) return { poolApr: 0, vaultApr: 0 };
  const window = history.slice(-n);
  let poolEarnings = 0, poolTvlSum = 0;
  let vaultEarnings = 0, vaultTvlSum = 0;
  for (const s of window) {
    poolEarnings += s.poolEarnings;
    poolTvlSum += s.poolTvl;
    vaultEarnings += s.vaultEarnings;
    vaultTvlSum += s.vaultTvl;
  }
  const avgPoolTvl = poolTvlSum / n;
  const avgVaultTvl = vaultTvlSum / n;
  const days = n / cohortsPerDay;
  const poolApr = avgPoolTvl > 0 ? (poolEarnings / avgPoolTvl) * (365 / days) * 100 : 0;
  const vaultApr = avgVaultTvl > 0 ? (vaultEarnings / avgVaultTvl) * (365 / days) * 100 : 0;
  return { poolApr, vaultApr };
}

/** Compute buyer count for this cohort: starts at 3, grows 33% every 300 cohorts, max 15 */
function buyerCount(cohortIndex: number): number {
  const growthSteps = Math.floor(cohortIndex / GROWTH_INTERVAL);
  const count = Math.floor(BASE_BUYERS * Math.pow(GROWTH_RATE, growthSteps));
  return Math.min(count, MAX_BUYERS);
}


describe(`Stress: ${NUM_COHORTS} cohorts, vault(${VAULT_SEED_SOL}) + P2P pool(${POOL_SEED_SOL}), real MHI`, function () {
  this.timeout(3_600_000); // 60 min for 10K cohorts

  let t: TestCtx;
  let buyers: Keypair[];
  let poolPda: PublicKey;

  let totalPremiums = 0;
  let totalPayouts = 0;
  let totalPositions = 0;
  let totalWinners = 0;
  let mhiSum = 0;
  let mhiMin = Infinity;
  let mhiMax = 0;

  let vaultPositions = 0;
  let vaultFailed = 0;      // vault buy_call failed (capacity exhausted)
  let vaultPremiums = 0;
  let vaultPayouts = 0;
  let vaultWinners = 0;

  let p2pPositions = 0;
  let p2pFailed = 0;         // P2P also failed (both vault and pool exhausted)
  let p2pPremiums = 0;
  let p2pPayouts = 0;
  let p2pWinners = 0;
  let protocolP2pFees = 0;   // buyer fee + writer fee on P2P premiums
  let writerPremiums = 0;    // premium portion going to writers (after protocol fee)

  // Track top multipliers (payout / premium)
  const topMultipliers: Array<{
    mult: number; payout: number; premium: number;
    strike: number; mhi: number; cohort: number;
    source: "vault" | "p2p";
  }> = [];
  const TOP_N = 20;

  // Per-strike stats (combined vault + P2P)
  const strikeStats = new Map<number, {
    count: number; wins: number; premiums: number; payouts: number; maxMult: number;
    vaultCount: number; p2pCount: number;
  }>();
  // MHI histogram buckets
  const mhiBuckets = new Map<string, number>();
  // Drawdown tracking
  let vaultPeak = VAULT_SEED_SOL;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let drawdownCohort = 0;
  // Extraction tracking (vault right-sizing via failure-rate feedback)
  let totalExtracted = 0;
  const ABSOLUTE_MIN_VAULT = 200;
  const TARGET_FAILURE_RATE = 0.01;
  const SHRINK_FACTOR = 0.95;
  let vaultTarget = VAULT_SEED_SOL;
  interface CohortRecord { units: number; failed: number; collateral: number; pnl: number }
  const recentCohorts: CohortRecord[] = [];
  // Fee tracking (1.5% volume fee on vault premiums)
  const PREMIUM_FEE_BPS = 150;
  let totalVaultFees = 0;
  // Winner profit tracking
  let winnerPremiums = 0;
  let winnerPayouts = 0;
  let maxProfit = 0;
  let maxProfitDetails = { premium: 0, payout: 0, strike: 0, mhi: 0, cohort: 0, source: "vault" as "vault" | "p2p" };

  // P2P pool drawdown tracking
  let poolPeak = POOL_SEED_SOL;
  let poolMaxDrawdown = 0;
  let poolMaxDrawdownPct = 0;
  let poolDrawdownCohort = 0;

  // Per-cohort overflow tracking
  let cohortsWithOverflow = 0;

  // Per-cohort snapshots for rolling window calculations
  // ~58 cohorts/day → 300 cohorts ≈ 5.2 days, 600 ≈ 10.3 days
  const COHORTS_PER_DAY = 58;
  interface YieldSnapshot {
    // P2P pool
    poolTvl: number;            // total pool value at end of cohort
    poolEarnings: number;       // writer premium - payout this cohort (net to pool)
    // Vault
    vaultTvl: number;           // vault available + active collateral
    vaultEarnings: number;      // vault premium - payout this cohort (net to vault)
  }
  const yieldHistory: YieldSnapshot[] = [];

  // Yield curve: APR at each reporting interval for the chart
  const yieldCurve: Array<{
    cohort: number;
    poolRolling1dApr: number;
    poolRolling7dApr: number;
    poolRolling30dApr: number;
    vaultRolling1dApr: number;
    vaultRolling7dApr: number;
    vaultRolling30dApr: number;
  }> = [];

  before(async () => {
    t = await setupProtocol({ seedSol: VAULT_SEED_SOL });

    // Enable per-position collateral cap: disabled - bonding curve handles whales
    await t.program.methods
      .updateConfig({
        keeper: null, mhiCapBps: null, premiumFeeBps: null, referralShareBps: null,
        keeperFeeLamports: null, minPositionLamports: null, minPremiumLamports: null,
        maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: 2500,
        maxPositionCollateralBps: 0, // disabled - bonding curve handles whales
        tradingWindowSeconds: null, measurementSeconds: null,
        observationSeconds: null, settlementDeadlineSeconds: null,
        claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null,
        paused: null,
      })
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();

    // P2P pool already initialized by setupProtocol.
    [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("p2p_pool")], t.program.programId);

    // Enable P2P (5% buyer fee + 20% writer fee = 25% protocol take on P2P premiums)
    await (t.program.methods as any).updateP2PConfig({
      p2PBuyerFeeBps: 500,
      p2PWriterFeeBps: 2000,
      p2PEnabled: true,
      acceptingDeposits: true,
    }).accounts({
      authority: t.authority.publicKey,
      globalState: t.globalState,
      p2PPool: poolPda,
    } as any).rpc();

    const depositPerWriter = Math.floor(POOL_SEED_SOL / NUM_WRITERS);
    for (let i = 0; i < NUM_WRITERS; i++) {
      const writer = await fundedKeypair(t.context, 1000);
      const [wa] = PublicKey.findProgramAddressSync(
        [Buffer.from("writer_account"), writer.publicKey.toBuffer()],
        t.program.programId,
      );
      await (t.program.methods as any).registerWriter()
        .accounts({
          writer: writer.publicKey,
          writerAccount: wa,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([writer]).rpc();

      await (t.program.methods as any).depositP2P(SOL(depositPerWriter))
        .accounts({
          writer: writer.publicKey,
          p2PPool: poolPda,
          writerAccount: wa,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([writer]).rpc();
    }

    buyers = [];
    for (let i = 0; i < MAX_BUYERS; i++) {
      buyers.push(await fundedKeypair(t.context, 50_000));
    }
  });

  it(`runs ${NUM_COHORTS} cohorts with vault + P2P pool overflow`, async () => {
    const startTime = Date.now();

    for (let c = 0; c < NUM_COHORTS; c++) {
      // submit_mhi rejects mhi_bps > cap; the real keeper clamps before
      // submitting, so mirror that here.
      const mhiBps = Math.min(sampleMhiBps(), MHI_CAP_BPS);
      mhiSum += mhiBps;
      if (mhiBps < mhiMin) mhiMin = mhiBps;
      if (mhiBps > mhiMax) mhiMax = mhiBps;

      // MHI histogram: 10% buckets
      const bucket = `${Math.floor(mhiBps / 1000) * 10}%-${Math.floor(mhiBps / 1000) * 10 + 10}%`;
      mhiBuckets.set(bucket, (mhiBuckets.get(bucket) ?? 0) + 1);

      const gs = await t.program.account.globalState.fetch(t.globalState);
      const idx = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(t.program.programId, idx);

      // start_cohort requires strikes == derive_strikes(strike_anchor_bps)
      // exactly, and buy_call only accepts strikes from this ladder. The anchor
      // drifts each cohort, so derive fresh every round.
      const cohortStrikes = deriveStrikes((gs as any).strikeAnchorBps as number);

      await t.program.methods
        .startCohort(cohortStrikes)
        .accounts({
          keeper: t.keeper.publicKey,
          globalState: t.globalState,
          vault: t.vault,
          cohort: cohortPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([t.keeper])
        .rpc();

      const vaultPosPdas: Array<{
        pda: PublicKey; buyer: Keypair; premium: number;
        strike: number;
      }> = [];
      const p2pPosPdas: Array<{
        pda: PublicKey; buyer: Keypair; premium: number; writerPremium: number;
        strike: number;
      }> = [];
      let cohortVaultPremiums = 0;
      let cohortP2pPremiums = 0;
      let cohortVaultPayouts = 0;
      let cohortP2pWriterPremiums = 0;  // writer's share (after protocol fee)
      let cohortP2pPayouts = 0;
      let cohortOverflowed = false;
      const maxThisCohort = buyerCount(c);
      const numBuyers = Math.max(1, Math.floor(maxThisCohort * (0.5 + Math.random() * 0.5)));
      const cohortBuyers = buyers.slice(0, numBuyers);

      // Read vault total once for position sizing
      const vaultForSizing = await t.program.account.vault.fetch(t.vault);
      const vaultTotalSol = ((vaultForSizing.availableLamports as anchor.BN).toNumber()
        + (vaultForSizing.activeCollateralLamports as anchor.BN).toNumber()) / LAMPORTS_PER_SOL;

      for (const buyer of cohortBuyers) {
        const strike = randomStrike(cohortStrikes);
        const size = randomSize(vaultTotalSol, strike);
        const nonce = 0;

        // Try vault first
        const [vaultPosPda] = findPositionPda(
          t.program.programId, cohortPda, buyer.publicKey, strike, nonce,
        );

        try {
          await t.program.methods
            .buyCall(strike, size, nonce)
            .accounts({
              buyer: buyer.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              p2pPool: poolPda,
              cohort: cohortPda,
              emaState: t.emaState,
              position: vaultPosPda,
              systemProgram: SystemProgram.programId,
            } as any)
            .signers([buyer])
            .rpc();

          const pos = await t.program.account.position.fetch(vaultPosPda);
          const premium = (pos.premiumPaidLamports as anchor.BN).toNumber() / LAMPORTS_PER_SOL;
          cohortVaultPremiums += premium;
          vaultPosPdas.push({ pda: vaultPosPda, buyer, premium, strike });
          vaultPositions++;
          totalPositions++;
          continue;
        } catch {
          vaultFailed++;
        }

        // Vault failed → overflow to P2P pool
        const [p2pPosPda] = findP2pPositionPda(
          t.program.programId, cohortPda, buyer.publicKey, strike, nonce,
        );

        try {
          await (t.program.methods as any).buyCallP2P(strike, size, nonce)
            .accounts({
              buyer: buyer.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              p2PPool: poolPda,
              cohort: cohortPda,
              emaState: t.emaState,
              p2PPosition: p2pPosPda,
              systemProgram: SystemProgram.programId,
            } as any)
            .signers([buyer])
            .rpc();

          const pos = await (t.program.account as any).p2PPosition.fetch(p2pPosPda);
          const premium = (pos.premiumPaidLamports as anchor.BN).toNumber() / LAMPORTS_PER_SOL;
          const writerPrem = (pos.writerPremiumLamports as anchor.BN).toNumber() / LAMPORTS_PER_SOL;
          cohortP2pPremiums += premium;
          p2pPosPdas.push({ pda: p2pPosPda, buyer, premium, writerPremium: writerPrem, strike });
          p2pPositions++;
          totalPositions++;
          cohortOverflowed = true;
        } catch {
          p2pFailed++;
        }
      }

      if (cohortOverflowed) cohortsWithOverflow++;

      await warpTime(t.context, FULL_CYCLE_WARP);

      await t.program.methods
        .submitMhi(mhiBps, 20, Array.from({ length: 32 }, () => 0))
        .accounts({
          keeper: t.keeper.publicKey,
          globalState: t.globalState,
          cohort: cohortPda,
          emaState: t.emaState,
          vault: t.vault,
        } as any)
        .signers([t.keeper])
        .rpc();

      const BATCH_SIZE = 20;
      if (vaultPosPdas.length === 0 && p2pPosPdas.length === 0) {
        // Empty cohort - still need to call settle to advance state
        await t.program.methods
          .settleBatch()
          .accounts({
            caller: t.keeper.publicKey,
            globalState: t.globalState,
            vault: t.vault,
            cohort: cohortPda,
          } as any)
          .remainingAccounts([])
          .signers([t.keeper])
          .rpc();
      } else if (vaultPosPdas.length > 0) {
        for (let b = 0; b < vaultPosPdas.length; b += BATCH_SIZE) {
          const batch = vaultPosPdas.slice(b, b + BATCH_SIZE);
          await t.program.methods
            .settleBatch()
            .accounts({
              caller: t.keeper.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              cohort: cohortPda,
            } as any)
            .remainingAccounts(
              // settle now expects (position, owner) pairs: payout is sent to
              // the owner directly in the same tx, no separate claim step.
              batch.flatMap((p) => [
                { pubkey: p.pda, isWritable: true, isSigner: false },
                { pubkey: p.buyer.publicKey, isWritable: true, isSigner: false },
              ]),
            )
            .signers([t.keeper])
            .rpc();
        }
      } else {
        // No vault positions but P2P positions exist - still settle vault side (empty)
        await t.program.methods
          .settleBatch()
          .accounts({
            caller: t.keeper.publicKey,
            globalState: t.globalState,
            vault: t.vault,
            cohort: cohortPda,
          } as any)
          .remainingAccounts([])
          .signers([t.keeper])
          .rpc();
      }

      if (p2pPosPdas.length > 0) {
        for (let b = 0; b < p2pPosPdas.length; b += BATCH_SIZE) {
          const batch = p2pPosPdas.slice(b, b + BATCH_SIZE);
          await (t.program.methods as any).settleBatchP2P()
            .accounts({
              caller: t.keeper.publicKey,
              globalState: t.globalState,
              p2PPool: poolPda,
              cohort: cohortPda,
            } as any)
            .remainingAccounts(
              // settle now expects (position, owner) pairs: payout is sent to
              // the owner directly in the same tx, no separate claim step.
              batch.flatMap((p) => [
                { pubkey: p.pda, isWritable: true, isSigner: false },
                { pubkey: p.buyer.publicKey, isWritable: true, isSigner: false },
              ]),
            )
            .signers([t.keeper])
            .rpc();
        }
      }

      for (const p of vaultPosPdas) {
        const pos = await t.program.account.position.fetch(p.pda);
        const payout = (pos.payoutLamports as anchor.BN).toNumber() / LAMPORTS_PER_SOL;
        totalPayouts += payout;
        vaultPayouts += payout;
        cohortVaultPayouts += payout;
        const won = payout > 0;
        const mult = won ? payout / p.premium : 0;

        recordStrikeStats(p.strike, p.premium, payout, won, mult, "vault");

        if (won) {
          totalWinners++;
          vaultWinners++;
          winnerPremiums += p.premium;
          winnerPayouts += payout;
          recordProfit(p, payout, mhiBps, c, "vault");
          recordTopMult(mult, p, payout, mhiBps, c, "vault");
        }

        // Payout was delivered atomically at settle (no claim step). Reclaim
        // the settled position PDA's rent so the 10K-cohort run stays bounded.
        await t.program.methods
          .closePosition()
          .accounts({
            caller: t.keeper.publicKey,
            position: p.pda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([t.keeper])
          .rpc();
      }

      for (const p of p2pPosPdas) {
        const pos = await (t.program.account as any).p2PPosition.fetch(p.pda);
        const payout = (pos.payoutLamports as anchor.BN).toNumber() / LAMPORTS_PER_SOL;
        totalPayouts += payout;
        p2pPayouts += payout;
        cohortP2pPayouts += payout;
        protocolP2pFees += p.premium - p.writerPremium;
        writerPremiums += p.writerPremium;
        cohortP2pWriterPremiums += p.writerPremium;
        const won = payout > 0;
        const mult = won ? payout / p.premium : 0;

        recordStrikeStats(p.strike, p.premium, payout, won, mult, "p2p");

        if (won) {
          totalWinners++;
          p2pWinners++;
          winnerPremiums += p.premium;
          winnerPayouts += payout;
          recordProfit(p, payout, mhiBps, c, "p2p");
          recordTopMult(mult, p, payout, mhiBps, c, "p2p");
        }

        // P2P payout delivered atomically at settle_batch_p2p. Reclaim rent.
        await (t.program.methods as any).closeP2PPosition()
          .accounts({
            caller: t.keeper.publicKey,
            position: p.pda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([t.keeper])
          .rpc();
      }

      const cohortFailed = numBuyers - vaultPosPdas.length - p2pPosPdas.length;
      {
        const cohortData = await t.program.account.cohort.fetch(cohortPda);
        const collateralSol = (cohortData.vaultCollateralLocked as anchor.BN).toNumber() / LAMPORTS_PER_SOL;
        const cohortPnl = cohortVaultPremiums - (cohortData.vaultPayoutsDue as anchor.BN).toNumber() / LAMPORTS_PER_SOL;
        recentCohorts.push({ units: vaultPosPdas.length, failed: cohortFailed, collateral: collateralSol, pnl: cohortPnl });
        if (recentCohorts.length > 20) recentCohorts.shift();
      }

      totalVaultFees += cohortVaultPremiums * PREMIUM_FEE_BPS / 10_000;

      await t.program.methods
        .closeCohort()
        .accounts({
          caller: t.keeper.publicKey,
          globalState: t.globalState,
          authority: t.authority.publicKey,
          cohort: cohortPda,
        } as any)
        .signers([t.keeper])
        .rpc();

      totalPremiums += cohortVaultPremiums + cohortP2pPremiums;
      vaultPremiums += cohortVaultPremiums;
      p2pPremiums += cohortP2pPremiums;

      {
        const vault = await t.program.account.vault.fetch(t.vault);
        const availSol = (vault.availableLamports as anchor.BN).toNumber() / LAMPORTS_PER_SOL;
        if (availSol > vaultPeak) vaultPeak = availSol;
        const dd = vaultPeak - availSol;
        const ddPct = vaultPeak > 0 ? (dd / vaultPeak) * 100 : 0;
        if (dd > maxDrawdown) {
          maxDrawdown = dd;
          maxDrawdownPct = ddPct;
          drawdownCohort = c;
        }

        // Failure-rate feedback loop (vault-only, since P2P absorbs overflow)
        if (recentCohorts.length >= 5) {
          const recent = recentCohorts.slice(-5);
          let totalAttempted = 0;
          let totalRejected = 0;
          for (const rc of recent) {
            totalAttempted += rc.units + rc.failed;
            totalRejected += rc.failed;
          }
          const failureRate = totalAttempted > 0 ? totalRejected / totalAttempted : 0;

          if (failureRate > TARGET_FAILURE_RATE) {
            const neededCapacity = availSol / (1 - failureRate);
            if (neededCapacity > vaultTarget) vaultTarget = Math.ceil(neededCapacity);
          } else if (totalRejected === 0) {
            vaultTarget = Math.max(ABSOLUTE_MIN_VAULT, Math.floor(vaultTarget * SHRINK_FACTOR));
          }

          const excess = availSol - vaultTarget;
          if (excess > 1) {
            const withdrawAmount = new anchor.BN(Math.floor(excess * LAMPORTS_PER_SOL));
            try {
              await t.program.methods
                .withdrawVault(withdrawAmount)
                .accounts({
                  authority: t.authority.publicKey,
                  globalState: t.globalState,
                  vault: t.vault,
                  systemProgram: SystemProgram.programId,
                } as any)
                .rpc();
              totalExtracted += excess;
            } catch {
              // Non-fatal
            }
          }
        }
      }

      {
        const pool = await (t.program.account as any).p2PPool.fetch(poolPda);
        const poolVal = ((pool.availableLamports as anchor.BN).toNumber()
          + (pool.activeCollateralLamports as anchor.BN).toNumber()
          + (pool.unclaimedPayoutsLamports as anchor.BN).toNumber()) / LAMPORTS_PER_SOL;
        if (poolVal > poolPeak) poolPeak = poolVal;
        const dd = poolPeak - poolVal;
        const ddPct = poolPeak > 0 ? (dd / poolPeak) * 100 : 0;
        if (dd > poolMaxDrawdown) {
          poolMaxDrawdown = dd;
          poolMaxDrawdownPct = ddPct;
          poolDrawdownCohort = c;
        }

        // Yield snapshot: record TVL + net earnings for rolling APR calculation
        // Net earnings = premiums earned - payouts owed (what the capital source actually kept)
        const vault = await t.program.account.vault.fetch(t.vault);
        const vaultTvl = ((vault.availableLamports as anchor.BN).toNumber()
          + (vault.activeCollateralLamports as anchor.BN).toNumber()) / LAMPORTS_PER_SOL;

        const cohortVaultNetEarnings = cohortVaultPremiums - cohortVaultPayouts;
        const cohortPoolNetEarnings = cohortP2pWriterPremiums - cohortP2pPayouts;

        yieldHistory.push({
          poolTvl: poolVal,
          poolEarnings: cohortPoolNetEarnings,
          vaultTvl: vaultTvl,
          vaultEarnings: cohortVaultNetEarnings,
        });
      }

      if ((c + 1) % LOG_EVERY === 0 || c === NUM_COHORTS - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const vault = await t.program.account.vault.fetch(t.vault);
        const availSol = (vault.availableLamports as anchor.BN).toNumber() / LAMPORTS_PER_SOL;
        const pool = await (t.program.account as any).p2PPool.fetch(poolPda);
        const poolAvail = (pool.availableLamports as anchor.BN).toNumber() / LAMPORTS_PER_SOL;
        const winRate = totalPositions > 0
          ? (totalWinners / totalPositions * 100).toFixed(1)
          : "0.0";
        const currentBuyers = buyerCount(c);
        const totalFails = vaultFailed + p2pFailed;
        const totalAttempts = totalPositions + totalFails;
        const failRate = totalAttempts > 0
          ? (totalFails / totalAttempts * 100).toFixed(1)
          : "0.0";
        const p2pPct = totalPositions > 0
          ? (p2pPositions / totalPositions * 100).toFixed(1) : "0.0";

        // Compute rolling APR (industry-standard: earnings / avg TVL, annualized)
        const rolling1d = computeRollingApr(yieldHistory, COHORTS_PER_DAY, COHORTS_PER_DAY);
        const rolling7d = computeRollingApr(yieldHistory, COHORTS_PER_DAY * 7, COHORTS_PER_DAY);

        // Record yield curve point (rolling APR only - cumulative APY is misleading
        // when growth is driven by increasing overflow volume, not compound interest)
        const rolling30d = computeRollingApr(yieldHistory, COHORTS_PER_DAY * 30, COHORTS_PER_DAY);
        yieldCurve.push({
          cohort: c + 1,
          poolRolling1dApr: rolling1d.poolApr,
          poolRolling7dApr: rolling7d.poolApr,
          poolRolling30dApr: rolling30d.poolApr,
          vaultRolling1dApr: rolling1d.vaultApr,
          vaultRolling7dApr: rolling7d.vaultApr,
          vaultRolling30dApr: rolling30d.vaultApr,
        });

        const avgMhi = (mhiSum / (c + 1) / 100).toFixed(1);
        console.log(
          `  [${c + 1}/${NUM_COHORTS}] ${elapsed}s | ` +
          `vault=${availSol.toFixed(1)} pool=${poolAvail.toFixed(1)} target=${vaultTarget.toFixed(0)} | ` +
          `buyers=${currentBuyers} | ` +
          `pos=${totalPositions} (v=${vaultPositions} p2p=${p2pPositions}/${p2pPct}%) fail=${failRate}% | ` +
          `win=${winRate}% MHI=${avgMhi}% | ` +
          `pool APR(1d)=${rolling1d.poolApr.toFixed(0)}% vault APR(1d)=${rolling1d.vaultApr.toFixed(0)}%`,
        );
      }
    }

    function recordStrikeStats(strike: number, premium: number, payout: number, won: boolean, mult: number, source: "vault" | "p2p") {
      const ss = strikeStats.get(strike) ?? { count: 0, wins: 0, premiums: 0, payouts: 0, maxMult: 0, vaultCount: 0, p2pCount: 0 };
      ss.count++; ss.premiums += premium; ss.payouts += payout;
      if (source === "vault") ss.vaultCount++; else ss.p2pCount++;
      if (won) { ss.wins++; if (mult > ss.maxMult) ss.maxMult = mult; }
      strikeStats.set(strike, ss);
    }
    function recordProfit(p: { premium: number; strike: number }, payout: number, mhi: number, cohort: number, source: "vault" | "p2p") {
      const profit = payout - p.premium;
      if (profit > maxProfit) {
        maxProfit = profit;
        maxProfitDetails = { premium: p.premium, payout, strike: p.strike, mhi, cohort, source };
      }
    }
    function recordTopMult(mult: number, p: { premium: number; strike: number }, payout: number, mhi: number, cohort: number, source: "vault" | "p2p") {
      if (topMultipliers.length < TOP_N || mult > topMultipliers[topMultipliers.length - 1]!.mult) {
        topMultipliers.push({
          mult, payout, premium: p.premium,
          strike: p.strike, mhi, cohort, source,
        });
        topMultipliers.sort((a, b) => b.mult - a.mult);
        if (topMultipliers.length > TOP_N) topMultipliers.length = TOP_N;
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rtp = totalPremiums > 0 ? (totalPayouts / totalPremiums * 100).toFixed(1) : "0.0";
    const vaultRtp = vaultPremiums > 0 ? (vaultPayouts / vaultPremiums * 100).toFixed(1) : "0.0";
    const p2pRtp = p2pPremiums > 0 ? (p2pPayouts / p2pPremiums * 100).toFixed(1) : "0.0";
    const avgPosSize = totalPositions > 0 ? (totalPremiums / totalPositions).toFixed(4) : "0";
    const totalLosers = totalPositions - totalWinners;
    const loserPremiums = totalPremiums - winnerPremiums;
    const avgLoserBet = totalLosers > 0 ? (loserPremiums / totalLosers).toFixed(6) : "0";
    const cohortsPerMin = (NUM_COHORTS / (parseFloat(elapsed) / 60)).toFixed(0);
    const totalFails = vaultFailed + p2pFailed;
    const totalAttempts = totalPositions + totalFails;

    // Read final balances
    const finalVault = await t.program.account.vault.fetch(t.vault);
    const finalVaultSol = (finalVault.availableLamports as anchor.BN).toNumber() / LAMPORTS_PER_SOL;
    const finalPool = await (t.program.account as any).p2PPool.fetch(poolPda);
    const finalPoolAvail = (finalPool.availableLamports as anchor.BN).toNumber() / LAMPORTS_PER_SOL;
    const finalPoolTotalVal = ((finalPool.availableLamports as anchor.BN).toNumber()
      + (finalPool.activeCollateralLamports as anchor.BN).toNumber()
      + (finalPool.unclaimedPayoutsLamports as anchor.BN).toNumber()) / LAMPORTS_PER_SOL;
    const finalPoolShares = (finalPool.totalShares as anchor.BN).toNumber() / LAMPORTS_PER_SOL;
    const sharePrice = finalPoolShares > 0 ? finalPoolTotalVal / finalPoolShares : 1.0;

    console.log(`\n  ╔══════════════════════════════════════════════════════════════════════╗`);
    console.log(`  ║  STRESS TEST - ${NUM_COHORTS} cohorts in ${elapsed}s (${cohortsPerMin}/min)  `);
    console.log(`  ║  Vault(${VAULT_SEED_SOL} SOL) + P2P Pool(${POOL_SEED_SOL} SOL, ${NUM_WRITERS} writers)  `);
    console.log(`  ╚══════════════════════════════════════════════════════════════════════╝`);

    console.log(`\n  ── Overview ──────────────────────────────────────────────────`);
    console.log(`  Positions placed:   ${totalPositions} (vault: ${vaultPositions}, P2P: ${p2pPositions})`);
    console.log(`  Positions failed:   ${totalFails} of ${totalAttempts} attempted (${(totalFails / totalAttempts * 100).toFixed(1)}%)`);
    console.log(`    Vault rejected:   ${vaultFailed} → ${p2pPositions} absorbed by P2P, ${p2pFailed} failed both`);
    console.log(`  P2P share:          ${(p2pPositions / totalPositions * 100).toFixed(1)}% of all positions`);
    console.log(`  Cohorts w/ overflow:${cohortsWithOverflow} of ${NUM_COHORTS} (${(cohortsWithOverflow / NUM_COHORTS * 100).toFixed(1)}%)`);
    console.log(`  Avg position size:  ${avgPosSize} SOL (premium)`);
    console.log(`  Buyer growth:       ${BASE_BUYERS} → ${buyerCount(NUM_COHORTS - 1)}/cohort`);

    console.log(`\n  ── Vault Economics ───────────────────────────────────────────`);
    console.log(`  Seed:               ${VAULT_SEED_SOL} SOL`);
    console.log(`  Final balance:      ${finalVaultSol.toFixed(2)} SOL`);
    console.log(`  Positions:          ${vaultPositions} placed, ${vaultWinners} winners (${(vaultWinners / (vaultPositions || 1) * 100).toFixed(1)}% win rate)`);
    console.log(`  Premiums:           ${vaultPremiums.toFixed(4)} SOL`);
    console.log(`  Payouts:            ${vaultPayouts.toFixed(4)} SOL`);
    console.log(`  Vault P&L:          ${(vaultPremiums - vaultPayouts) >= 0 ? "+" : ""}${(vaultPremiums - vaultPayouts).toFixed(4)} SOL`);
    console.log(`  RTP (vault):        ${vaultRtp}%`);
    console.log(`  House edge (vault): ${(100 - parseFloat(vaultRtp)).toFixed(1)}%`);

    console.log(`\n  ── Vault Risk ────────────────────────────────────────────────`);
    console.log(`  Max drawdown:       ${maxDrawdown.toFixed(4)} SOL (${maxDrawdownPct.toFixed(1)}% from peak at cohort #${drawdownCohort})`);
    console.log(`  Peak vault balance: ${vaultPeak.toFixed(2)} SOL`);
    console.log(`  Total extracted:    ${totalExtracted.toFixed(2)} SOL`);
    console.log(`  Vault target:       ${isFinite(vaultTarget) ? vaultTarget.toFixed(0) : "∞"} SOL`);

    console.log(`\n  ── P2P Pool Economics ────────────────────────────────────────`);
    console.log(`  Seed:               ${POOL_SEED_SOL} SOL (${NUM_WRITERS} writers × ${Math.floor(POOL_SEED_SOL / NUM_WRITERS)} SOL)`);
    console.log(`  Pool total value:   ${finalPoolTotalVal.toFixed(2)} SOL`);
    console.log(`  Pool available:     ${finalPoolAvail.toFixed(2)} SOL`);
    console.log(`  Share price:        ${sharePrice.toFixed(4)} (${sharePrice >= 1 ? "+" : ""}${((sharePrice - 1) * 100).toFixed(2)}%)`);
    console.log(`  Positions:          ${p2pPositions} placed, ${p2pWinners} winners (${(p2pWinners / (p2pPositions || 1) * 100).toFixed(1)}% win rate)`);
    console.log(`  Buyer premiums:     ${p2pPremiums.toFixed(4)} SOL`);
    console.log(`  Writer premiums:    ${writerPremiums.toFixed(4)} SOL (after ${(protocolP2pFees / (p2pPremiums || 1) * 100).toFixed(0)}% protocol fee)`);
    console.log(`  Payouts:            ${p2pPayouts.toFixed(4)} SOL`);
    console.log(`  Writer P&L:         ${(writerPremiums - p2pPayouts) >= 0 ? "+" : ""}${(writerPremiums - p2pPayouts).toFixed(4)} SOL`);
    console.log(`  Writer ROI (total): ${((finalPoolTotalVal - POOL_SEED_SOL) / POOL_SEED_SOL * 100).toFixed(1)}%`);
    console.log(`  P2P RTP:            ${p2pRtp}%`);

    console.log(`\n  ── P2P Pool Risk ─────────────────────────────────────────────`);
    console.log(`  Max drawdown:       ${poolMaxDrawdown.toFixed(4)} SOL (${poolMaxDrawdownPct.toFixed(1)}% from peak at cohort #${poolDrawdownCohort})`);
    console.log(`  Peak pool value:    ${poolPeak.toFixed(2)} SOL`);

    console.log(`\n  ── Yield Curve (APR = period earnings / avg TVL, annualized) ─`);
    console.log(`  ${"Cohort".padEnd(8)}  ${"Day".padStart(5)}  ${"Pool 1d".padStart(9)}  ${"Pool 7d".padStart(9)}  ${"Pool 30d".padStart(9)}  ${"Vault 1d".padStart(9)}  ${"Vault 7d".padStart(9)}  ${"Vault 30d".padStart(9)}`);
    console.log(`  ${"─".repeat(75)}`);
    for (const y of yieldCurve) {
      const day = (y.cohort / COHORTS_PER_DAY).toFixed(1);
      console.log(
        `  ${String(y.cohort).padEnd(8)}  ${day.padStart(5)}  ` +
        `${(y.poolRolling1dApr.toFixed(0) + "%").padStart(9)}  ` +
        `${(y.poolRolling7dApr.toFixed(0) + "%").padStart(9)}  ` +
        `${(y.poolRolling30dApr.toFixed(0) + "%").padStart(9)}  ` +
        `${(y.vaultRolling1dApr.toFixed(0) + "%").padStart(9)}  ` +
        `${(y.vaultRolling7dApr.toFixed(0) + "%").padStart(9)}  ` +
        `${(y.vaultRolling30dApr.toFixed(0) + "%").padStart(9)}`,
      );
    }
    // Final rolling APR (what a prospective depositor would see today)
    const final1d = computeRollingApr(yieldHistory, COHORTS_PER_DAY, COHORTS_PER_DAY);
    const final7d = computeRollingApr(yieldHistory, COHORTS_PER_DAY * 7, COHORTS_PER_DAY);
    const final30d = computeRollingApr(yieldHistory, COHORTS_PER_DAY * 30, COHORTS_PER_DAY);

    console.log(`\n  ── Final Yield Summary ───────────────────────────────────────`);
    console.log(`  Simulation length:  ${(NUM_COHORTS / COHORTS_PER_DAY).toFixed(1)} days (${NUM_COHORTS} cohorts)`);
    console.log(`                      ${"P2P Pool".padStart(12)}  ${"Vault".padStart(12)}`);
    console.log(`  Rolling APR (1d):   ${(final1d.poolApr.toFixed(0) + "%").padStart(12)}  ${(final1d.vaultApr.toFixed(0) + "%").padStart(12)}`);
    console.log(`  Rolling APR (7d):   ${(final7d.poolApr.toFixed(0) + "%").padStart(12)}  ${(final7d.vaultApr.toFixed(0) + "%").padStart(12)}`);
    console.log(`  Rolling APR (30d):  ${(final30d.poolApr.toFixed(0) + "%").padStart(12)}  ${(final30d.vaultApr.toFixed(0) + "%").padStart(12)}`);
    console.log(`  (APR = earnings / avg TVL over window, annualized - what a new depositor earns at current rate)`);

    console.log(`\n  ── Protocol Revenue ──────────────────────────────────────────`);
    console.log(`  Vault volume fees:  ${totalVaultFees.toFixed(4)} SOL (1.5% of vault premiums)`);
    console.log(`  P2P protocol fees:  ${protocolP2pFees.toFixed(4)} SOL (10% of P2P premiums)`);
    console.log(`  Vault extraction:   ${totalExtracted.toFixed(4)} SOL`);
    console.log(`  Total revenue:      ${(totalVaultFees + protocolP2pFees + totalExtracted).toFixed(4)} SOL`);
    console.log(`  ROI on seed:        ${((totalVaultFees + protocolP2pFees + totalExtracted) / VAULT_SEED_SOL * 100).toFixed(0)}%`);

    console.log(`\n  ── Combined Economics ────────────────────────────────────────`);
    console.log(`  Total premiums:     ${totalPremiums.toFixed(4)} SOL`);
    console.log(`  Total payouts:      ${totalPayouts.toFixed(4)} SOL`);
    console.log(`  Combined RTP:       ${rtp}%`);
    console.log(`  Combined house edge:${(100 - parseFloat(rtp)).toFixed(1)}%`);

    console.log(`\n  ── Winner Economics (${totalWinners} winners, ${(totalWinners / totalPositions * 100).toFixed(1)}% win rate) ──`);
    if (totalWinners > 0) {
      const avgWinPremium = winnerPremiums / totalWinners;
      const avgWinPayout = winnerPayouts / totalWinners;
      const avgWinProfit = avgWinPayout - avgWinPremium;
      console.log(`  Avg bet (premium):  ${avgWinPremium.toFixed(6)} SOL`);
      console.log(`  Avg payout:         ${avgWinPayout.toFixed(6)} SOL`);
      console.log(`  Avg profit:         ${avgWinProfit >= 0 ? "+" : ""}${avgWinProfit.toFixed(6)} SOL (${(avgWinProfit / avgWinPremium * 100).toFixed(0)}% ROI)`);
      console.log(`  Max profit:         +${maxProfit.toFixed(6)} SOL (${maxProfitDetails.source}, bet ${maxProfitDetails.premium.toFixed(6)} → got ${maxProfitDetails.payout.toFixed(6)}, strike ${maxProfitDetails.strike / 100}%, MHI ${(maxProfitDetails.mhi / 100).toFixed(1)}%)`);
    }

    console.log(`\n  ── Loser Economics (${totalLosers} losers, ${(totalLosers / totalPositions * 100).toFixed(1)}% of positions) ──`);
    console.log(`  Total lost:         ${loserPremiums.toFixed(4)} SOL`);
    console.log(`  Avg loss per bet:   ${avgLoserBet} SOL`);

    console.log(`\n  ── MHI Stats ─────────────────────────────────────────────────`);
    console.log(`  Average:            ${(mhiSum / NUM_COHORTS / 100).toFixed(1)}%`);
    console.log(`  Min:                ${(mhiMin / 100).toFixed(1)}%`);
    console.log(`  Max:                ${(mhiMax / 100).toFixed(1)}%`);

    console.log(`\n  MHI Distribution:`);
    console.log(`  ${"Bucket".padEnd(12)}  ${"Count".padStart(6)}  ${"Pct".padStart(6)}`);
    console.log(`  ${"─".repeat(28)}`);
    const sortedBuckets = [...mhiBuckets.entries()].sort((a, b) => {
      const aVal = parseInt(a[0]); const bVal = parseInt(b[0]);
      return aVal - bVal;
    });
    for (const [bucket, count] of sortedBuckets) {
      const pct = (count / NUM_COHORTS * 100).toFixed(1);
      console.log(`  ${bucket.padEnd(12)}  ${String(count).padStart(6)}  ${(pct + "%").padStart(6)}`);
    }

    console.log(`\n  Per-Strike Breakdown:`);
    console.log(`  ${"Strike".padEnd(8)}  ${"Total".padStart(6)}  ${"Vault".padStart(6)}  ${"P2P".padStart(5)}  ${"Win%".padStart(6)}  ${"Premiums".padStart(10)}  ${"Payouts".padStart(10)}  ${"P&L".padStart(10)}  ${"ROI".padStart(8)}  ${"MaxMx".padStart(6)}`);
    console.log(`  ${"─".repeat(88)}`);
    const sortedStrikes = [...strikeStats.entries()].sort((a, b) => a[0] - b[0]);
    for (const [strike, s] of sortedStrikes) {
      const winPct = (s.wins / s.count * 100).toFixed(1);
      const pnl = s.premiums - s.payouts;
      const buyerRoi = s.premiums > 0 ? ((s.payouts - s.premiums) / s.premiums * 100).toFixed(0) : "0";
      console.log(
        `  ${(strike / 100 + "%").padEnd(8)}  ${String(s.count).padStart(6)}  ${String(s.vaultCount).padStart(6)}  ${String(s.p2pCount).padStart(5)}  ${(winPct + "%").padStart(6)}  ` +
        `${s.premiums.toFixed(4).padStart(10)}  ${s.payouts.toFixed(4).padStart(10)}  ` +
        `${(pnl >= 0 ? "+" : "") + pnl.toFixed(4)}  ` +
        `${(buyerRoi + "%").padStart(8)}  ${s.maxMult > 0 ? s.maxMult.toFixed(1) + "x" : "-"}`,
      );
    }

    if (topMultipliers.length > 0) {
      console.log(`\n  Top ${topMultipliers.length} multipliers (payout / premium):`);
      console.log(`  ${"#".padStart(3)}  ${"Mult".padStart(8)}  ${"Bet".padStart(10)}  ${"Payout".padStart(10)}  ${"Profit".padStart(10)}  Strike  MHI      Src    Cohort`);
      console.log(`  ${"─".repeat(90)}`);
      for (let i = 0; i < topMultipliers.length; i++) {
        const m = topMultipliers[i]!;
        const profit = m.payout - m.premium;
        console.log(
          `  ${(i + 1 + ".").padStart(3)}  ${m.mult.toFixed(1).padStart(8)}x  ` +
          `${m.premium.toFixed(6).padStart(10)}  ${m.payout.toFixed(6).padStart(10)}  ` +
          `${("+" + profit.toFixed(6)).padStart(10)}  ` +
          `${(m.strike / 100 + "%").padEnd(6)}  ` +
          `${(m.mhi / 100).toFixed(1).padStart(6)}%  ${m.source.padEnd(5)}  #${m.cohort}`,
        );
      }
    }

    // Vault conservation must hold after all cohorts
    await assertVaultConservation(t);

    expect(finalVaultSol).to.be.greaterThan(0, "Vault should not be fully drained");
    expect(totalPositions).to.be.greaterThan(0, "Some positions should have succeeded");
    expect(p2pPositions).to.be.greaterThan(0, "Some P2P positions should have been placed");
  });
});
