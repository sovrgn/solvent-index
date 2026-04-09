//! Payoff and collateral calculations for call options.
//!
//! All values in BPS (basis points) or lamports. No floating point.
//! Rounding: payouts round DOWN (protocol never overpays).
//!

use crate::constants::BPS_DENOMINATOR;

/// Raw call payoff in BPS: `max(mhi_bps - strike_bps, 0)`.
/// Returns the intrinsic value of a call option.
pub fn call_payoff_bps(mhi_bps: u32, strike_bps: u32) -> u32 {
    mhi_bps.saturating_sub(strike_bps)
}

/// Capped call payoff in BPS: `min(max(mhi - strike, 0), cap - strike)`.
/// The cap limits maximum payout per unit.
/// Returns None if cap < strike (invalid configuration).
pub fn capped_payoff_bps(mhi_bps: u32, strike_bps: u32, cap_bps: u32) -> Option<u32> {
    let max_payoff = cap_bps.checked_sub(strike_bps)?;
    let raw_payoff = call_payoff_bps(mhi_bps, strike_bps);
    Some(raw_payoff.min(max_payoff))
}

/// Payout in lamports for a given payoff and size.
/// `payout = payoff_bps * size_lamports / BPS_DENOMINATOR`.
/// Rounds DOWN - protocol never overpays.
pub fn payout_lamports(payoff_bps: u32, size_lamports: u64) -> Option<u64> {
    let result = (payoff_bps as u128)
        .checked_mul(size_lamports as u128)?
        .checked_div(BPS_DENOMINATOR as u128)?;
    u64::try_from(result).ok()
}

/// Collateral required per unit in BPS: `cap_bps - strike_bps`.
/// This is the maximum possible payoff per unit.
/// Returns None if cap < strike.
pub fn collateral_per_unit_bps(cap_bps: u32, strike_bps: u32) -> Option<u32> {
    cap_bps.checked_sub(strike_bps)
}

/// Total collateral in lamports for a position. Rounds DOWN.
/// Used in settle_batch for payout cap comparison (conservative: payout ≤ collateral).
pub fn total_collateral_lamports(
    cap_bps: u32,
    strike_bps: u32,
    size_lamports: u64,
) -> Option<u64> {
    let per_unit_bps = collateral_per_unit_bps(cap_bps, strike_bps)?;
    let result = (per_unit_bps as u128)
        .checked_mul(size_lamports as u128)?
        .checked_div(BPS_DENOMINATOR as u128)?;
    u64::try_from(result).ok()
}

/// Total collateral in lamports, rounding UP (ceiling).
/// Used in buy_call to lock sufficient collateral - vault must lock at least
/// enough to cover the maximum possible payout.
/// `collateral = (cap - strike) * size / BPS_DENOM`, ceiling.
pub fn total_collateral_lamports_ceil(
    cap_bps: u32,
    strike_bps: u32,
    size_lamports: u64,
) -> Option<u64> {
    let per_unit_bps = collateral_per_unit_bps(cap_bps, strike_bps)?;
    let numerator = (per_unit_bps as u128)
        .checked_mul(size_lamports as u128)?;
    let denom = BPS_DENOMINATOR as u128;
    let result = numerator.checked_add(denom - 1)?.checked_div(denom)?;
    u64::try_from(result).ok()
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn test_payoff_itm() {
        // MHI 1.5x, strike 1.0x -> payoff 0.5x = 5000 BPS
        assert_eq!(call_payoff_bps(15_000, 10_000), 5_000);
    }

    #[test]
    fn test_payoff_atm() {
        // MHI = strike -> payoff 0
        assert_eq!(call_payoff_bps(10_000, 10_000), 0);
    }

    #[test]
    fn test_payoff_otm() {
        // MHI 0.8x, strike 1.0x -> payoff 0 (saturating sub)
        assert_eq!(call_payoff_bps(8_000, 10_000), 0);
    }

    #[test]
    fn test_payoff_deep_itm() {
        // MHI 3.0x, strike 1.0x -> 2.0x = 20_000 BPS
        assert_eq!(call_payoff_bps(30_000, 10_000), 20_000);
    }


    #[test]
    fn test_capped_payoff_below_cap() {
        // MHI 1.5x, strike 1.0x, cap 2.5x -> payoff 0.5x (below cap of 1.5x)
        assert_eq!(capped_payoff_bps(15_000, 10_000, 25_000), Some(5_000));
    }

    #[test]
    fn test_capped_payoff_at_cap() {
        // MHI 3.5x, strike 1.0x, cap 2.5x -> capped at 1.5x = 15_000 BPS
        assert_eq!(capped_payoff_bps(35_000, 10_000, 25_000), Some(15_000));
    }

    #[test]
    fn test_capped_payoff_otm() {
        // MHI 0.5x, strike 1.0x, cap 2.5x -> 0
        assert_eq!(capped_payoff_bps(5_000, 10_000, 25_000), Some(0));
    }

    #[test]
    fn test_capped_payoff_cap_below_strike() {
        // Invalid: cap < strike -> None
        assert_eq!(capped_payoff_bps(15_000, 25_000, 10_000), None);
    }

    #[test]
    fn test_capped_payoff_2x_strike() {
        // MHI 2.8x, strike 2.0x, cap 2.5x -> min(0.8x, 0.5x) = 0.5x = 5_000
        assert_eq!(capped_payoff_bps(28_000, 20_000, 25_000), Some(5_000));
    }


    #[test]
    fn test_payout_basic() {
        // 5000 BPS payoff on 1 SOL = 0.5 SOL
        assert_eq!(payout_lamports(5_000, 1_000_000_000), Some(500_000_000));
    }

    #[test]
    fn test_payout_zero_payoff() {
        assert_eq!(payout_lamports(0, 1_000_000_000), Some(0));
    }

    #[test]
    fn test_payout_zero_size() {
        assert_eq!(payout_lamports(5_000, 0), Some(0));
    }

    #[test]
    fn test_payout_rounds_down() {
        // 1 BPS on 9999 lamports = 9999 / 10000 = 0 (floor)
        assert_eq!(payout_lamports(1, 9_999), Some(0));
        // 1 BPS on 10001 lamports = 10001 / 10000 = 1
        assert_eq!(payout_lamports(1, 10_001), Some(1));
    }

    #[test]
    fn test_payout_large_values() {
        // 15_000 BPS (1.5x cap payoff) on 1000 SOL
        let size = 1_000 * 1_000_000_000u64;
        assert_eq!(payout_lamports(15_000, size), Some(1_500_000_000_000));
    }


    #[test]
    fn test_collateral_per_unit_1x() {
        // cap 2.5x, strike 1.0x -> 1.5x = 15_000 BPS
        assert_eq!(collateral_per_unit_bps(25_000, 10_000), Some(15_000));
    }

    #[test]
    fn test_collateral_per_unit_2x() {
        // cap 2.5x, strike 2.0x -> 0.5x = 5_000 BPS
        assert_eq!(collateral_per_unit_bps(25_000, 20_000), Some(5_000));
    }

    #[test]
    fn test_collateral_invalid() {
        assert_eq!(collateral_per_unit_bps(10_000, 25_000), None);
    }


    #[test]
    fn test_total_collateral_basic() {
        // cap 2.5x, strike 1.0x, size 1 SOL -> 1.5 SOL
        assert_eq!(
            total_collateral_lamports(25_000, 10_000, 1_000_000_000),
            Some(1_500_000_000)
        );
    }

    #[test]
    fn test_total_collateral_zero_size() {
        assert_eq!(total_collateral_lamports(25_000, 10_000, 0), Some(0));
    }

    #[test]
    fn test_total_collateral_high_strike() {
        // cap 2.5x, strike 2.0x, size 1 SOL -> 0.5 SOL
        assert_eq!(
            total_collateral_lamports(25_000, 20_000, 1_000_000_000),
            Some(500_000_000)
        );
    }


    #[test]
    fn test_total_collateral_ceil_basic() {
        assert_eq!(
            total_collateral_lamports_ceil(25_000, 10_000, 1_000_000_000),
            Some(1_500_000_000) // exact, same as floor
        );
    }

    #[test]
    fn test_total_collateral_ceil_rounds_up() {
        // cap 2.5x, strike 1.0x, size 9999 lamports
        // floor: 15000 * 9999 / 10000 = 14998.5 -> 14998
        // ceil: 14999
        assert_eq!(total_collateral_lamports(25_000, 10_000, 9_999), Some(14_998));
        assert_eq!(total_collateral_lamports_ceil(25_000, 10_000, 9_999), Some(14_999));
    }

    #[test]
    fn test_total_collateral_ceil_always_gte_floor() {
        let cases = [
            (25_000u32, 10_000u32, 1u64),
            (25_000, 10_000, 9_999),
            (25_000, 10_000, 10_001),
            (25_000, 20_000, 7_777),
            (25_000, 15_000, 33_333),
        ];
        for (cap, strike, size) in cases {
            let floor = total_collateral_lamports(cap, strike, size).unwrap();
            let ceil = total_collateral_lamports_ceil(cap, strike, size).unwrap();
            assert!(
                ceil >= floor,
                "ceil {ceil} < floor {floor} for cap={cap}, strike={strike}, size={size}"
            );
        }
    }


    #[test]
    fn test_payout_never_exceeds_collateral_ceil() {
        let cap = 25_000u32;
        // Include non-round sizes that expose rounding
        let test_cases: Vec<(u32, u32, u64)> = vec![
            (15_000, 10_000, 1_000_000_000),
            (30_000, 10_000, 1_000_000_000),
            (25_000, 20_000, 500_000_000),
            (10_000, 10_000, 1_000_000_000),
            (5_000, 10_000, 1_000_000_000),
            (50_000, 15_000, 2_000_000_000),
            // Non-round sizes that expose rounding
            (25_000, 10_000, 9_999),
            (25_000, 10_000, 10_001),
            (15_000, 12_000, 7_777),
            (20_000, 15_000, 33_333),
            (25_000, 10_000, 1),
        ];

        for (mhi, strike, size) in test_cases {
            let payoff = capped_payoff_bps(mhi, strike, cap).unwrap();
            let payout = payout_lamports(payoff, size).unwrap();
            let collateral_ceil = total_collateral_lamports_ceil(cap, strike, size).unwrap();
            assert!(
                payout <= collateral_ceil,
                "payout {payout} > collateral_ceil {collateral_ceil} for mhi={mhi}, strike={strike}, size={size}"
            );
        }
    }
}
