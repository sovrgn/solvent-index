import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

const GLOBAL_STATE_SEED = Buffer.from("global_state");
const VAULT_SEED = Buffer.from("vault");
const EMA_STATE_SEED = Buffer.from("ema_state");
const COHORT_SEED = Buffer.from("cohort");
const POSITION_SEED = Buffer.from("position");
const P2P_POSITION_SEED = Buffer.from("p2p_position");
const P2P_POOL_SEED = Buffer.from("p2p_pool");

export function findGlobalStatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([GLOBAL_STATE_SEED], programId);
}

export function findVaultPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED], programId);
}

export function findEmaStatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([EMA_STATE_SEED], programId);
}

export function findCohortPda(
  programId: PublicKey,
  cohortIndex: number | anchor.BN
): [PublicKey, number] {
  const indexBn = typeof cohortIndex === "number"
    ? new anchor.BN(cohortIndex)
    : cohortIndex;
  return PublicKey.findProgramAddressSync(
    [COHORT_SEED, indexBn.toArrayLike(Buffer, "le", 8)],
    programId
  );
}

export function findPositionPda(
  programId: PublicKey,
  cohortKey: PublicKey,
  ownerKey: PublicKey,
  strikeBps: number,
  nonce: number
): [PublicKey, number] {
  const strikeBuffer = Buffer.alloc(4);
  strikeBuffer.writeUInt32LE(strikeBps);
  return PublicKey.findProgramAddressSync(
    [
      POSITION_SEED,
      cohortKey.toBuffer(),
      ownerKey.toBuffer(),
      strikeBuffer,
      Buffer.from([nonce]),
    ],
    programId
  );
}

export function findP2pPoolPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([P2P_POOL_SEED], programId);
}

export function findP2pPositionPda(
  programId: PublicKey,
  cohortKey: PublicKey,
  buyerKey: PublicKey,
  strikeBps: number,
  nonce: number,
): [PublicKey, number] {
  const strikeBuffer = Buffer.alloc(4);
  strikeBuffer.writeUInt32LE(strikeBps);
  return PublicKey.findProgramAddressSync(
    [
      P2P_POSITION_SEED,
      cohortKey.toBuffer(),
      buyerKey.toBuffer(),
      strikeBuffer,
      Buffer.from([nonce]),
    ],
    programId
  );
}
