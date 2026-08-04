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
    FAST_COMPLEMENT_BPS, MAX_STRIKE_MULTIPLIER_BPS, MIN_TOP_STRIKE_HEADROOM_BPS, NUM_STRIKES,
    SLOW_ALPHA_BPS, SLOW_COMPLEMENT_BPS, STRIKE_ANCHOR_ALPHA_BPS, STRIKE_ANCHOR_COMPLEMENT_BPS,
    STRIKE_ANCHOR_MIN_BPS, STRIKE_MULTIPLIERS_BPS,
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

/// Highest anchor whose full strike ladder still fits under `cap_bps` with
/// `MIN_TOP_STRIKE_HEADROOM_BPS` of payoff room left on the top slot.
///
/// The ladder's top slot is `floor(anchor * MAX_STRIKE_MULTIPLIER_BPS / 10_000)`,
/// and every payoff/collateral path computes `cap_bps - strike_bps`. Without a
/// ceiling, an anchor above `cap / 1.3` produces a top strike above the cap,
/// that subtraction underflows, and `submit_mhi` aborts with `Overflow` for
/// every cohort built on that anchor — which, because the anchor only advances
/// inside `submit_mhi`, is a permanent deadlock rather than a transient error.
///
/// Never returns below `STRIKE_ANCHOR_MIN_BPS`: a pathologically small cap must
/// not collapse the anchor to zero and make `update_slot_frac_emas` divide by 0.
pub fn max_anchor_for_cap(cap_bps: u32) -> u32 {
    let usable = cap_bps.saturating_sub(MIN_TOP_STRIKE_HEADROOM_BPS);
    let raw = (usable as u64)
        .saturating_mul(BPS_DENOMINATOR as u64)
        / (MAX_STRIKE_MULTIPLIER_BPS as u64);
    u32::try_from(raw).unwrap_or(u32::MAX).max(STRIKE_ANCHOR_MIN_BPS)
}

/// Clamp an anchor into the range whose derived ladder is settleable under
/// `cap_bps`. Applied everywhere an anchor is written or consumed, so the
/// keeper and the program agree on the ladder without extra round trips.
pub fn clamp_anchor_for_cap(anchor_bps: u32, cap_bps: u32) -> u32 {
    anchor_bps
        .max(STRIKE_ANCHOR_MIN_BPS)
        .min(max_anchor_for_cap(cap_bps))
}

/// Update the strike anchor from a settlement MHI.
/// - First settlement (count == 0): initialize directly to the MHI (mirrors
///   keeper's `StrikeAnchor.addSettlement` on the first non-null observation).
/// - Subsequent: EMA blend with alpha 0.3.
/// - Always clamped into `[STRIKE_ANCHOR_MIN_BPS, max_anchor_for_cap(cap_bps)]`.
///
/// `settlement_count` is the value BEFORE this update (i.e., 0 means this is
/// the first settlement). `cap_bps` is the cap the resulting anchor's ladder
/// will be priced and settled against.
pub fn update_strike_anchor(
    prev_anchor_bps: u32,
    settlement_mhi_bps: u32,
    settlement_count: u64,
    cap_bps: u32,
) -> Option<u32> {
    if settlement_mhi_bps == 0 {
        return Some(clamp_anchor_for_cap(prev_anchor_bps, cap_bps));
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
    Some(clamp_anchor_for_cap(raw, cap_bps))
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
        assert_eq!(update_strike_anchor(12_500, 9_800, 0, MHI_CAP_BPS_DEFAULT), Some(9_800));
    }

    #[test]
    fn test_update_strike_anchor_blends_after_first() {
        // count > 0: EMA blend with alpha 0.3.
        // anchor was 12_500; settlement comes in at 10_000.
        // new = (3000 * 10_000 + 7000 * 12_500) / 10_000 = (30_000_000 + 87_500_000) / 10_000 = 11_750.
        assert_eq!(update_strike_anchor(12_500, 10_000, 1, MHI_CAP_BPS_DEFAULT), Some(11_750));
    }

    #[test]
    fn test_update_strike_anchor_floors() {
        // settlement way below min: blend stays above floor.
        // anchor=2_500, mhi=1_000: new = (3000*1000 + 7000*2500)/10000 = (3_000_000 + 17_500_000)/10_000 = 2_050. floor 2_000 ok.
        assert_eq!(update_strike_anchor(2_500, 1_000, 1, MHI_CAP_BPS_DEFAULT), Some(2_050));
        // anchor=2_001, mhi=1_000: new = (3_000_000 + 14_007_000)/10_000 = 1_700. clamped to 2_000.
        assert_eq!(update_strike_anchor(2_001, 1_000, 1, MHI_CAP_BPS_DEFAULT), Some(2_000));
    }

    #[test]
    fn test_update_strike_anchor_walk_down_hits_floor() {
        // Repeatedly feeding the lowest possible MHI converges to floor.
        let mut anchor = 12_500u32;
        for _ in 0..30 {
            anchor = update_strike_anchor(anchor, 1_000, 1, MHI_CAP_BPS_DEFAULT).unwrap();
        }
        assert_eq!(anchor, STRIKE_ANCHOR_MIN_BPS);
    }

    #[test]
    fn test_update_strike_anchor_zero_mhi_keeps_prev() {
        // Bad input (mhi=0) must not destroy the anchor.
        assert_eq!(update_strike_anchor(12_500, 0, 5, MHI_CAP_BPS_DEFAULT), Some(12_500));
    }


    #[test]
    fn test_max_strike_multiplier_matches_table() {
        // The anchor ceiling is derived from this constant; if the ladder ever
        // gains a higher slot without it moving, the ceiling stops protecting.
        let table_max = STRIKE_MULTIPLIERS_BPS.iter().copied().max().unwrap();
        assert_eq!(MAX_STRIKE_MULTIPLIER_BPS, table_max);
    }

    #[test]
    fn test_max_anchor_for_cap_default() {
        // (30_000 - 2_000) * 10_000 / 13_000 = 21_538
        assert_eq!(max_anchor_for_cap(MHI_CAP_BPS_DEFAULT), 21_538);
        // Top strike from that anchor: floor(21_538 * 1.3) = 27_999 — under the
        // cap with the full headroom intact.
        let strikes = derive_strikes(max_anchor_for_cap(MHI_CAP_BPS_DEFAULT));
        assert_eq!(strikes[NUM_STRIKES - 1], 27_999);
        assert!(strikes[NUM_STRIKES - 1] + MIN_TOP_STRIKE_HEADROOM_BPS <= MHI_CAP_BPS_DEFAULT);
    }

    #[test]
    fn test_max_anchor_for_cap_never_below_floor() {
        // A cap at or under the headroom must not collapse the anchor to zero —
        // `update_slot_frac_emas` divides by the anchor.
        assert_eq!(max_anchor_for_cap(0), STRIKE_ANCHOR_MIN_BPS);
        assert_eq!(max_anchor_for_cap(MIN_TOP_STRIKE_HEADROOM_BPS), STRIKE_ANCHOR_MIN_BPS);
        assert_eq!(max_anchor_for_cap(1), STRIKE_ANCHOR_MIN_BPS);
    }

    #[test]
    fn test_devnet_deadlock_regression_cohort_5066() {
        // Devnet cohort #5066 was started with anchor 24_499 against cap 30_000.
        // derive_strikes put the top slot at 31_848 — above the cap — so
        // `capped_payoff_bps` returned None and submit_mhi aborted with
        // Overflow (6039) on every retry, forever. Because the anchor only
        // advances inside submit_mhi, every later cohort inherited the same
        // unsettleable ladder.
        let unclamped = derive_strikes(24_499);
        assert_eq!(unclamped[NUM_STRIKES - 1], 31_848);
        assert!(
            capped_payoff_bps(14_519, unclamped[NUM_STRIKES - 1], MHI_CAP_BPS_DEFAULT).is_none(),
            "precondition: the old ladder really did underflow"
        );

        // With the ceiling applied, the same anchor yields a settleable ladder.
        let clamped = derive_strikes(clamp_anchor_for_cap(24_499, MHI_CAP_BPS_DEFAULT));
        for strike in clamped {
            assert!(strike < MHI_CAP_BPS_DEFAULT, "strike {strike} >= cap");
            assert!(capped_payoff_bps(14_519, strike, MHI_CAP_BPS_DEFAULT).is_some());
        }
    }

    #[test]
    fn test_every_ladder_under_ceiling_is_settleable() {
        // Sweep anchors far past the cap and caps across the plausible range.
        // No (anchor, cap) pair may produce a strike that underflows `cap - strike`.
        for cap in [5_000u32, 10_000, 20_000, 25_000, 30_000, 40_000, 100_000] {
            for anchor in (0..=60_000u32).step_by(137) {
                let effective = clamp_anchor_for_cap(anchor, cap);
                assert!(effective >= STRIKE_ANCHOR_MIN_BPS);
                for strike in derive_strikes(effective) {
                    // STRIKE_ANCHOR_MIN_BPS is a hard floor on derived strikes,
                    // so a cap below it cannot leave room by construction.
                    if cap <= STRIKE_ANCHOR_MIN_BPS {
                        continue;
                    }
                    assert!(
                        strike < cap,
                        "anchor={anchor} cap={cap} produced strike {strike} >= cap"
                    );
                    assert!(capped_payoff_bps(cap, strike, cap).is_some());
                }
            }
        }
    }

    #[test]
    fn test_anchor_never_climbs_past_ceiling_under_repeated_high_mhi() {
        // Feed the cap itself as the settlement MHI every round. Before the
        // ceiling this walked the anchor up to ~cap and bricked settlement.
        let ceiling = max_anchor_for_cap(MHI_CAP_BPS_DEFAULT);
        let mut anchor = STRIKE_ANCHOR_DEFAULT_BPS;
        for i in 0..200u64 {
            anchor =
                update_strike_anchor(anchor, MHI_CAP_BPS_DEFAULT, i + 1, MHI_CAP_BPS_DEFAULT).unwrap();
            assert!(anchor <= ceiling, "anchor {anchor} passed ceiling {ceiling}");
        }
        assert_eq!(anchor, ceiling);
    }

    #[test]
    fn test_anchor_clamped_when_cap_is_lowered_underneath_it() {
        // `update_config { mhi_cap_bps }` can drop the cap below the standing
        // anchor's ladder. The next anchor write must fall in line rather than
        // leaving a ladder that no longer fits.
        let high = update_strike_anchor(21_538, 21_538, 5, MHI_CAP_BPS_DEFAULT).unwrap();
        assert_eq!(high, 21_538);
        let after_lower_cap = update_strike_anchor(high, 21_538, 6, 15_000).unwrap();
        assert_eq!(after_lower_cap, max_anchor_for_cap(15_000));
        for strike in derive_strikes(after_lower_cap) {
            assert!(strike < 15_000);
        }
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

#[cfg(test)]
mod devnet_recovery {
    use super::*;
    use crate::constants::MHI_CAP_BPS_DEFAULT;

    /// Pins the exact ladder devnet will produce on the first `start_cohort`
    /// after the ceiling ships, while `strike_anchor_bps` is still the stale
    /// 24_216 written before the fix. The keeper must derive byte-identical
    /// values or `start_cohort` reverts with `StrikesDoNotMatchAnchor`.
    #[test]
    fn devnet_stale_anchor_produces_settleable_ladder() {
        let effective = clamp_anchor_for_cap(24_216, MHI_CAP_BPS_DEFAULT);
        assert_eq!(effective, 21_538);
        let strikes = derive_strikes(effective);
        assert_eq!(
            strikes,
            [19_384, 20_461, 21_538, 22_614, 23_691, 25_845, 27_999]
        );
        for s in strikes {
            assert!(s < MHI_CAP_BPS_DEFAULT);
        }
    }

    /// The three stranded cohorts (5066/5067/5068) carry ladders whose top
    /// slots sit above the cap. `submit_mhi` must skip those slots instead of
    /// aborting, so the cohorts resolve on the next keeper pass without a void.
    #[test]
    fn stranded_cohort_ladders_settle_slot_by_slot() {
        let stranded: [(u64, [u32; NUM_STRIKES]); 3] = [
            (5066, [22_049, 23_274, 24_499, 25_723, 26_948, 29_398, 31_848]),
            (5067, [23_456, 24_759, 26_063, 27_366, 28_669, 31_275, 33_881]),
            (5068, [21_794, 23_005, 24_216, 25_426, 26_637, 29_059, 31_480]),
        ];
        let cap = MHI_CAP_BPS_DEFAULT;
        let mhi = 14_519; // the value the keeper kept resubmitting

        for (index, strikes) in stranded {
            let mut skipped = 0;
            for strike in strikes {
                if strike >= cap {
                    // The slot submit_mhi now skips. Confirm it is exactly the
                    // one that used to abort the whole instruction.
                    assert!(capped_payoff_bps(mhi, strike, cap).is_none());
                    skipped += 1;
                    continue;
                }
                assert!(
                    capped_payoff_bps(mhi, strike, cap).is_some(),
                    "cohort {index} strike {strike} still underflows"
                );
            }
            assert!(skipped > 0, "cohort {index} was expected to have a bad slot");
        }
    }
}
