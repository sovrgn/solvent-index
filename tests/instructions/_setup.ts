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
} from "../helpers/accounts";

export {
  findGlobalStatePda,
  findVaultPda,
  findEmaStatePda,
  findCohortPda,
  findPositionPda,
  findP2pPositionPda,
};

export const FAST_TRADING_WINDOW = 3;
export const FAST_MEASUREMENT = 5;
export const FAST_OBSERVATION = 2;
export const FAST_SETTLEMENT_DEADLINE = 5;
export const FAST_CLAIM_EXPIRY = 5;

export const NUM_STRIKES = 7;
export const DEFAULT_STRIKES_BPS = [10_000, 11_000, 12_000, 13_000, 15_000, 18_000, 20_000];
export const MHI_CAP_BPS = 30_000;

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
        initialEmaValues: [3260, 2330, 1560, 1000, 450, 80, 30],
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


/** Start a cohort. Returns the cohort PDA. */
export async function startCohort(t: TestCtx): Promise<PublicKey> {
  const gs = await t.program.account.globalState.fetch(t.globalState);
  const idx = gs.currentCohortIndex.toNumber();
  const [cohortPda] = findCohortPda(t.program.programId, idx);
  await t.program.methods
    .startCohort()
    .accounts({
      keeper: t.keeper.publicKey,
      globalState: t.globalState,
      vault: t.vault,
      emaState: t.emaState,
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
  const strike = opts.strikeBps ?? 12_000;
  const size = opts.size ?? SOL(0.05);
  const nonce = opts.nonce ?? 0;
  const [posPda] = findPositionPda(t.program.programId, cohort, who.publicKey, strike, nonce);
  const builder = t.program.methods
    .buyCall(strike, size, nonce)
    .accounts({
      buyer: who.publicKey,
      globalState: t.globalState,
      vault: t.vault,
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

/** Settle a batch of positions. */
export async function settleBatch(
  t: TestCtx,
  cohort: PublicKey,
  positions: PublicKey[],
  caller?: Keypair,
): Promise<void> {
  const who = caller ?? t.keeper;
  await t.program.methods
    .settleBatch()
    .accounts({
      caller: who.publicKey,
      globalState: t.globalState,
      vault: t.vault,
      cohort,
    } as any)
    .remainingAccounts(positions.map((pk) => ({ pubkey: pk, isWritable: true, isSigner: false })))
    .signers([who])
    .rpc();
}

/** Claim a position. */
export async function claimPosition(
  t: TestCtx,
  cohort: PublicKey,
  position: PublicKey,
  owner: Keypair,
  caller?: Keypair,
): Promise<void> {
  const who = caller ?? owner;
  await t.program.methods
    .claim()
    .accounts({
      caller: who.publicKey,
      owner: owner.publicKey,
      vault: t.vault,
      cohort,
      position,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([who])
    .rpc();
}

/** Run a full cohort: start → buy → warp → submit → settle → claim. Returns cohortPda. */
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
  await settleBatch(t, cohort, posPdas);
  if (opts?.skipClaim) return { cohort, positions: posPdas };
  for (let i = 0; i < positions.length; i++) {
    await claimPosition(t, cohort, posPdas[i], positions[i].buyer ?? t.buyer);
  }
  return { cohort, positions: posPdas };
}

/** Void a cohort (warp past recovery deadline first). */
export async function voidCohort(
  t: TestCtx,
  cohort: PublicKey,
  positions: PublicKey[] = [],
): Promise<void> {
  const recoveryWait =
    FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION +
    FAST_SETTLEMENT_DEADLINE + FAST_SETTLEMENT_DEADLINE + 3;
  await warpTime(t.context, recoveryWait);
  await t.program.methods
    .voidCohort()
    .accounts({
      authority: t.authority.publicKey,
      globalState: t.globalState,
      vault: t.vault,
      cohort,
    } as any)
    .remainingAccounts(positions.map((pk) => ({ pubkey: pk, isWritable: true, isSigner: false })))
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
