//! On-chain invariant assertion functions.
//!
//! These encode the 6 invariants from DESIGN_MHI.md.
//! Called within instruction handlers at critical mutation points.
//!

use crate::constants::BPS_DENOMINATOR;

/// Invariant 1: Vault balance conservation.
/// `available + active_collateral + unclaimed_payouts == total_lamports - rent_exempt`
///
/// Returns true if the invariant holds.
pub fn vault_conservation(
    available: u64,
    active_collateral: u64,
    unclaimed_payouts: u64,
    total_lamports: u64,
    rent_exempt_min: u64,
) -> bool {
    let tracked = available
        .checked_add(active_collateral)
        .and_then(|v| v.checked_add(unclaimed_payouts));

    let actual = total_lamports.checked_sub(rent_exempt_min);

    match (tracked, actual) {
        (Some(t), Some(a)) => t == a,
        _ => false, // overflow or underflow = invariant violation
    }
}

/// Invariant 5: Payout never exceeds collateral locked for that position.
/// `payout <= (cap_bps - strike_bps) * size / BPS_DENOM`
///
/// Returns true if the invariant holds.
pub fn payout_within_collateral(
    payout_lamports: u64,
    cap_bps: u32,
    strike_bps: u32,
    size_lamports: u64,
) -> bool {
    let max_payoff_bps = match cap_bps.checked_sub(strike_bps) {
        Some(v) => v,
        None => return false, // cap < strike is a config error
    };

    let max_payout = (max_payoff_bps as u128)
        .checked_mul(size_lamports as u128)
        .and_then(|v| v.checked_div(BPS_DENOMINATOR as u128));

    match max_payout {
        Some(max) => (payout_lamports as u128) <= max,
        None => false,
    }
}

/// Invariant 3: If any positions have been settled, void_cohort is unreachable.
/// Returns true if void is BLOCKED (positions settled > 0).
pub fn void_blocked_by_settlement(positions_settled: u16) -> bool {
    positions_settled > 0
}

/// Invariant 4: If MHI has been submitted, void_cohort is unreachable.
/// Returns true if void is BLOCKED (MHI submitted).
pub fn void_blocked_by_mhi(mhi_bps: u32) -> bool {
    mhi_bps > 0
}

/// Invariant 6: Claim always transfers to position.owner.
/// This is enforced structurally in code, not by a runtime check.
/// This function exists for documentation and test verification.
pub fn claim_pays_owner(transfer_recipient: &[u8; 32], position_owner: &[u8; 32]) -> bool {
    transfer_recipient == position_owner
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn test_vault_conservation_holds() {
        // available=500, active=300, unclaimed=200, total=1100, rent=100
        // 500 + 300 + 200 = 1000 = 1100 - 100 ✓
        assert!(vault_conservation(500, 300, 200, 1_100, 100));
    }

    #[test]
    fn test_vault_conservation_fails() {
        // tracked=1001, actual=1000
        assert!(!vault_conservation(501, 300, 200, 1_100, 100));
    }

    #[test]
    fn test_vault_conservation_all_available() {
        assert!(vault_conservation(1_000, 0, 0, 1_100, 100));
    }

    #[test]
    fn test_vault_conservation_all_locked() {
        assert!(vault_conservation(0, 1_000, 0, 1_100, 100));
    }

    #[test]
    fn test_vault_conservation_overflow() {
        // tracked would overflow u64
        assert!(!vault_conservation(u64::MAX, 1, 0, u64::MAX, 0));
    }

    #[test]
    fn test_vault_conservation_underflow() {
        // total < rent_exempt -> underflow
        assert!(!vault_conservation(0, 0, 0, 50, 100));
    }


    #[test]
    fn test_payout_within_collateral_ok() {
        // cap 2.5x, strike 1.0x, size 1 SOL -> max payout 1.5 SOL
        // actual payout 0.5 SOL -> OK
        assert!(payout_within_collateral(
            500_000_000,
            25_000,
            10_000,
            1_000_000_000
        ));
    }

    #[test]
    fn test_payout_at_max_collateral() {
        // payout exactly equals max -> OK
        assert!(payout_within_collateral(
            1_500_000_000,
            25_000,
            10_000,
            1_000_000_000
        ));
    }

    #[test]
    fn test_payout_exceeds_collateral() {
        // payout > max -> violation
        assert!(!payout_within_collateral(
            1_500_000_001,
            25_000,
            10_000,
            1_000_000_000
        ));
    }

    #[test]
    fn test_payout_zero() {
        assert!(payout_within_collateral(0, 25_000, 10_000, 1_000_000_000));
    }

    #[test]
    fn test_payout_cap_below_strike() {
        // Invalid config: cap < strike -> always fails
        assert!(!payout_within_collateral(0, 10_000, 25_000, 1_000_000_000));
    }


    #[test]
    fn test_void_blocked_after_settlement() {
        assert!(void_blocked_by_settlement(1));
        assert!(void_blocked_by_settlement(100));
    }

    #[test]
    fn test_void_not_blocked_before_settlement() {
        assert!(!void_blocked_by_settlement(0));
    }


    #[test]
    fn test_void_blocked_after_mhi() {
        assert!(void_blocked_by_mhi(1));
        assert!(void_blocked_by_mhi(15_000));
    }

    #[test]
    fn test_void_not_blocked_without_mhi() {
        assert!(!void_blocked_by_mhi(0));
    }


    #[test]
    fn test_claim_pays_correct_owner() {
        let owner = [1u8; 32];
        assert!(claim_pays_owner(&owner, &owner));
    }

    #[test]
    fn test_claim_wrong_recipient() {
        let owner = [1u8; 32];
        let other = [2u8; 32];
        assert!(!claim_pays_owner(&other, &owner));
    }
}
