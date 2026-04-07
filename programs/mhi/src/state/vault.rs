use anchor_lang::prelude::*;

/// Protocol vault holding all SOL for collateral, premiums, and payouts.
/// PDA seeds: [b"vault"]
///
/// Key invariant (enforced in handlers):
///   available + active_collateral + unclaimed_payouts == lamport_balance - rent_exempt
#[account]
pub struct Vault {
    pub version: u8,
    pub bump: u8,

    /// SOL available for new collateral commitments
    pub available_lamports: u64,
    /// SOL locked as collateral for active (unsettled) positions
    pub active_collateral_lamports: u64,
    /// SOL owed to winners but not yet claimed
    pub unclaimed_payouts_lamports: u64,

    /// Total premiums ever collected
    pub cumulative_premiums_lamports: u64,
    /// Total payouts ever distributed
    pub cumulative_payouts_lamports: u64,

    pub total_deposits_lamports: u64,
    pub total_shares: u64,
    pub protocol_seed_lamports: u64,
    pub protocol_shares: u64,
    pub management_fee_bps: u16,
    pub min_vault_balance_lamports: u64,
    pub accepting_deposits: bool,
}

impl Vault {
    pub const SPACE: usize = 8  // discriminator
        + 1   // version
        + 1   // bump
        + 8   // available_lamports
        + 8   // active_collateral_lamports
        + 8   // unclaimed_payouts_lamports
        + 8   // cumulative_premiums_lamports
        + 8   // cumulative_payouts_lamports
        + 8   // total_deposits_lamports
        + 8   // total_shares
        + 8   // protocol_seed_lamports
        + 8   // protocol_shares
        + 2   // management_fee_bps
        + 8   // min_vault_balance_lamports
        + 1;  // accepting_deposits

    /// Total tracked lamports (must equal actual balance minus rent).
    pub fn tracked_total(&self) -> Option<u64> {
        self.available_lamports
            .checked_add(self.active_collateral_lamports)?
            .checked_add(self.unclaimed_payouts_lamports)
    }
}
