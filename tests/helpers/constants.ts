import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

export const NUM_STRIKES = 7;
export const MHI_CAP_BPS = 30_000;
export const BPS_DENOMINATOR = 10_000;

// Must mirror mhi-program/src/constants.rs.
export const STRIKE_MULTIPLIERS_BPS = [9_000, 9_500, 10_000, 10_500, 11_000, 12_000, 13_000];
export const STRIKE_ANCHOR_MIN_BPS = 2_000;
export const STRIKE_ANCHOR_DEFAULT_BPS = 12_500;

/** Off-chain mirror of `crate::math::ema::derive_strikes`. */
export function deriveStrikes(anchorBps: number): number[] {
  return STRIKE_MULTIPLIERS_BPS.map(mult =>
    Math.max(STRIKE_ANCHOR_MIN_BPS, Math.floor((anchorBps * mult) / BPS_DENOMINATOR)),
  );
}

/** Strikes the chain produces from the cold-start anchor. */
export const DEFAULT_STRIKES_BPS = deriveStrikes(STRIKE_ANCHOR_DEFAULT_BPS);

// Default timing for fast tests (in seconds)
export const FAST_TRADING_WINDOW = 3;
export const FAST_MEASUREMENT = 5;
export const FAST_OBSERVATION = 2;
export const FAST_SETTLEMENT_DEADLINE = 5;
export const FAST_CLAIM_EXPIRY = 5;

// Lamport helpers
export const SOL = (n: number) => new anchor.BN(n * LAMPORTS_PER_SOL);
export const LAMPORTS = (n: number) => new anchor.BN(n);
