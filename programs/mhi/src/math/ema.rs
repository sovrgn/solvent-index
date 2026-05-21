//! Dual-speed fractional EMA pricing engine.
//!
//! Fast EMA: alpha = 0.15, responds to regime shifts in ~5 cohorts.
//! Slow EMA: alpha = 0.035, prevents overreaction to noise.
//! Fair fractional payoff = max(fast_frac, slow_frac).
//!
//! The EMAs track `payoff_bps / anchor_bps × BPS_DENOMINATOR` (a "fraction")
//! rather than absolute `payoff_bps` so that historical observations remain
//! valid as the per-cohort strike ladder rescales with the anchor.
//!
//! Strike anchor: itself an EMA of clamped settlement MHI. Per-cohort strikes
//! are then `floor(anchor * multiplier / BPS_DENOMINATOR)` for each slot.
//!
//! All values in BPS. No floating point. Zero Anchor dependencies.

use crate::constants::{
    BPS_DENOMINATOR, COLD_START_COHORTS, COLD_START_EXTRA_BPS, FAST_ALPHA_BPS,
    FAST_COMPLEMENT_BPS, NUM_STRIKES, SLOW_ALPHA_BPS, SLOW_COMPLEMENT_BPS,
    STRIKE_ANCHOR_ALPHA_BPS, STRIKE_ANCHOR_COMPLEMENT_BPS, STRIKE_ANCHOR_MIN_BPS,
    STRIKE_MULTIPLIERS_BPS,
};
use crate::math::payoff::capped_payoff_bps;

/// Update the fast EMA: `new = (alpha * x + (1-alpha) * prev) / BPS_DENOM`.
/// Unit-agnostic — works for absolute BPS or fractions (BPS-of-anchor).
pub fn update_fast_ema(prev: u32, x: u32) -> Option<u32> {
    let alpha_term = (FAST_ALPHA_BPS as u64).checked_mul(x as u64)?;
    let complement_term = (FAST_COMPLEMENT_BPS as u64).checked_mul(prev as u64)?;
    let sum = alpha_term.checked_add(complement_term)?;
    let result = sum.checked_div(BPS_DENOMINATOR as u64)?;
    u32::try_from(result).ok()
}

/// Update the slow EMA: `new = (alpha * x + (1-alpha) * prev) / BPS_DENOM`.
pub fn update_slow_ema(prev: u32, x: u32) -> Option<u32> {
    let alpha_term = (SLOW_ALPHA_BPS as u64).checked_mul(x as u64)?;
    let complement_term = (SLOW_COMPLEMENT_BPS as u64).checked_mul(prev as u64)?;
    let sum = alpha_term.checked_add(complement_term)?;
    let result = sum.checked_div(BPS_DENOMINATOR as u64)?;
    u32::try_from(result).ok()
}

/// Take the max of fast and slow fractional EMAs and rescale into absolute
/// payoff BPS using the current anchor: `max(fast, slow) * anchor / BPS_DENOM`.
/// Floor. Mirrors keeper's `DualEMAPricer.fairPayoffBps`.
pub fn fair_payoff_bps(fast_frac_bps: u32, slow_frac_bps: u32, current_anchor_bps: u32) -> Option<u32> {
    let max_frac = fast_frac_bps.max(slow_frac_bps) as u64;
    let result = max_frac
        .checked_mul(current_anchor_bps as u64)?
        .checked_div(BPS_DENOMINATOR as u64)?;
    u32::try_from(result).ok()
}

/// Update one slot's fractional EMAs after a cohort settles.
/// - `mhi_bps`: the cohort's (already-clamped) settlement MHI
/// - `strike_bps`: this slot's strike for the just-settled cohort
/// - `anchor_at_settle_bps`: the cohort's `strike_anchor_bps_at_start`
///   (snapshot taken when the cohort was opened — NOT the current global
///   anchor, because later cohorts may already have moved it)
/// - `cap_bps`: protocol MHI cap from `GlobalState`
/// - `prev_fast_frac`, `prev_slow_frac`: existing slot EMAs
///
/// Returns `(new_fast_frac, new_slow_frac)`.
pub fn update_slot_frac_emas(
    mhi_bps: u32,
    strike_bps: u32,
    anchor_at_settle_bps: u32,
    cap_bps: u32,
    prev_fast_frac: u32,
    prev_slow_frac: u32,
) -> Option<(u32, u32)> {
    if anchor_at_settle_bps == 0 {
        return None;
    }
    let payoff = capped_payoff_bps(mhi_bps, strike_bps, cap_bps)?;
    // payoff_frac = floor(payoff * BPS_DENOM / anchor_at_settle)
    let payoff_frac = (payoff as u64)
        .checked_mul(BPS_DENOMINATOR as u64)?
        .checked_div(anchor_at_settle_bps as u64)?;
    let payoff_frac_u32 = u32::try_from(payoff_frac).ok()?;
    let new_fast = update_fast_ema(prev_fast_frac, payoff_frac_u32)?;
    let new_slow = update_slow_ema(prev_slow_frac, payoff_frac_u32)?;
    Some((new_fast, new_slow))
}

/// Update the strike anchor from a settlement MHI.
/// - First settlement (count == 0): initialize directly to the MHI (mirrors
///   keeper's `StrikeAnchor.addSettlement` on the first non-null observation).
/// - Subsequent: EMA blend with alpha 0.3.
/// - Always clamped to >= STRIKE_ANCHOR_MIN_BPS.
///
/// `settlement_count` is the value BEFORE this update (i.e., 0 means this is
/// the first settlement).
pub fn update_strike_anchor(
    prev_anchor_bps: u32,
    settlement_mhi_bps: u32,
    settlement_count: u64,
) -> Option<u32> {
    if settlement_mhi_bps == 0 {
        return Some(prev_anchor_bps.max(STRIKE_ANCHOR_MIN_BPS));
    }
    let raw = if settlement_count == 0 {
        // No prior to blend with — initialize directly.
        settlement_mhi_bps
    } else {
        let alpha_term = (STRIKE_ANCHOR_ALPHA_BPS as u64).checked_mul(settlement_mhi_bps as u64)?;
        let complement_term = (STRIKE_ANCHOR_COMPLEMENT_BPS as u64).checked_mul(prev_anchor_bps as u64)?;
        let sum = alpha_term.checked_add(complement_term)?;
        let blended = sum.checked_div(BPS_DENOMINATOR as u64)?;
        u32::try_from(blended).ok()?
    };
    Some(raw.max(STRIKE_ANCHOR_MIN_BPS))
}

/// Derive per-cohort strikes from an anchor: `floor(anchor * mult[i] / 10_000)`
/// clamped to >= STRIKE_ANCHOR_MIN_BPS. Mirrors keeper's `getAbsoluteStrikes`.
///
/// Both sides must use identical integer floor; `start_cohort` rejects
/// keeper-supplied strikes that don't match this output exactly.
pub fn derive_strikes(anchor_bps: u32) -> [u32; NUM_STRIKES] {
    let mut out = [0u32; NUM_STRIKES];
    let anchor = anchor_bps as u64;
    for i in 0..NUM_STRIKES {
        let raw = anchor
            .saturating_mul(STRIKE_MULTIPLIERS_BPS[i] as u64)
            / (BPS_DENOMINATOR as u64);
        let floored = u32::try_from(raw).unwrap_or(u32::MAX);
        out[i] = floored.max(STRIKE_ANCHOR_MIN_BPS);
    }
    out
}

/// Cold start markup multiplier.
/// `effective_markup = base * (1 + 0.5 * max(0, 1 - settled / 50))`
///
/// In BPS:
/// `extra_factor = COLD_START_EXTRA_BPS * max(0, COLD_START_COHORTS - settled) / COLD_START_COHORTS`
/// `effective = base * (BPS_DENOMINATOR + extra_factor) / BPS_DENOMINATOR`
pub fn cold_start_markup(base_markup_bps: u16, settled_cohorts: u64) -> Option<u16> {
    if settled_cohorts >= COLD_START_COHORTS {
        return Some(base_markup_bps);
    }

    let remaining = COLD_START_COHORTS.checked_sub(settled_cohorts)?;
    let extra_factor_bps = (COLD_START_EXTRA_BPS as u64)
        .checked_mul(remaining)?
        .checked_div(COLD_START_COHORTS)?;
    let effective = (base_markup_bps as u64)
        .checked_mul((BPS_DENOMINATOR as u64).checked_add(extra_factor_bps)?)?
        .checked_div(BPS_DENOMINATOR as u64)?;
    u16::try_from(effective).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MHI_CAP_BPS_DEFAULT, STRIKE_ANCHOR_DEFAULT_BPS};


    #[test]
    fn test_fast_ema_zero_payoff() {
        assert_eq!(update_fast_ema(1_000, 0), Some(850));
    }

    #[test]
    fn test_fast_ema_equal_payoff() {
        assert_eq!(update_fast_ema(1_000, 1_000), Some(1_000));
    }

    #[test]
    fn test_fast_ema_high_payoff() {
        assert_eq!(update_fast_ema(1_000, 5_000), Some(1_600));
    }

    #[test]
    fn test_fast_ema_from_zero() {
        assert_eq!(update_fast_ema(0, 5_000), Some(750));
    }


    #[test]
    fn test_slow_ema_zero_payoff() {
        assert_eq!(update_slow_ema(1_000, 0), Some(965));
    }

    #[test]
    fn test_slow_ema_equal_payoff() {
        assert_eq!(update_slow_ema(1_000, 1_000), Some(1_000));
    }

    #[test]
    fn test_slow_ema_high_payoff() {
        assert_eq!(update_slow_ema(1_000, 5_000), Some(1_140));
    }


    #[test]
    fn test_fast_ema_converges_in_about_10_cohorts() {
        let mut ema = 0u32;
        for _ in 0..10 {
            ema = update_fast_ema(ema, 5_000).unwrap();
        }
        assert!(ema > 4_000);
        assert!(ema < 5_000);
    }

    #[test]
    fn test_slow_ema_converges_slowly() {
        let mut ema = 0u32;
        for _ in 0..10 {
            ema = update_slow_ema(ema, 5_000).unwrap();
        }
        assert!(ema < 2_000);
        assert!(ema > 1_000);
    }


    #[test]
    fn test_fair_payoff_takes_max_and_scales() {
        // max(1000, 2000) = 2000. 2000 * 12_500 / 10_000 = 2500.
        assert_eq!(fair_payoff_bps(1_000, 2_000, 12_500), Some(2_500));
        // max(3000, 2000) = 3000. 3000 * 10_000 / 10_000 = 3000.
        assert_eq!(fair_payoff_bps(3_000, 2_000, 10_000), Some(3_000));
    }

    #[test]
    fn test_fair_payoff_zero_anchor_yields_zero() {
        assert_eq!(fair_payoff_bps(5_000, 5_000, 0), Some(0));
    }


    #[test]
    fn test_update_slot_frac_emas_otm() {
        // mhi < strike → payoff = 0 → fraction = 0 → both decay
        let (fast, slow) =
            update_slot_frac_emas(8_000, 10_000, 10_000, MHI_CAP_BPS_DEFAULT, 1_000, 1_000).unwrap();
        assert_eq!(fast, 850);
        assert_eq!(slow, 965);
    }

    #[test]
    fn test_update_slot_frac_emas_itm_anchor_one_x() {
        // mhi 1.5x, strike 1.0x, anchor 1.0x → payoff 5000 → frac 5000
        let (fast, slow) =
            update_slot_frac_emas(15_000, 10_000, 10_000, MHI_CAP_BPS_DEFAULT, 1_000, 1_000).unwrap();
        assert_eq!(fast, 1_600);
        assert_eq!(slow, 1_140);
    }

    #[test]
    fn test_update_slot_frac_emas_anchor_rescales() {
        // Same MHI-vs-strike but a larger anchor → fraction is smaller.
        // payoff = 5_000. anchor = 20_000. frac = floor(5000 * 10_000 / 20_000) = 2500.
        // (fast: 0.15*2500 + 0.85*1000 = 375 + 850 = 1225)
        let (fast, _slow) =
            update_slot_frac_emas(15_000, 10_000, 20_000, MHI_CAP_BPS_DEFAULT, 1_000, 1_000).unwrap();
        assert_eq!(fast, 1_225);
    }

    #[test]
    fn test_update_slot_frac_emas_capped_payoff() {
        // mhi 3.5x clamped at cap 3.0x with strike 1.0x: payoff = capped at 2.0x = 20_000.
        // anchor 10_000 → frac = 20_000.
        let (fast, _slow) =
            update_slot_frac_emas(35_000, 10_000, 10_000, MHI_CAP_BPS_DEFAULT, 0, 0).unwrap();
        // 0.15 * 20_000 + 0.85 * 0 = 3_000
        assert_eq!(fast, 3_000);
    }


    #[test]
    fn test_update_strike_anchor_first_settlement_initializes() {
        // count=0: directly initialize to the MHI (clamped to MIN floor).
        assert_eq!(update_strike_anchor(12_500, 9_800, 0), Some(9_800));
    }

    #[test]
    fn test_update_strike_anchor_blends_after_first() {
        // count > 0: EMA blend with alpha 0.3.
        // anchor was 12_500; settlement comes in at 10_000.
        // new = (3000 * 10_000 + 7000 * 12_500) / 10_000 = (30_000_000 + 87_500_000) / 10_000 = 11_750.
        assert_eq!(update_strike_anchor(12_500, 10_000, 1), Some(11_750));
    }

    #[test]
    fn test_update_strike_anchor_floors() {
        // settlement way below min: blend stays above floor.
        // anchor=2_500, mhi=1_000: new = (3000*1000 + 7000*2500)/10000 = (3_000_000 + 17_500_000)/10_000 = 2_050. floor 2_000 ok.
        assert_eq!(update_strike_anchor(2_500, 1_000, 1), Some(2_050));
        // anchor=2_001, mhi=1_000: new = (3_000_000 + 14_007_000)/10_000 = 1_700. clamped to 2_000.
        assert_eq!(update_strike_anchor(2_001, 1_000, 1), Some(2_000));
    }

    #[test]
    fn test_update_strike_anchor_walk_down_hits_floor() {
        // Repeatedly feeding the lowest possible MHI converges to floor.
        let mut anchor = 12_500u32;
        for _ in 0..30 {
            anchor = update_strike_anchor(anchor, 1_000, 1).unwrap();
        }
        assert_eq!(anchor, STRIKE_ANCHOR_MIN_BPS);
    }

    #[test]
    fn test_update_strike_anchor_zero_mhi_keeps_prev() {
        // Bad input (mhi=0) must not destroy the anchor.
        assert_eq!(update_strike_anchor(12_500, 0, 5), Some(12_500));
    }


    #[test]
    fn test_derive_strikes_at_default_anchor() {
        // anchor 12_500 → [11_250, 11_875, 12_500, 13_125, 13_750, 15_000, 16_250]
        let strikes = derive_strikes(STRIKE_ANCHOR_DEFAULT_BPS);
        assert_eq!(strikes, [11_250, 11_875, 12_500, 13_125, 13_750, 15_000, 16_250]);
    }

    #[test]
    fn test_derive_strikes_low_anchor_clamps() {
        // anchor at the floor (2_000) → [1_800 → MIN, 1_900 → MIN, 2_000, 2_100, 2_200, 2_400, 2_600]
        let strikes = derive_strikes(STRIKE_ANCHOR_MIN_BPS);
        assert_eq!(strikes[0], STRIKE_ANCHOR_MIN_BPS); // 0.9 * 2000 = 1800 → clamped
        assert_eq!(strikes[1], STRIKE_ANCHOR_MIN_BPS); // 0.95 * 2000 = 1900 → clamped
        assert_eq!(strikes[2], 2_000);
        assert_eq!(strikes[3], 2_100);
        assert_eq!(strikes[6], 2_600);
    }

    #[test]
    fn test_derive_strikes_monotonic_when_above_floor() {
        // For anchors high enough that no slot hits the floor, strikes are monotonic.
        let strikes = derive_strikes(15_000);
        for i in 1..strikes.len() {
            assert!(strikes[i] > strikes[i - 1], "strikes not monotonic at i={i}: {strikes:?}");
        }
    }


    #[test]
    fn test_cold_start_cohort_0() {
        assert_eq!(cold_start_markup(2_000, 0), Some(3_000));
    }

    #[test]
    fn test_cold_start_cohort_25() {
        assert_eq!(cold_start_markup(2_000, 25), Some(2_500));
    }

    #[test]
    fn test_cold_start_cohort_50() {
        assert_eq!(cold_start_markup(2_000, 50), Some(2_000));
    }

    #[test]
    fn test_cold_start_cohort_100() {
        assert_eq!(cold_start_markup(2_000, 100), Some(2_000));
    }

    #[test]
    fn test_cold_start_linear_decay() {
        let base = 2_000u16;
        let mut prev_markup = cold_start_markup(base, 0).unwrap();
        for i in 1..=50 {
            let markup = cold_start_markup(base, i).unwrap();
            assert!(markup <= prev_markup);
            prev_markup = markup;
        }
        assert_eq!(prev_markup, base);
    }
}
