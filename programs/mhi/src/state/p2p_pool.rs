use anchor_lang::prelude::*;

/// Persistent P2P writer pool. Writers deposit SOL and earn yield passively.
/// Capital is automatically allocated across strikes each cohort based on demand.
/// Similar to JLP - writers hold shares proportional to their deposit.
///
/// PDA seeds: [b"p2p_pool"]
#[account]
pub struct P2pPool {
    pub version: u8,
    pub bump: u8,

    /// Total SOL available for new cohort allocations
    pub available_lamports: u64,
    /// SOL currently locked as collateral in the active cohort
    pub active_collateral_lamports: u64,
    /// SOL reserved for unclaimed buyer payouts
    pub unclaimed_payouts_lamports: u64,

    /// Total shares outstanding (for pro-rata ownership)
    pub total_shares: u64,

    pub cumulative_premiums_lamports: u64,
    pub cumulative_payouts_lamports: u64,

    /// Whether new deposits are accepted
    pub accepting_deposits: bool,
}

impl P2pPool {
    pub const SPACE: usize = 8  // discriminator
        + 1   // version
        + 1   // bump
        + 8   // available_lamports
        + 8   // active_collateral_lamports
        + 8   // unclaimed_payouts_lamports
        + 8   // total_shares
        + 8   // cumulative_premiums_lamports
        + 8   // cumulative_payouts_lamports
        + 1;  // accepting_deposits

    /// Total value of the pool: available + collateral + unclaimed
    pub fn total_value(&self) -> Option<u64> {
        self.available_lamports
            .checked_add(self.active_collateral_lamports)?
            .checked_add(self.unclaimed_payouts_lamports)
    }

    /// Convert lamports to shares at current price
    pub fn lamports_to_shares(&self, lamports: u64) -> u64 {
        if self.total_shares == 0 || self.total_value().unwrap_or(0) == 0 {
            return lamports; // 1:1 when pool is empty
        }
        let total = self.total_value().unwrap_or(1);
        // shares = lamports * total_shares / total_value
        (lamports as u128)
            .checked_mul(self.total_shares as u128)
            .unwrap_or(0)
            .checked_div(total as u128)
            .unwrap_or(0) as u64
    }

    /// Convert shares to lamports at current price
    pub fn shares_to_lamports(&self, shares: u64) -> u64 {
        if self.total_shares == 0 {
            return 0;
        }
        let total = self.total_value().unwrap_or(0);
        // lamports = shares * total_value / total_shares
        (shares as u128)
            .checked_mul(total as u128)
            .unwrap_or(0)
            .checked_div(self.total_shares as u128)
            .unwrap_or(0) as u64
    }

    /// Sync tracked balances with actual PDA lamports.
    /// Any surplus (from direct transfers / donations) is added to available.
    /// Returns the surplus amount synced.
    pub fn sync_lamports(&mut self, actual_lamports: u64, rent_exempt: u64) -> Option<u64> {
        let tracked = self.total_value()?;
        let usable = actual_lamports.checked_sub(rent_exempt)?;
        if usable > tracked {
            let surplus = usable - tracked;
            self.available_lamports = self.available_lamports.checked_add(surplus)?;
            Some(surplus)
        } else {
            Some(0)
        }
    }

    /// Verify pool accounting invariant: tracked total <= actual lamports.
    pub fn check_conservation(&self, actual_lamports: u64, rent_exempt: u64) -> bool {
        let tracked = match self.total_value() {
            Some(t) => t,
            None => return false,
        };
        let usable = actual_lamports.saturating_sub(rent_exempt);
        tracked <= usable
    }
}
