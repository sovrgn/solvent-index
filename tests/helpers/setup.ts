import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Mhi } from "../../target/types/mhi";
import { findGlobalStatePda, findVaultPda, findEmaStatePda } from "./accounts";
import { NUM_STRIKES, DEFAULT_STRIKES_BPS } from "./constants";

export interface TestContext {
  program: Program<Mhi>;
  provider: anchor.AnchorProvider;
  authority: Keypair;
  keeper: Keypair;
  globalState: PublicKey;
  vault: PublicKey;
  emaState: PublicKey;
}

/**
 * Initialize the protocol with default test config.
 * Returns all the accounts and keypairs needed for testing.
 */
export async function initializeProtocol(
  program: Program<Mhi>,
  provider: anchor.AnchorProvider,
  overrides?: {
    tradingWindowSeconds?: number;
    measurementSeconds?: number;
    observationSeconds?: number;
    settlementDeadlineSeconds?: number;
    claimExpirySeconds?: number;
    initialEmaValues?: number[];
  }
): Promise<TestContext> {
  const authority = (provider.wallet as anchor.Wallet).payer;
  const keeper = Keypair.generate();

  // Airdrop SOL to keeper for rent
  const sig = await provider.connection.requestAirdrop(
    keeper.publicKey,
    10 * LAMPORTS_PER_SOL
  );
  await provider.connection.confirmTransaction(sig);

  const [globalState] = findGlobalStatePda(program.programId);
  const [vault] = findVaultPda(program.programId);
  const [emaState] = findEmaStatePda(program.programId);

  // Default EMA values (from empirical data - non-zero to pass premium floor check)
  const defaultEma = overrides?.initialEmaValues ?? [3260, 2330, 1560, 1000, 450, 80, 30];

  // Pad or trim to NUM_STRIKES
  const initialEmaValues = Array.from({ length: NUM_STRIKES }, (_, i) => defaultEma[i] ?? 0);

  await program.methods
    .initialize({
      keeper: keeper.publicKey,
      mhiCapBps: 30000,
      premiumFeeBps: 150,
      referralShareBps: 3000,
      minPositionLamports: new anchor.BN(10_000_000), // 0.01 SOL
      tradingWindowSeconds: overrides?.tradingWindowSeconds ?? 180,
      measurementSeconds: overrides?.measurementSeconds ?? 900,
      observationSeconds: overrides?.observationSeconds ?? 300,
      settlementDeadlineSeconds: overrides?.settlementDeadlineSeconds ?? 1800,
      claimExpirySeconds: overrides?.claimExpirySeconds ?? 86400,
      initialEmaValues: initialEmaValues,
    })
    .accounts({
      authority: authority.publicKey,
      globalState,
      vault,
      emaState,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return { program, provider, authority, keeper, globalState, vault, emaState };
}

/**
 * Seed the vault with SOL.
 */
export async function seedVault(
  ctx: TestContext,
  amountSol: number
): Promise<void> {
  await ctx.program.methods
    .seedVault(new anchor.BN(amountSol * LAMPORTS_PER_SOL))
    .accounts({
      authority: ctx.authority.publicKey,
      globalState: ctx.globalState,
      vault: ctx.vault,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/**
 * Create a funded keypair for testing.
 */
export async function createFundedKeypair(
  provider: anchor.AnchorProvider,
  solAmount: number = 10
): Promise<Keypair> {
  const kp = Keypair.generate();
  const sig = await provider.connection.requestAirdrop(
    kp.publicKey,
    solAmount * LAMPORTS_PER_SOL
  );
  await provider.connection.confirmTransaction(sig);
  return kp;
}
