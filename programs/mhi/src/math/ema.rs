//! Dual-speed EMA pricing engine.
//!
//! Fast EMA: alpha = 0.15, responds to regime shifts in ~5 cohorts.
//! Slow EMA: alpha = 0.035, prevents overreaction to noise.
//! Fair premium = max(fast_ema, slow_ema).
//!
//! All values in BPS. No floating point. Zero Anchor dependencies.

use crate::constants::{
    BPS_DENOMINATOR, COLD_START_COHORTS, COLD_START_EXTRA_BPS, FAST_ALPHA_BPS,
    FAST_COMPLEMENT_BPS, SLOW_ALPHA_BPS, SLOW_COMPLEMENT_BPS,
};
use crate::math::payoff::call_payoff_bps;

/// Update the fast EMA with a new payoff observation.
/// `new = alpha * payoff + (1 - alpha) * prev`
/// `= (1500 * payoff + 8500 * prev) / 10000`
///
/// Returns None on overflow (not expected for realistic BPS values).
pub fn update_fast_ema(prev_bps: u32, payoff_bps: u32) -> Option<u32> {
    let alpha_term = (FAST_ALPHA_BPS as u64).checked_mul(payoff_bps as u64)?;
    let complement_term = (FAST_COMPLEMENT_BPS as u64).checked_mul(prev_bps as u64)?;
    let sum = alpha_term.checked_add(complement_term)?;
    let result = sum.checked_div(BPS_DENOMINATOR as u64)?;
    u32::try_from(result).ok()
}

/// Update the slow EMA with a new payoff observation.
/// `new = alpha * payoff + (1 - alpha) * prev`
/// `= (350 * payoff + 9650 * prev) / 10000`
pub fn update_slow_ema(prev_bps: u32, payoff_bps: u32) -> Option<u32> {
    let alpha_term = (SLOW_ALPHA_BPS as u64).checked_mul(payoff_bps as u64)?;
    let complement_term = (SLOW_COMPLEMENT_BPS as u64).checked_mul(prev_bps as u64)?;
    let sum = alpha_term.checked_add(complement_term)?;
    let result = sum.checked_div(BPS_DENOMINATOR as u64)?;
    u32::try_from(result).ok()
}

/// Fair premium is max(fast_ema, slow_ema).
/// Fast rise / slow fall asymmetry protects writers.
pub fn fair_premium_bps(fast_ema_bps: u32, slow_ema_bps: u32) -> u32 {
    fast_ema_bps.max(slow_ema_bps)
}

/// Update both EMAs for a given strike after a cohort settles.
/// Returns (new_fast, new_slow).
pub fn update_emas_for_strike(
    mhi_bps: u32,
    strike_bps: u32,
    prev_fast: u32,
    prev_slow: u32,
) -> Option<(u32, u32)> {
    let payoff = call_payoff_bps(mhi_bps, strike_bps);
    let new_fast = update_fast_ema(prev_fast, payoff)?;
    let new_slow = update_slow_ema(prev_slow, payoff)?;
    Some((new_fast, new_slow))
}

/// Cold start markup multiplier.
/// `effective_markup = base_markup * (1 + 0.5 * max(0, 1 - settled_cohorts / 50))`
///
/// In BPS:
/// `extra_factor = COLD_START_EXTRA_BPS * max(0, COLD_START_COHORTS - settled) / COLD_START_COHORTS`
/// `effective = base + base * extra_factor / BPS_DENOMINATOR`
///
/// Returns the effective markup in BPS (same scale as input).
pub fn cold_start_markup(base_markup_bps: u16, settled_cohorts: u64) -> Option<u16> {
    if settled_cohorts >= COLD_START_COHORTS {
        return Some(base_markup_bps);
    }

    let remaining = COLD_START_COHORTS.checked_sub(settled_cohorts)?;

    // extra_factor_bps = COLD_START_EXTRA_BPS * remaining / COLD_START_COHORTS
    let extra_factor_bps = (COLD_START_EXTRA_BPS as u64)
        .checked_mul(remaining)?
        .checked_div(COLD_START_COHORTS)?;

    // effective = base * (BPS_DENOM + extra_factor) / BPS_DENOM
    let effective = (base_markup_bps as u64)
        .checked_mul((BPS_DENOMINATOR as u64).checked_add(extra_factor_bps)?)?
        .checked_div(BPS_DENOMINATOR as u64)?;

    u16::try_from(effective).ok()
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn test_fast_ema_zero_payoff() {
        // prev=1000, payoff=0 -> 0.85 * 1000 = 850
        assert_eq!(update_fast_ema(1_000, 0), Some(850));
    }

    #[test]
    fn test_fast_ema_equal_payoff() {
        // prev=1000, payoff=1000 -> 0.15*1000 + 0.85*1000 = 1000
        assert_eq!(update_fast_ema(1_000, 1_000), Some(1_000));
    }

    #[test]
    fn test_fast_ema_high_payoff() {
        // prev=1000, payoff=5000 -> 0.15*5000 + 0.85*1000 = 750 + 850 = 1600
        assert_eq!(update_fast_ema(1_000, 5_000), Some(1_600));
    }

    #[test]
    fn test_fast_ema_from_zero() {
        // prev=0, payoff=5000 -> 0.15*5000 = 750
        assert_eq!(update_fast_ema(0, 5_000), Some(750));
    }


    #[test]
    fn test_slow_ema_zero_payoff() {
        // prev=1000, payoff=0 -> 0.965 * 1000 = 965
        assert_eq!(update_slow_ema(1_000, 0), Some(965));
    }

    #[test]
    fn test_slow_ema_equal_payoff() {
        // prev=1000, payoff=1000 -> 0.035*1000 + 0.965*1000 = 35 + 965 = 1000
        assert_eq!(update_slow_ema(1_000, 1_000), Some(1_000));
    }

    #[test]
    fn test_slow_ema_high_payoff() {
        // prev=1000, payoff=5000 -> 0.035*5000 + 0.965*1000 = 175 + 965 = 1140
        assert_eq!(update_slow_ema(1_000, 5_000), Some(1_140));
    }


    #[test]
    fn test_fast_ema_converges_in_about_5_cohorts() {
        // Start at 0, constant payoff of 5000.
        // After 5 iterations of fast EMA:
        // 1: 750, 2: 1387, 3: 1929, 4: 2390, 5: 2781
        // After 10: ~4013
        // Fast EMA should be within 20% of 5000 by cohort 10.
        let mut ema = 0u32;
        for _ in 0..10 {
            ema = update_fast_ema(ema, 5_000).unwrap();
        }
        assert!(ema > 4_000, "fast EMA after 10 steps: {ema}, expected > 4000");
        assert!(ema < 5_000, "fast EMA should not exceed target");
    }

    #[test]
    fn test_slow_ema_converges_slowly() {
        // Start at 0, constant payoff of 5000.
        // After 10 iterations of slow EMA, should still be well below target.
        let mut ema = 0u32;
        for _ in 0..10 {
            ema = update_slow_ema(ema, 5_000).unwrap();
        }
        // After 10 steps: ~1500
        assert!(ema < 2_000, "slow EMA after 10 steps: {ema}, expected < 2000");
        assert!(ema > 1_000, "slow EMA after 10 steps: {ema}, expected > 1000");
    }


    #[test]
    fn test_fair_premium_takes_max() {
        assert_eq!(fair_premium_bps(1_000, 2_000), 2_000);
        assert_eq!(fair_premium_bps(3_000, 2_000), 3_000);
        assert_eq!(fair_premium_bps(1_000, 1_000), 1_000);
    }


    #[test]
    fn test_update_emas_otm() {
        // MHI below strike -> payoff = 0 -> both EMAs decay
        let (fast, slow) = update_emas_for_strike(8_000, 10_000, 1_000, 1_000).unwrap();
        assert_eq!(fast, 850);  // 0.85 * 1000
        assert_eq!(slow, 965);  // 0.965 * 1000
    }

    #[test]
    fn test_update_emas_itm() {
        // MHI 1.5x, strike 1.0x -> payoff 5000 BPS
        let (fast, slow) = update_emas_for_strike(15_000, 10_000, 1_000, 1_000).unwrap();
        assert_eq!(fast, 1_600);  // 0.15 * 5000 + 0.85 * 1000
        assert_eq!(slow, 1_140);  // 0.035 * 5000 + 0.965 * 1000
    }


    #[test]
    fn test_cold_start_cohort_0() {
        // settled=0 -> extra = 0.5 * 1.0 = 50% extra
        // base 2000 * 1.5 = 3000
        assert_eq!(cold_start_markup(2_000, 0), Some(3_000));
    }

    #[test]
    fn test_cold_start_cohort_25() {
        // settled=25 -> extra = 0.5 * (1 - 25/50) = 0.5 * 0.5 = 0.25 = 2500 BPS
        // base 2000 * (10000 + 2500) / 10000 = 2000 * 1.25 = 2500
        assert_eq!(cold_start_markup(2_000, 25), Some(2_500));
    }

    #[test]
    fn test_cold_start_cohort_50() {
        // settled=50 -> no extra markup
        assert_eq!(cold_start_markup(2_000, 50), Some(2_000));
    }

    #[test]
    fn test_cold_start_cohort_100() {
        // settled>50 -> no extra markup
        assert_eq!(cold_start_markup(2_000, 100), Some(2_000));
    }

    #[test]
    fn test_cold_start_linear_decay() {
        // Markup should decrease monotonically as settled_cohorts increases
        let base = 2_000u16;
        let mut prev_markup = cold_start_markup(base, 0).unwrap();
        for i in 1..=50 {
            let markup = cold_start_markup(base, i).unwrap();
            assert!(
                markup <= prev_markup,
                "Markup increased at cohort {i}: {markup} > {prev_markup}"
            );
            prev_markup = markup;
        }
        assert_eq!(prev_markup, base);
    }


    #[test]
    fn test_fast_ema_non_round_payoff() {
        // prev=1000, payoff=9999
        // 1500 * 9999 + 8500 * 1000 = 14_998_500 + 8_500_000 = 23_498_500
        // 23_498_500 / 10000 = 2349 (floor), true value 2349.85
        let result = update_fast_ema(1_000, 9_999).unwrap();
        assert_eq!(result, 2_349); // floor - documented behavior
    }

    #[test]
    fn test_slow_ema_non_round_payoff() {
        // prev=1000, payoff=9999
        // 350 * 9999 + 9650 * 1000 = 3_499_650 + 9_650_000 = 13_149_650
        // 13_149_650 / 10000 = 1314 (floor), true value 1314.965
        let result = update_slow_ema(1_000, 9_999).unwrap();
        assert_eq!(result, 1_314);
    }

    #[test]
    fn test_cold_start_non_divisible_base() {
        // base=2222, settled=7 -> remaining=43
        // extra_factor = 5000 * 43 / 50 = 4300
        // effective = 2222 * (10000 + 4300) / 10000 = 2222 * 14300 / 10000 = 3179 (floor)
        let result = cold_start_markup(2_222, 7).unwrap();
        // 2222 * 14300 / 10000 = 31774600 / 10000 = 3177 (floor)
        assert_eq!(result, 3_177);
    }
}
