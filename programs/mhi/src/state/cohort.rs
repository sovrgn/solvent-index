use anchor_lang::prelude::*;

use crate::constants::NUM_STRIKES;

/// Lifecycle status of a cohort.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum CohortStatus {
    /// Trading window is open. Buyers can purchase calls.
    Trading = 0,
    /// Trading closed. TWAP measurement + observation in progress.
    Measuring = 1,
    /// MHI submitted and settlement in progress (some positions settled).
    Settling = 2,
    /// All positions settled. Collateral released.
    Settled = 3,
    /// Emergency void. Premiums refunded, collateral released.
    Voided = 4,
    /// Void in progress. Positions being refunded across batched transactions.
    /// Transitions to Voided when all vault positions are voided.
    Voiding = 5,
}

/// Per-cohort state tracking.
/// PDA seeds: [b"cohort", cohort_index.to_le_bytes()]
#[account]
pub struct Cohort {
    pub bump: u8,
    pub index: u64,
    pub status: CohortStatus,

    pub trading_start: i64,
    pub trading_deadline: i64,
    pub measurement_deadline: i64,
    pub settlement_deadline: i64,
    pub recovery_deadline: i64,

    /// Posted by keeper. 0 = not yet submitted.
    pub mhi_bps: u32,
    pub token_count: u16,
    /// SHA256 of sorted token mints (for verifiability)
    pub cohort_hash: [u8; 32],

    pub total_call_volume_lamports: u64,
    pub total_positions: u32,
    pub positions_settled: u32,

    pub vault_collateral_locked: u64,
    pub vault_premiums_collected: u64,
    pub vault_payouts_due: u64,

    /// Notional volume at each strike index during this cohort's trading window.
    /// Used for intra-cohort bonding curve and post-cohort demand markup adjustment.
    pub strike_volume_lamports: [u64; NUM_STRIKES],

    /// Total P2P collateral locked by writers for this cohort
    pub p2p_collateral_locked: u64,
    /// Total premiums collected from P2P positions
    pub p2p_premiums_collected: u64,
    /// Total payouts due from P2P positions
    pub p2p_payouts_due: u64,
    /// Number of P2P positions
    pub p2p_positions: u32,
    /// Number of P2P positions settled
    pub p2p_positions_settled: u32,
    /// Available P2P writer collateral per strike (for overflow matching)
    pub p2p_strike_collateral: [u64; NUM_STRIKES],

    /// Number of vault positions voided (for batchable void_cohort)
    pub positions_voided: u32,

    /// Count of Position PDAs still alive (incremented on buy_call,
    /// decremented when the PDA is closed by claim or expire_position).
    /// close_cohort requires this to be zero to prevent bricking unclaimed positions.
    pub outstanding_positions: u32,

    /// Count of P2pPosition PDAs still alive. Same lifecycle as outstanding_positions
    /// but for the P2P side.
    pub outstanding_p2p_positions: u32,

    /// Per-slot strikes for this cohort (BPS), set by start_cohort. Computed
    /// off-chain by the keeper from `floor(anchor * STRIKE_MULTIPLIERS_BPS[i] / 10_000)`
    /// (with the STRIKE_ANCHOR_MIN_BPS floor) and verified on-chain against
    /// the same formula evaluated on `GlobalState.strike_anchor_bps` at start.
    /// Indexed by slot 0..NUM_STRIKES, ascending.
    pub strikes: [u32; NUM_STRIKES],
    /// Snapshot of `GlobalState.strike_anchor_bps` at start_cohort. Used as
    /// the denominator when submit_mhi normalizes payoff into a fraction —
    /// must travel with the cohort because later cohorts may shift the global
    /// anchor before this one settles.
    pub strike_anchor_bps_at_start: u32,
    /// Snapshot of `GlobalState.mhi_cap_bps` at start_cohort. The cap that
    /// sizes locked collateral (buy_call), caps released collateral and
    /// payouts (settle, void), and bounds the keeper's MHI submission. Must
    /// travel with the cohort so an authority `update_config { mhi_cap_bps }`
    /// mid-flight cannot retroactively change any cohort's economics.
    pub mhi_cap_bps_at_start: u32,
}

impl Cohort {
    pub const SPACE: usize = 8  // discriminator
        + 1   // bump
        + 8   // index
        + 1   // status
        + 8   // trading_start
        + 8   // trading_deadline
        + 8   // measurement_deadline
        + 8   // settlement_deadline
        + 8   // recovery_deadline
        + 4   // mhi_bps
        + 2   // token_count
        + 32  // cohort_hash
        + 8   // total_call_volume_lamports
        + 4   // total_positions
        + 4   // positions_settled
        + 8   // vault_collateral_locked
        + 8   // vault_premiums_collected
        + 8   // vault_payouts_due
        + (8 * NUM_STRIKES) // strike_volume_lamports
        + 8   // p2p_collateral_locked
        + 8   // p2p_premiums_collected
        + 8   // p2p_payouts_due
        + 4   // p2p_positions
        + 4   // p2p_positions_settled
        + (8 * NUM_STRIKES) // p2p_strike_collateral
        + 4   // positions_voided
        + 4   // outstanding_positions
        + 4   // outstanding_p2p_positions
        + (4 * NUM_STRIKES) // strikes
        + 4   // strike_anchor_bps_at_start
        + 4;  // mhi_cap_bps_at_start

    pub fn is_trading(&self) -> bool {
        self.status == CohortStatus::Trading
    }

    pub fn is_resolved(&self) -> bool {
        matches!(self.status, CohortStatus::Settled | CohortStatus::Voided)
    }

    pub fn has_mhi(&self) -> bool {
        self.mhi_bps > 0
    }

    /// Returns true when all positions (vault + P2P) have been settled.
    /// Returns false if there are no positions at all (empty cohort handled separately).
    pub fn all_settled(&self) -> bool {
        let has_positions = self.total_positions > 0 || self.p2p_positions > 0;
        if !has_positions {
            return false; // empty cohort - caller must handle this case
        }
        let vault_done = self.total_positions == 0 || self.positions_settled >= self.total_positions;
        let p2p_done = self.p2p_positions == 0 || self.p2p_positions_settled >= self.p2p_positions;
        vault_done && p2p_done
    }

    /// Returns true if there are no positions of any kind.
    pub fn is_empty(&self) -> bool {
        self.total_positions == 0 && self.p2p_positions == 0
    }

    /// Returns true when every position PDA derived from this cohort has been
    /// closed (via claim or expire). close_cohort uses this as its safety gate.
    pub fn is_quiescent(&self) -> bool {
        self.outstanding_positions == 0 && self.outstanding_p2p_positions == 0
    }
}
