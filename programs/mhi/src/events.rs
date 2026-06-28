use anchor_lang::prelude::*;

#[event]
pub struct ProtocolInitialized {
    pub authority: Pubkey,
    pub keeper: Pubkey,
}

#[event]
pub struct ConfigUpdated {
    pub authority: Pubkey,
}

#[event]
pub struct VaultSeeded {
    pub authority: Pubkey,
    pub amount: u64,
    pub new_available: u64,
}

#[event]
pub struct AuthorityTransferred {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct CohortStarted {
    pub index: u64,
    pub trading_start: i64,
    pub trading_deadline: i64,
    /// Per-slot strikes for this cohort (BPS). Indexed 0..NUM_STRIKES.
    pub strikes: [u32; crate::constants::NUM_STRIKES],
    /// Snapshot of the global strike anchor at start (used as the EMA-fraction
    /// denominator at settlement).
    pub strike_anchor_bps: u32,
}

#[event]
pub struct CallPurchased {
    pub cohort_index: u64,
    pub buyer: Pubkey,
    pub strike_bps: u32,
    pub size_lamports: u64,
    pub premium_paid: u64,
    pub referrer: Option<Pubkey>,
    pub referral_payout: u64,
}

#[event]
pub struct MhiSubmitted {
    pub cohort_index: u64,
    /// The (clamped) MHI actually stored on chain — keeper consumers must
    /// feed THIS, not their pre-submission value, into the local anchor / EMA.
    pub mhi_bps: u32,
    pub token_count: u16,
    pub cohort_hash: [u8; 32],
    /// Updated `GlobalState.strike_anchor_bps` after this settlement.
    pub new_strike_anchor_bps: u32,
}

#[event]
pub struct PositionSettled {
    pub cohort_index: u64,
    pub owner: Pubkey,
    pub strike_bps: u32,
    pub size_lamports: u64,
    pub payout_lamports: u64,
}

#[event]
pub struct PayoutClaimed {
    pub cohort_index: u64,
    pub owner: Pubkey,
    pub payout_lamports: u64,
}

#[event]
pub struct PositionExpired {
    pub cohort_index: u64,
    pub owner: Pubkey,
    pub unclaimed_lamports: u64,
}

/// Emitted by close_position / close_p2p_position when a settled+claimed
/// position PDA is reclaimed. `rent_recovered` is the lamports refunded to
/// the caller (~0.002 SOL per PDA). The cohort PDA may already be closed
/// at this point — the indexer correlates via prior CohortStarted events.
#[event]
pub struct PositionClosed {
    pub cohort: Pubkey,
    pub owner: Pubkey,
    pub strike_bps: u32,
    pub nonce: u8,
    pub caller: Pubkey,
    pub rent_recovered: u64,
}

#[event]
pub struct VaultWithdrawn {
    pub authority: Pubkey,
    pub amount: u64,
    pub remaining_available: u64,
}

#[event]
pub struct CohortVoided {
    pub cohort_index: u64,
}
