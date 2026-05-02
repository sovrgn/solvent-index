import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

export const NUM_STRIKES = 7;

export const DEFAULT_STRIKES_BPS = [10_000, 11_000, 12_000, 13_000, 15_000, 18_000, 20_000];

export const MHI_CAP_BPS = 30_000;
export const BPS_DENOMINATOR = 10_000;

// Default timing for fast tests (in seconds)
export const FAST_TRADING_WINDOW = 3;     // 3 seconds
export const FAST_MEASUREMENT = 5;        // 5 seconds
export const FAST_OBSERVATION = 2;        // 2 seconds
export const FAST_SETTLEMENT_DEADLINE = 5; // 5 seconds
export const FAST_CLAIM_EXPIRY = 5;       // 5 seconds

// Lamport helpers
export const SOL = (n: number) => new anchor.BN(n * LAMPORTS_PER_SOL);
export const LAMPORTS = (n: number) => new anchor.BN(n);
