use anchor_lang::prelude::*;

/// A buyer's call option position.
/// PDA seeds: [b"position", cohort_key, owner_key, strike_bps.to_le_bytes(), nonce.to_le_bytes()]
#[account]
pub struct Position {
    pub bump: u8,
    pub owner: Pubkey,
    pub cohort: Pubkey,
    pub strike_bps: u32,
    pub size_lamports: u64,
    /// Full premium buyer paid (including referral portion)
    pub premium_paid_lamports: u64,
    /// Amount that actually entered the vault (premium minus referral payout).
    /// Used by void_cohort to refund the correct amount.
    pub vault_premium_lamports: u64,
    pub nonce: u8,
    pub settled: bool,
    pub payout_lamports: u64,
    pub claim_deadline: i64,
    pub claimed: bool,
}

impl Position {
    pub const SPACE: usize = 8  // discriminator
        + 1   // bump
        + 32  // owner
        + 32  // cohort
        + 4   // strike_bps
        + 8   // size_lamports
        + 8   // premium_paid_lamports
        + 8   // vault_premium_lamports
        + 1   // nonce
        + 1   // settled
        + 8   // payout_lamports
        + 8   // claim_deadline
        + 1;  // claimed
}
