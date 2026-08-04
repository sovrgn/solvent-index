import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

export const NUM_STRIKES = 7;
export const MHI_CAP_BPS = 30_000;
export const BPS_DENOMINATOR = 10_000;

// Must mirror mhi-program/src/constants.rs.
export const STRIKE_MULTIPLIERS_BPS = [9_000, 9_500, 10_000, 10_500, 11_000, 12_000, 13_000];
export const STRIKE_ANCHOR_MIN_BPS = 2_000;
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

// Default timing for fast tests (in seconds)
export const FAST_TRADING_WINDOW = 3;
export const FAST_MEASUREMENT = 5;
export const FAST_OBSERVATION = 2;
export const FAST_SETTLEMENT_DEADLINE = 5;
export const FAST_CLAIM_EXPIRY = 5;

// Lamport helpers
export const SOL = (n: number) => new anchor.BN(n * LAMPORTS_PER_SOL);
export const LAMPORTS = (n: number) => new anchor.BN(n);
