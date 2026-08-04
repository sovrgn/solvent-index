/**
 * Shared test harness for per-instruction tests.
 *
 * Each describe() block in the instruction tests calls `setupProtocol()` once
 * in its `before()` hook. That gives it an isolated bankrun context with the
 * protocol initialized, vault seeded, and funded keypairs ready to go.
 *
 * Helper functions drive the protocol through lifecycle phases so individual
 * tests can start from any state (Trading, Measuring, Settling, Settled, Voided).
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { ProgramTestContext, Clock, BanksClient } from "solana-bankrun";
import { Mhi } from "../../target/types/mhi";

// Load IDL from JSON for explicit Program construction (avoids anchor.workspace cache issues)
const IDL = require("../../target/idl/mhi.json");
import {
  findGlobalStatePda,
  findVaultPda,
  findEmaStatePda,
  findCohortPda,
  findPositionPda,
  findP2pPositionPda,
  findP2pPoolPda,
} from "../helpers/accounts";

export {
  findGlobalStatePda,
  findVaultPda,
  findEmaStatePda,
  findCohortPda,
  findPositionPda,
  findP2pPositionPda,
  findP2pPoolPda,
};

export const FAST_TRADING_WINDOW = 3;
export const FAST_MEASUREMENT = 5;
export const FAST_OBSERVATION = 2;
export const FAST_SETTLEMENT_DEADLINE = 5;
export const FAST_CLAIM_EXPIRY = 5;

export const NUM_STRIKES = 7;
export const MHI_CAP_BPS = 30_000;
export const BPS_DENOMINATOR = 10_000;

/** Must mirror mhi-program/src/constants.rs STRIKE_MULTIPLIERS_BPS exactly. */
export const STRIKE_MULTIPLIERS_BPS = [9_000, 9_500, 10_000, 10_500, 11_000, 12_000, 13_000];
/** Must mirror STRIKE_ANCHOR_MIN_BPS in constants.rs. */
export const STRIKE_ANCHOR_MIN_BPS = 2_000;
/** Must mirror STRIKE_ANCHOR_DEFAULT_BPS in constants.rs. */
export const STRIKE_ANCHOR_DEFAULT_BPS = 12_500;

/** Must mirror MAX_STRIKE_MULTIPLIER_BPS in constants.rs. */
export const MAX_STRIKE_MULTIPLIER_BPS = 13_000;
/** Must mirror MIN_TOP_STRIKE_HEADROOM_BPS in constants.rs. */
export const MIN_TOP_STRIKE_HEADROOM_BPS = 2_000;
/** Must mirror MHI_CAP_BPS_DEFAULT in constants.rs. */
export const MHI_CAP_BPS_DEFAULT_MIRROR = 30_000;

/** Off-chain mirror of `crate::math::ema::max_anchor_for_cap`. */
export function maxAnchorForCap(capBps: number): number {
  const usable = Math.max(0, capBps - MIN_TOP_STRIKE_HEADROOM_BPS);
  return Math.max(
    Math.floor((usable * BPS_DENOMINATOR) / MAX_STRIKE_MULTIPLIER_BPS),
    STRIKE_ANCHOR_MIN_BPS,
  );
}

/** Off-chain mirror of `crate::math::ema::clamp_anchor_for_cap`. */
export function clampAnchorForCap(anchorBps: number, capBps: number): number {
  return Math.min(Math.max(anchorBps, STRIKE_ANCHOR_MIN_BPS), maxAnchorForCap(capBps));
}

/**
 * Off-chain mirror of `crate::math::ema::derive_strikes`, including the
 * cap-driven anchor clamp `start_cohort` applies before deriving.
 */
export function deriveStrikes(
  anchorBps: number,
  capBps: number = MHI_CAP_BPS_DEFAULT_MIRROR,
): number[] {
  const effective = clampAnchorForCap(anchorBps, capBps);
  return STRIKE_MULTIPLIERS_BPS.map(mult =>
    Math.max(STRIKE_ANCHOR_MIN_BPS, Math.floor((effective * mult) / BPS_DENOMINATOR)),
  );
}

/** Strikes the chain produces from the cold-start anchor. */
export const DEFAULT_STRIKES_BPS = deriveStrikes(STRIKE_ANCHOR_DEFAULT_BPS);

export const SOL = (n: number) => new anchor.BN(n * LAMPORTS_PER_SOL);

export interface TestCtx {
  context: ProgramTestContext;
  provider: BankrunProvider;
  program: Program<Mhi>;
  authority: Keypair;
  keeper: Keypair;
  buyer: Keypair;
  buyer2: Keypair;
  randomUser: Keypair;
  globalState: PublicKey;
  vault: PublicKey;
  emaState: PublicKey;
  p2pPool: PublicKey;
}

/**
 * Spin up a fresh bankrun context with the protocol initialized and vault
 * seeded. Returns everything a test file needs.
 */
export async function setupProtocol(opts?: {
  seedSol?: number;
  skipInit?: boolean;
}): Promise<TestCtx> {
  const context = await startAnchor(".", [], []);
  const provider = new BankrunProvider(context);
  anchor.setProvider(provider);
  // Construct Program explicitly per context - anchor.workspace caches a
  // singleton that breaks when multiple contexts exist simultaneously.
  const program = new Program<Mhi>(IDL, provider);

  const authority = (provider.wallet as anchor.Wallet).payer;
  const keeper = await fundedKeypair(context);
  const buyer = await fundedKeypair(context);
  const buyer2 = await fundedKeypair(context);
  const randomUser = await fundedKeypair(context);

  const [globalState] = findGlobalStatePda(program.programId);
  const [vault] = findVaultPda(program.programId);
  const [emaState] = findEmaStatePda(program.programId);
  const [p2pPool] = findP2pPoolPda(program.programId);

  if (!opts?.skipInit) {
    await program.methods
      .initialize({
        keeper: keeper.publicKey,
        mhiCapBps: MHI_CAP_BPS,
        premiumFeeBps: 150,
        referralShareBps: 3000,
        minPositionLamports: new anchor.BN(10_000_000),
        minPremiumLamports: new anchor.BN(0), // disabled for unit tests
        tradingWindowSeconds: FAST_TRADING_WINDOW,
        measurementSeconds: FAST_MEASUREMENT,
        observationSeconds: FAST_OBSERVATION,
        settlementDeadlineSeconds: FAST_SETTLEMENT_DEADLINE,
        claimExpirySeconds: FAST_CLAIM_EXPIRY,
      } as any)
      .accounts({
        authority: authority.publicKey,
        globalState,
        vault,
        emaState,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const seedAmount = opts?.seedSol ?? 20;
    await program.methods
      .seedVault(SOL(seedAmount))
      .accounts({
        authority: authority.publicKey,
        globalState,
        vault,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Always init the P2P pool — buy_call now requires it as an account even
    // when P2P is disabled, so the PDA must exist for any test that buys.
    // The legacy `initP2PPool` (uppercase P) is the name exposed at runtime
    // for this codebase's Anchor version; tests elsewhere use the same.
    await (program.methods as any).initP2PPool()
      .accounts({
        authority: authority.publicKey,
        globalState,
        p2PPool: p2pPool,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  return {
    context,
    provider,
    program,
    authority,
    keeper,
    buyer,
    buyer2,
    randomUser,
    globalState,
    vault,
    emaState,
    p2pPool,
  };
}


export async function warpTime(
  ctx: ProgramTestContext,
  seconds: number,
): Promise<void> {
  const clock = await ctx.banksClient.getClock();
  const newSlot = clock.slot + BigInt(seconds * 2);
  const newTs = clock.unixTimestamp + BigInt(seconds);
  ctx.warpToSlot(newSlot);
  ctx.setClock(
    new Clock(newSlot, clock.epochStartTimestamp, clock.epoch, clock.leaderScheduleEpoch, newTs),
  );
}

/**
 * Warp to an exact offset from a reference timestamp.
 * Useful for boundary tests (deadline - 1, deadline, deadline + 1).
 */
export async function warpToTimestamp(
  ctx: ProgramTestContext,
  targetTs: number,
): Promise<void> {
  const clock = await ctx.banksClient.getClock();
  const delta = targetTs - Number(clock.unixTimestamp);
  if (delta > 0) {
    await warpTime(ctx, delta);
  }
}


export async function fundedKeypair(
  ctx: ProgramTestContext,
  sol: number = 100,
): Promise<Keypair> {
  const kp = Keypair.generate();
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: ctx.payer.publicKey,
      toPubkey: kp.publicKey,
      lamports: sol * LAMPORTS_PER_SOL,
    }),
  );
  tx.feePayer = ctx.payer.publicKey;
  tx.recentBlockhash = (await ctx.banksClient.getLatestBlockhash())![0];
  tx.sign(ctx.payer);
  await ctx.banksClient.processTransaction(tx);
  return kp;
}

export async function getBalance(
  client: BanksClient,
  address: PublicKey,
): Promise<number> {
  return Number(await client.getBalance(address));
}

export async function accountExists(
  client: BanksClient,
  address: PublicKey,
): Promise<boolean> {
  const acct = await client.getAccount(address);
  return acct !== null;
}


/** Read the current chain strike anchor and derive the live strike ladder
 *  for the upcoming cohort. Use this when a test needs to know what strikes
 *  the next start_cohort will accept (the cold-start DEFAULT_STRIKES_BPS
 *  literal goes stale as soon as the anchor moves). */
export async function currentLiveStrikes(t: TestCtx): Promise<number[]> {
  const gs = await t.program.account.globalState.fetch(t.globalState);
  return deriveStrikes((gs as any).strikeAnchorBps as number);
}

/** Convenience: current ATM (slot index 2) strike. */
export async function currentAtmStrike(t: TestCtx): Promise<number> {
  return (await currentLiveStrikes(t))[2]!;
}

/** Start a cohort with strikes derived from the chain's current anchor. */
export async function startCohort(
  t: TestCtx,
  opts: { strikes?: number[] } = {},
): Promise<PublicKey> {
  const gs = await t.program.account.globalState.fetch(t.globalState);
  const idx = gs.currentCohortIndex.toNumber();
  const [cohortPda] = findCohortPda(t.program.programId, idx);
  const anchorBps = (gs as any).strikeAnchorBps as number;
  const strikes = opts.strikes ?? deriveStrikes(anchorBps);
  await t.program.methods
    .startCohort(strikes)
    .accounts({
      keeper: t.keeper.publicKey,
      globalState: t.globalState,
      vault: t.vault,
      cohort: cohortPda,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([t.keeper])
    .rpc();
  return cohortPda;
}

/** Buy a call. Returns the position PDA. */
export async function buyCall(
  t: TestCtx,
  cohort: PublicKey,
  opts: {
    buyer?: Keypair;
    strikeBps?: number;
    size?: anchor.BN;
    nonce?: number;
    referrer?: PublicKey;
  } = {},
): Promise<PublicKey> {
  const who = opts.buyer ?? t.buyer;
  // Strikes drift each cohort as the anchor evolves. Default the buy to the
  // ATM slot of THIS cohort (read on-chain) — the hardcoded cold-start
  // `DEFAULT_STRIKES_BPS` constant goes stale after the first settlement.
  let strike = opts.strikeBps;
  if (strike === undefined) {
    const c = await t.program.account.cohort.fetch(cohort);
    strike = ((c as any).strikes as number[])[2]!;
  }
  const size = opts.size ?? SOL(0.05);
  const nonce = opts.nonce ?? 0;
  const [posPda] = findPositionPda(t.program.programId, cohort, who.publicKey, strike, nonce);
  const builder = t.program.methods
    .buyCall(strike, size, nonce)
    .accounts({
      buyer: who.publicKey,
      globalState: t.globalState,
      vault: t.vault,
      p2pPool: t.p2pPool,
      cohort,
      emaState: t.emaState,
      position: posPda,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([who]);
  if (opts.referrer) {
    builder.remainingAccounts([{ pubkey: opts.referrer, isWritable: true, isSigner: false }]);
  }
  await builder.rpc();
  return posPda;
}

/** Warp past trading + measurement + observation windows. */
export async function warpPastObservation(ctx: ProgramTestContext): Promise<void> {
  await warpTime(ctx, FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION + 2);
}

/** Submit MHI. */
export async function submitMhi(
  t: TestCtx,
  cohort: PublicKey,
  mhiBps: number = 14_000,
): Promise<void> {
  await t.program.methods
    .submitMhi(mhiBps, 20, Array.from({ length: 32 }, () => 0))
    .accounts({
      keeper: t.keeper.publicKey,
      globalState: t.globalState,
      cohort,
      emaState: t.emaState,
      vault: t.vault,
    } as any)
    .signers([t.keeper])
    .rpc();
}

/**
 * Settle a batch of positions.
 *
 * The on-chain handler now expects (position, owner) pairs in
 * remaining_accounts so it can transfer payout + position rent directly to
 * the owner's wallet at settle time — no separate claim is needed.
 *
 * Callers may pass either:
 *   - PublicKey[]: positions only; the helper fetches each position's owner
 *     from chain via `program.account.position.fetch`. Convenient when the
 *     test already has the position PDAs but not the owner pubkeys.
 *   - Array<{ pubkey, owner }>: rich form, no extra fetches. Useful when the
 *     test wants to deliberately pass a wrong owner to exercise the
 *     OwnerMismatch error path.
 *   - Skipped (already-closed) positions: pass `{ pubkey, owner }` with any
 *     valid pubkey for owner; on-chain code skips closed positions before
 *     reading owner, so the mismatch never matters.
 */
export async function settleBatch(
  t: TestCtx,
  cohort: PublicKey,
  positions: Array<PublicKey | { pubkey: PublicKey; owner: PublicKey }>,
  caller?: Keypair,
): Promise<void> {
  const who = caller ?? t.keeper;

  const pairs: Array<{ pubkey: PublicKey; owner: PublicKey }> = [];
  for (const p of positions) {
    if (p instanceof PublicKey) {
      // Derive owner from chain. The position must exist; for already-closed
      // positions the caller must use the rich form.
      const pos = await t.program.account.position.fetch(p);
      pairs.push({ pubkey: p, owner: pos.owner });
    } else {
      pairs.push(p);
    }
  }

  const remaining = pairs.flatMap(({ pubkey, owner }) => [
    { pubkey, isWritable: true, isSigner: false },
    { pubkey: owner, isWritable: true, isSigner: false },
  ]);

  await t.program.methods
    .settleBatch()
    .accounts({
      caller: who.publicKey,
      globalState: t.globalState,
      vault: t.vault,
      cohort,
    } as any)
    .remainingAccounts(remaining)
    .signers([who])
    .rpc();
}

/**
 * Vestigial no-op shim. The `claim` instruction was removed when settle_batch
 * became atomic with payout (the owner receives the SOL at settle time, and
 * the position PDA is closed in the same tx). Tests that called
 * `claimPosition` in their happy path can leave the call in place — it
 * resolves immediately and the post-claim state assertions are unaffected
 * because the work happened at settle. Tests that specifically asserted
 * claim-step behaviour (unclaimedPayouts decrement, PayoutClaimed event) are
 * obsolete and should be removed.
 */
export async function claimPosition(
  _t: TestCtx,
  _cohort: PublicKey,
  _position: PublicKey,
  _owner: Keypair,
  _caller?: Keypair,
): Promise<void> {
  // intentionally no-op
}

/** Vestigial no-op shim — see claimPosition. expire_position was removed
 *  along with claim. */
export async function expirePosition(
  _t: TestCtx,
  _cohort: PublicKey,
  _position: PublicKey,
  _caller?: Keypair,
): Promise<void> {
  // intentionally no-op
}

/**
 * Run a full cohort: start → buy → warp → submit → settle. Returns cohortPda.
 *
 * Settlement is now the terminal step for ITM positions — the on-chain
 * settle_batch transfers payout + position rent directly to the owner's
 * wallet. There is no claim step (claim/expire are vestigial). The
 * `skipClaim` flag is preserved for source compatibility but is a no-op.
 */
export async function runFullCohort(
  t: TestCtx,
  mhiBps: number = 14_000,
  positions: Array<{ buyer?: Keypair; strikeBps?: number; size?: anchor.BN; nonce?: number }> = [{}],
  opts?: { skipClaim?: boolean; skipSettle?: boolean },
): Promise<{ cohort: PublicKey; positions: PublicKey[] }> {
  const cohort = await startCohort(t);
  const posPdas: PublicKey[] = [];
  for (const p of positions) {
    posPdas.push(await buyCall(t, cohort, p));
  }
  await warpPastObservation(t.context);
  await submitMhi(t, cohort, mhiBps);
  if (opts?.skipSettle) return { cohort, positions: posPdas };
  // Pair each position with its buyer so settle can transfer the payout
  // directly. Default buyer comes from t.buyer (matches buyCall's default).
  const pairs = posPdas.map((pubkey, i) => ({
    pubkey,
    owner: (positions[i]?.buyer ?? t.buyer).publicKey,
  }));
  await settleBatch(t, cohort, pairs);
  return { cohort, positions: posPdas };
}

/**
 * Void a cohort (warp past recovery deadline first).
 *
 * Same (position, owner) pair contract as settleBatch — void_cohort now
 * refunds the premium directly to the owner and closes the position PDA
 * inline. Passing PublicKey[] makes the helper auto-derive owners from chain.
 */
export async function voidCohort(
  t: TestCtx,
  cohort: PublicKey,
  positions: Array<PublicKey | { pubkey: PublicKey; owner: PublicKey }> = [],
): Promise<void> {
  const recoveryWait =
    FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION +
    FAST_SETTLEMENT_DEADLINE + FAST_SETTLEMENT_DEADLINE + 3;
  await warpTime(t.context, recoveryWait);

  const pairs: Array<{ pubkey: PublicKey; owner: PublicKey }> = [];
  for (const p of positions) {
    if (p instanceof PublicKey) {
      const pos = await t.program.account.position.fetch(p);
      pairs.push({ pubkey: p, owner: pos.owner });
    } else {
      pairs.push(p);
    }
  }

  const remaining = pairs.flatMap(({ pubkey, owner }) => [
    { pubkey, isWritable: true, isSigner: false },
    { pubkey: owner, isWritable: true, isSigner: false },
  ]);

  await t.program.methods
    .voidCohort()
    .accounts({
      authority: t.authority.publicKey,
      globalState: t.globalState,
      vault: t.vault,
      cohort,
    } as any)
    .remainingAccounts(remaining)
    .rpc();
}

/** Assert vault conservation invariant. */
export async function assertVaultConservation(t: TestCtx): Promise<void> {
  const vault = await t.program.account.vault.fetch(t.vault);
  const vaultAccount = await t.provider.connection.getAccountInfo(t.vault);
  const rent = await t.provider.connection.getMinimumBalanceForRentExemption(
    vaultAccount!.data.length,
  );
  const tracked =
    vault.availableLamports.toNumber() +
    vault.activeCollateralLamports.toNumber() +
    vault.unclaimedPayoutsLamports.toNumber();
  const actual = vaultAccount!.lamports - rent;
  if (tracked !== actual) {
    throw new Error(
      `Vault conservation violated: tracked=${tracked} actual=${actual} ` +
      `(available=${vault.availableLamports} collateral=${vault.activeCollateralLamports} unclaimed=${vault.unclaimedPayoutsLamports})`,
    );
  }
}

/**
 * Helper: expect an async call to throw containing a specific string.
 * Checks both err.toString() and err.logs for bankrun compatibility.
 */
export async function expectError(
  fn: () => Promise<any>,
  errorSubstring: string,
): Promise<void> {
  try {
    await fn();
    throw new Error(`Expected error containing "${errorSubstring}" but call succeeded`);
  } catch (err: any) {
    if (err.message?.startsWith("Expected error containing")) throw err;
    const haystack = err.toString() + JSON.stringify(err.logs ?? []);
    if (!haystack.includes(errorSubstring)) {
      throw new Error(
        `Expected error containing "${errorSubstring}" but got: ${err.toString().slice(0, 200)}`,
      );
    }
  }
}
