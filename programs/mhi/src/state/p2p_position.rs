use anchor_lang::prelude::*;

/// A buyer's call option backed by a P2P writer (not the protocol vault).
/// Same payoff structure as a vault-backed Position, but payout comes from
/// the writer's escrowed collateral in the P2P pool.
///
/// PDA seeds: [b"p2p_position", cohort_key, buyer_key, strike_bps.to_le_bytes(), &[nonce]]
#[account]
pub struct P2pPosition {
    pub bump: u8,
    /// Buyer who owns this position
    pub owner: Pubkey,
    /// Which cohort this position belongs to
    pub cohort: Pubkey,
    /// The P2P pool PDA that backs this position's collateral
    pub p2p_pool: Pubkey,
    /// Strike price in BPS
    pub strike_bps: u32,
    /// Notional size in lamports
    pub size_lamports: u64,
    /// Total premium paid by the buyer (including protocol fee)
    pub premium_paid_lamports: u64,
    /// Premium portion that went to the writer (after protocol fee)
    pub writer_premium_lamports: u64,
    /// Position nonce (for multiple positions at same strike)
    pub nonce: u8,
    /// Has this position been settled?
    pub settled: bool,
    /// Payout amount in lamports (0 if OTM)
    pub payout_lamports: u64,
    /// Deadline for claiming payout (unix timestamp)
    pub claim_deadline: i64,
    /// Has the buyer claimed their payout?
    pub claimed: bool,
}

impl P2pPosition {
    pub const SPACE: usize = 8  // discriminator
        + 1   // bump
        + 32  // owner
        + 32  // cohort
        + 32  // p2p_pool
        + 4   // strike_bps
        + 8   // size_lamports
        + 8   // premium_paid_lamports
        + 8   // writer_premium_lamports
        + 1   // nonce
        + 1   // settled
        + 8   // payout_lamports
        + 8   // claim_deadline
        + 1;  // claimed
}
