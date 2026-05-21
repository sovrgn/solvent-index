use anchor_lang::prelude::*;

use crate::constants::NUM_STRIKES;

/// Per-slot fractional EMA state. The fast/slow EMAs track
/// `payoff_bps / anchor_bps_at_settlement × BPS_DENOMINATOR` so that the
/// stored values remain valid as the anchor (and therefore the per-cohort
/// strike ladder) re-scales. Mirrors keeper/lib/ema-pricer.ts `DualEMAState`.
///
/// Slot index, not absolute strike, is the EMA's key — strikes for a given
/// cohort live on the `Cohort` account and change every round.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default)]
pub struct SlotEma {
    pub fast_frac_bps: u32,
    pub slow_frac_bps: u32,
    /// Per-slot demand markup (adjusted between cohorts based on volume share).
    pub demand_markup_bps: u16,
}

impl SlotEma {
    pub const SIZE: usize = 4 + 4 + 2; // 10 bytes

    /// Fractional fair payoff for this slot in BPS: max(fast_frac, slow_frac).
    /// Multiply by the current anchor and divide by BPS_DENOMINATOR to recover
    /// the fair payoff in absolute BPS.
    pub fn fair_frac_bps(&self) -> u32 {
        self.fast_frac_bps.max(self.slow_frac_bps)
    }
}

/// EMA pricing state for all slots.
/// PDA seeds: [b"ema_state"]
#[account]
pub struct EmaState {
    pub version: u8,
    pub bump: u8,
    pub slots: [SlotEma; NUM_STRIKES],
    /// Deprecated - retained for layout compat, no longer touched by handlers.
    pub markup_bps: u16,
    pub last_updated_cohort: u64,
}

impl EmaState {
    pub const SPACE: usize = 8  // discriminator
        + 1   // version
        + 1   // bump
        + (SlotEma::SIZE * NUM_STRIKES) // slots array (10 * 7 = 70)
        + 2   // markup_bps (deprecated)
        + 8;  // last_updated_cohort
}
