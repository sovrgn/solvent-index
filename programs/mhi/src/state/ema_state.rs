use anchor_lang::prelude::*;

use crate::constants::NUM_STRIKES;

/// Per-strike EMA tracking with demand-driven markup.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default)]
pub struct StrikeEma {
    pub strike_bps: u32,
    pub fast_ema_bps: u32,
    pub slow_ema_bps: u32,
    /// Per-strike demand markup (adjusted between cohorts based on volume share).
    pub demand_markup_bps: u16,
}

impl StrikeEma {
    pub const SIZE: usize = 4 + 4 + 4 + 2; // 14 bytes

    /// Fair premium for this strike: max(fast, slow).
    pub fn fair_premium_bps(&self) -> u32 {
        self.fast_ema_bps.max(self.slow_ema_bps)
    }
}

/// EMA pricing state for all strikes.
/// PDA seeds: [b"ema_state"]
#[account]
pub struct EmaState {
    pub version: u8,
    pub bump: u8,
    pub strikes: [StrikeEma; NUM_STRIKES],
    /// Deprecated - replaced by per-strike demand_markup_bps. Kept for layout compat.
    pub markup_bps: u16,
    pub last_updated_cohort: u64,
}

impl EmaState {
    pub const SPACE: usize = 8  // discriminator
        + 1   // version
        + 1   // bump
        + (StrikeEma::SIZE * NUM_STRIKES) // strikes array (14 * 7 = 98)
        + 2   // markup_bps (deprecated)
        + 8;  // last_updated_cohort

    /// Find a strike in the array. Returns index if found.
    pub fn find_strike(&self, strike_bps: u32) -> Option<usize> {
        self.strikes.iter().position(|s| s.strike_bps == strike_bps)
    }

    /// Check if a strike_bps value is valid (exists in the set).
    pub fn is_valid_strike(&self, strike_bps: u32) -> bool {
        self.find_strike(strike_bps).is_some()
    }
}
