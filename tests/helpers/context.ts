import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AccountInfo, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { ProgramTestContext, Clock, BanksClient } from "solana-bankrun";
import { Mhi } from "../../target/types/mhi";

// Lazy singleton - shared across all test files in a single mocha run.
let _context: ProgramTestContext | null = null;
let _provider: BankrunProvider | null = null;
let _program: Program<Mhi> | null = null;

/**
 * Initialise (or return existing) bankrun context with the Anchor workspace deployed.
 */
export async function getBankrunContext(): Promise<{
  context: ProgramTestContext;
  provider: BankrunProvider;
  program: Program<Mhi>;
}> {
  if (!_context) {
    _context = await startAnchor(".", [], []);
    _provider = new BankrunProvider(_context);
    anchor.setProvider(_provider);

    // Load program via workspace (provider is already set globally)
    _program = anchor.workspace.Mhi as Program<Mhi>;
  }
  return { context: _context!, provider: _provider!, program: _program! };
}

/**
 * Advance the on-chain clock by `seconds` without real-time waiting.
 * Warps the bank's slot (fresh blockhash) and sets the clock sysvar.
 */
export async function warpTime(
  context: ProgramTestContext,
  seconds: number
): Promise<void> {
  const clock = await context.banksClient.getClock();
  const newSlot = clock.slot + BigInt(seconds * 2); // ~2 slots/sec
  const newUnixTimestamp = clock.unixTimestamp + BigInt(seconds);

  // Advance the actual bank slot - gives a fresh blockhash and prevents
  // "transaction already processed" errors on retried instructions.
  context.warpToSlot(newSlot);

  // Set the clock sysvar so on-chain Clock::get() reads the new timestamp
  const newClock = new Clock(
    newSlot,
    clock.epochStartTimestamp,
    clock.epoch,
    clock.leaderScheduleEpoch,
    newUnixTimestamp
  );
  context.setClock(newClock);
}

/**
 * Fund a keypair via a real transfer from the context payer.
 * (Using transfers instead of setAccount keeps the bank hash consistent,
 * which allows warpToSlot to work without panicking.)
 */
export async function fundAccount(
  context: ProgramTestContext,
  address: PublicKey,
  lamports: number = 10 * LAMPORTS_PER_SOL
): Promise<void> {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: context.payer.publicKey,
      toPubkey: address,
      lamports,
    })
  );
  tx.feePayer = context.payer.publicKey;
  tx.recentBlockhash = (await context.banksClient.getLatestBlockhash())![0];
  tx.sign(context.payer);
  await context.banksClient.processTransaction(tx);
}

/**
 * Create a new keypair and fund it.
 */
export async function createFundedKeypair(
  context: ProgramTestContext,
  solAmount: number = 10
): Promise<Keypair> {
  const kp = Keypair.generate();
  await fundAccount(context, kp.publicKey, solAmount * LAMPORTS_PER_SOL);
  return kp;
}

/**
 * Get account info, returning null for missing accounts.
 * (BankrunConnectionProxy throws instead of returning null.)
 */
export async function getAccountOrNull(
  banksClient: BanksClient,
  address: PublicKey
): Promise<AccountInfo<Buffer> | null> {
  const raw = await banksClient.getAccount(address);
  if (!raw) return null;
  return {
    ...raw,
    data: Buffer.from(raw.data),
    owner: new PublicKey(raw.owner),
  } as AccountInfo<Buffer>;
}

/**
 * Get balance in lamports.
 * (BankrunConnectionProxy doesn't implement getBalance.)
 */
export async function getBalance(
  banksClient: BanksClient,
  address: PublicKey
): Promise<number> {
  return Number(await banksClient.getBalance(address));
}
