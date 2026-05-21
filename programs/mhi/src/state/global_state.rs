use anchor_lang::prelude::*;

/// Maximum number of cohorts that can be active (trading/measuring/settling) simultaneously.
/// With 10-min intervals and 30-min rounds, 3 overlapping cohorts is the natural maximum.
pub const MAX_ACTIVE_COHORTS: u8 = 3;

/// Global configuration and state for the MHI protocol.
/// PDA seeds: [b"global_state"]
#[account]
pub struct GlobalState {
    pub version: u8,
    pub bump: u8,

    pub authority: Pubkey,
    /// Pending authority for two-step transfer. Pubkey::default() = no pending transfer.
    pub pending_authority: Pubkey,
    pub keeper: Pubkey,

    pub mhi_cap_bps: u32,
    pub premium_fee_bps: u16,
    pub keeper_fee_lamports: u64,
    pub min_position_lamports: u64,
    pub min_premium_lamports: u64,
    /// DEPRECATED: Never enforced on-chain. Kept for account layout compatibility.
    /// Per-address concentration is naturally priced by the bonding surge curve.
    pub _deprecated_max_position_per_address_bps: u16,
    pub max_vault_risk_per_cohort_bps: u16,
    /// Max collateral a single position can lock, as BPS of the cohort cap.
    /// 500 = 5% of cohort cap = 0.75% of vault total. Prevents one whale
    /// from eating the entire cohort's capacity.
    pub max_position_collateral_bps: u16,
    pub referral_share_bps: u16,

    pub trading_window_seconds: u32,
    pub measurement_seconds: u32,
    pub observation_seconds: u32,
    pub settlement_deadline_seconds: u32,
    pub claim_expiry_seconds: u32,

    /// Advisory MHI floor for off-chain keeper alerting (not enforced on-chain)
    pub mhi_floor_bps: u32,
    /// Max % change per cohort (BPS). Keeper submissions are clamped to
    /// last_mhi ± (last_mhi * mhi_max_delta_bps / 10000). Set to 0 to disable.
    /// Default 3300 = 33% per cohort.
    pub mhi_max_delta_bps: u32,
    /// Last settled MHI value (reference for next cohort's clamp)
    pub last_mhi_bps: u32,

    /// Next cohort index to allocate. Monotonically increasing, incremented in start_cohort.
    pub current_cohort_index: u64,
    /// Number of cohorts currently in a non-terminal state (Trading/Measuring/Settling).
    /// Replaces the old ProtocolStatus enum (same byte offset, same size).
    pub active_cohorts: u8,
    pub total_cohorts: u64,
    pub total_volume_lamports: u64,

    pub paused: bool,

    /// Fee on P2P buyer premium (BPS). 500 = 5%.
    pub p2p_buyer_fee_bps: u16,
    /// Fee on P2P writer earnings (BPS). 500 = 5%.
    pub p2p_writer_fee_bps: u16,
    /// Kill switch for P2P functionality
    pub p2p_enabled: bool,

    /// EMA-smoothed strike anchor (BPS). Updated in submit_mhi using the
    /// clamped MHI: anchor = (ALPHA*mhi + COMPLEMENT*prev_anchor) / 10_000,
    /// floored at STRIKE_ANCHOR_MIN_BPS. Used by start_cohort to verify
    /// keeper-supplied strikes, and by buy_call to rescale the fractional EMA
    /// into a payoff bps quote.
    pub strike_anchor_bps: u32,
    /// Number of settlements that have updated `strike_anchor_bps`. Stays at 0
    /// until the first submit_mhi lands, at which point the cold-start default
    /// is replaced with the first observed MHI.
    pub strike_anchor_settlement_count: u64,
}

impl GlobalState {
    /// Account space: 8 (discriminator) + fields
    pub const SPACE: usize = 8  // discriminator
        + 1   // version
        + 1   // bump
        + 32  // authority
        + 32  // pending_authority
        + 32  // keeper
        + 4   // mhi_cap_bps
        + 2   // premium_fee_bps
        + 8   // keeper_fee_lamports
        + 8   // min_position_lamports
        + 8   // min_premium_lamports
        + 2   // _deprecated_max_position_per_address_bps
        + 2   // max_vault_risk_per_cohort_bps
        + 2   // max_position_collateral_bps
        + 2   // referral_share_bps
        + 4   // trading_window_seconds
        + 4   // measurement_seconds
        + 4   // observation_seconds
        + 4   // settlement_deadline_seconds
        + 4   // claim_expiry_seconds
        + 4   // mhi_floor_bps
        + 4   // mhi_max_delta_bps
        + 4   // last_mhi_bps
        + 8   // current_cohort_index
        + 1   // active_cohorts
        + 8   // total_cohorts
        + 8   // total_volume_lamports
        + 1   // paused
        + 2   // p2p_buyer_fee_bps
        + 2   // p2p_writer_fee_bps
        + 1   // p2p_enabled
        + 4   // strike_anchor_bps
        + 8;  // strike_anchor_settlement_count

    /// Whether a new cohort can be started (below the overlap limit).
    pub fn can_start_cohort(&self) -> bool {
        self.active_cohorts < MAX_ACTIVE_COHORTS
    }
}
