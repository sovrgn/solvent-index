//! Premium computation, fee splits, and demand-based markup adjustment.
//!
//! Rounding conventions:
//! - `charged_premium_lamports`: rounds UP - buyer pays at least fair price
//! - `volume_fee_lamports`: rounds DOWN - fee floor, protocol keeps remainder
//! - `referral_split`: referrer gets floor, protocol keeps remainder
//!

use crate::constants::{
    BPS_DENOMINATOR, BONDING_MAX_SURGE_BPS, MARKUP_MAX_BPS, MARKUP_MIN_BPS,
    MARKUP_STEP_BPS, NUM_STRIKES,
    STRIKE_DEMAND_MAX_BPS, STRIKE_DEMAND_MIN_BPS, STRIKE_DEMAND_STEP_BPS,
    STRIKE_SHARE_HIGH_BPS, STRIKE_SHARE_LOW_BPS, UTILIZATION_HIGH_BPS, UTILIZATION_LOW_BPS,
};
use crate::math::bps::{clamp_u16, isqrt, mul_bps_ceil, mul_bps_u16};

/// Charged premium in BPS: `fair * (1 + markup)`.
/// `= fair * (BPS_DENOM + markup) / BPS_DENOM`.
/// Rounds DOWN in BPS (rounding up happens when converting to lamports).
pub fn charged_premium_bps(fair_bps: u32, markup_bps: u16) -> Option<u32> {
    let factor = (BPS_DENOMINATOR as u64).checked_add(markup_bps as u64)?;
    let result = (fair_bps as u64)
        .checked_mul(factor)?
        .checked_div(BPS_DENOMINATOR as u64)?;
    u32::try_from(result).ok()
}

/// Premium in lamports for a given charged BPS rate and size.
/// Rounds UP - buyer always pays at least the computed premium.
pub fn premium_lamports(charged_bps: u32, size_lamports: u64) -> Option<u64> {
    mul_bps_ceil(size_lamports, charged_bps)
}

/// Volume fee in lamports: `premium * fee_bps / BPS_DENOM`.
/// Rounds DOWN - fee is a floor.
pub fn volume_fee_lamports(premium: u64, fee_bps: u16) -> Option<u64> {
    mul_bps_u16(premium, fee_bps)
}

/// Split volume fee between referrer and protocol.
/// Returns (referrer_amount, protocol_amount).
/// Referrer gets floor, protocol keeps remainder.
/// Guarantees: referrer + protocol == volume_fee (no lamports lost).
pub fn referral_split(volume_fee: u64, referral_share_bps: u16) -> Option<(u64, u64)> {
    let referrer_amount = mul_bps_u16(volume_fee, referral_share_bps)?;
    let protocol_amount = volume_fee.checked_sub(referrer_amount)?;
    Some((referrer_amount, protocol_amount))
}

/// Demand-based markup adjustment after a trading window.
/// - utilization > 90%: markup += 2%
/// - utilization < 30%: markup -= 2%
/// - otherwise: no change
/// Clamped to [MARKUP_MIN_BPS, MARKUP_MAX_BPS].
pub fn adjust_markup(current_bps: u16, utilization_bps: u16) -> u16 {
    let adjusted = if utilization_bps > UTILIZATION_HIGH_BPS {
        current_bps.saturating_add(MARKUP_STEP_BPS)
    } else if utilization_bps < UTILIZATION_LOW_BPS {
        current_bps.saturating_sub(MARKUP_STEP_BPS)
    } else {
        current_bps
    };
    clamp_u16(adjusted, MARKUP_MIN_BPS, MARKUP_MAX_BPS)
}

/// Total amount the buyer must pay: premium (including volume fee).
/// The premium is the full amount - volume fee is extracted from it, not added on top.
/// So this just returns the premium as-is (for clarity in instruction code).
pub fn buyer_cost_lamports(premium: u64) -> u64 {
    premium
}

/// Compute the amount the vault receives from a purchase.
/// vault_receives = premium - referral_payout
pub fn vault_receives(premium: u64, referral_payout: u64) -> Option<u64> {
    premium.checked_sub(referral_payout)
}

/// Compute utilization in BPS: `(bought * BPS_DENOM) / available`.
/// Returns 0 if available is 0 (no capacity = no utilization signal).
pub fn utilization_bps(bought_lamports: u64, available_lamports: u64) -> Option<u16> {
    if available_lamports == 0 {
        return Some(0);
    }
    let result = (bought_lamports as u128)
        .checked_mul(BPS_DENOMINATOR as u128)?
        .checked_div(available_lamports as u128)?;
    // Clamp to u16 range (max 10_000 = 100%)
    let clamped = result.min(BPS_DENOMINATOR as u128);
    Some(clamped as u16)
}


/// What fraction of total cohort volume went to this strike? Returns BPS.
pub fn strike_share_bps(strike_vol: u64, total_vol: u64) -> u16 {
    if total_vol == 0 {
        return 0;
    }
    let share = (strike_vol as u128)
        .saturating_mul(BPS_DENOMINATOR as u128)
        / (total_vol as u128);
    (share.min(BPS_DENOMINATOR as u128)) as u16
}

/// Per-strike demand markup adjustment (between cohorts).
/// If this strike captured >50% of volume → markup up.
/// If this strike captured <10% of volume → markup down.
/// Clamped to [0%, 30%].
pub fn adjust_strike_demand_markup(current_bps: u16, share_bps: u16) -> u16 {
    let adjusted = if share_bps > STRIKE_SHARE_HIGH_BPS {
        current_bps.saturating_add(STRIKE_DEMAND_STEP_BPS)
    } else if share_bps < STRIKE_SHARE_LOW_BPS {
        current_bps.saturating_sub(STRIKE_DEMAND_STEP_BPS)
    } else {
        current_bps
    };
    clamp_u16(adjusted, STRIKE_DEMAND_MIN_BPS, STRIKE_DEMAND_MAX_BPS)
}

/// Intra-cohort bonding curve surge (sqrt curve, midpoint pricing) with
/// cross-strike spillover.
///
/// Uses the midpoint of [existing_vol, existing_vol + position_size] to
/// compute the surge. This means a whale taking large capacity pays the
/// average surge across their entire position, not just the entry price.
///
/// Adjacent strike volumes spill over at 50%, preventing traders from
/// routing to neighboring low-volume strikes to avoid surge pricing.
///
/// `effective_vol = strike_vol + left_neighbor_vol/2 + right_neighbor_vol/2`
/// `surge = max_surge * sqrt((effective_vol + size/2) * NUM_STRIKES / cohort_capacity)`
///
/// A small first buyer (size << capacity) pays near-zero surge.
/// A whale taking 50% of capacity as first buyer pays surge at the 25% mark.
pub fn bonding_surge_bps(
    strike_vol: u64,
    position_size: u64,
    cohort_capacity: u64,
    left_neighbor_vol: u64,
    right_neighbor_vol: u64,
) -> u16 {
    if cohort_capacity == 0 || BONDING_MAX_SURGE_BPS == 0 {
        return 0;
    }
    // Cross-strike spillover: adjacent strikes contribute 50% of their volume
    let effective_vol = strike_vol
        .saturating_add(left_neighbor_vol / 2)
        .saturating_add(right_neighbor_vol / 2);
    // Midpoint: effective_vol + size/2
    let midpoint = effective_vol.saturating_add(position_size / 2);
    // normalized = midpoint * NUM_STRIKES * BPS_DENOMINATOR / cohort_capacity
    let scaled = (midpoint as u128)
        .saturating_mul(NUM_STRIKES as u128)
        .saturating_mul(BPS_DENOMINATOR as u128)
        / (cohort_capacity as u128);
    // Cap at BPS_DENOMINATOR (100%) before sqrt
    let capped = scaled.min(BPS_DENOMINATOR as u128) as u64;
    // sqrt(capped) where capped is in [0, 10000]
    // sqrt(10000) = 100, so surge = max_surge * sqrt(capped) / 100
    let root = isqrt(capped);
    let surge = (BONDING_MAX_SURGE_BPS as u64) * root / 100;
    surge.min(BONDING_MAX_SURGE_BPS as u64) as u16
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn test_charged_premium_20_percent_markup() {
        // fair=1000, markup=2000 (20%) -> 1000 * 12000 / 10000 = 1200
        assert_eq!(charged_premium_bps(1_000, 2_000), Some(1_200));
    }

    #[test]
    fn test_charged_premium_zero_markup() {
        assert_eq!(charged_premium_bps(1_000, 0), Some(1_000));
    }

    #[test]
    fn test_charged_premium_max_markup() {
        // fair=1000, markup=5000 (50%) -> 1500
        assert_eq!(charged_premium_bps(1_000, 5_000), Some(1_500));
    }

    #[test]
    fn test_charged_premium_zero_fair() {
        assert_eq!(charged_premium_bps(0, 2_000), Some(0));
    }


    #[test]
    fn test_premium_lamports_basic() {
        // 1200 BPS on 1 SOL = 0.12 SOL = 120_000_000 lamports
        assert_eq!(premium_lamports(1_200, 1_000_000_000), Some(120_000_000));
    }

    #[test]
    fn test_premium_lamports_rounds_up() {
        // 1 BPS on 9999 lamports: 9999/10000 = 0.9999 -> ceil = 1
        assert_eq!(premium_lamports(1, 9_999), Some(1));
    }

    #[test]
    fn test_premium_lamports_exact() {
        // 5000 BPS on 2 SOL = 1 SOL (exact)
        assert_eq!(premium_lamports(5_000, 2_000_000_000), Some(1_000_000_000));
    }


    #[test]
    fn test_volume_fee_1_5_percent() {
        // 150 BPS on 1 SOL = 0.015 SOL
        assert_eq!(volume_fee_lamports(1_000_000_000, 150), Some(15_000_000));
    }

    #[test]
    fn test_volume_fee_rounds_down() {
        // 150 BPS on 99 lamports = 99 * 150 / 10000 = 1.485 -> floor = 1
        assert_eq!(volume_fee_lamports(99, 150), Some(1));
    }

    #[test]
    fn test_volume_fee_zero() {
        assert_eq!(volume_fee_lamports(0, 150), Some(0));
    }


    #[test]
    fn test_referral_split_30_percent() {
        // volume_fee=1000, share=3000 (30%) -> ref=300, protocol=700
        assert_eq!(referral_split(1_000, 3_000), Some((300, 700)));
    }

    #[test]
    fn test_referral_split_sums_to_total() {
        let test_cases = [
            (1_000u64, 3_000u16),
            (999, 3_000),
            (15_000_000, 3_000),
            (1, 3_000),
            (7, 5_000),
        ];
        for (fee, share) in test_cases {
            let (r, p) = referral_split(fee, share).unwrap();
            assert_eq!(
                r + p, fee,
                "referral {r} + protocol {p} != fee {fee} (share={share})"
            );
        }
    }

    #[test]
    fn test_referral_split_zero_fee() {
        assert_eq!(referral_split(0, 3_000), Some((0, 0)));
    }

    #[test]
    fn test_referral_split_zero_share() {
        assert_eq!(referral_split(1_000, 0), Some((0, 1_000)));
    }


    #[test]
    fn test_adjust_markup_high_utilization() {
        // 95% > 90% -> +2%
        assert_eq!(adjust_markup(2_000, 9_500), 2_200);
    }

    #[test]
    fn test_adjust_markup_low_utilization() {
        // 20% < 30% -> -2%
        assert_eq!(adjust_markup(2_000, 2_000), 1_800);
    }

    #[test]
    fn test_adjust_markup_normal_utilization() {
        // 50% is between 30% and 90% -> no change
        assert_eq!(adjust_markup(2_000, 5_000), 2_000);
    }

    #[test]
    fn test_adjust_markup_clamp_max() {
        // At max, high util -> stays at max
        assert_eq!(adjust_markup(5_000, 9_500), 5_000);
    }

    #[test]
    fn test_adjust_markup_clamp_min() {
        // At min, low util -> stays at min
        assert_eq!(adjust_markup(500, 1_000), 500);
    }

    #[test]
    fn test_adjust_markup_boundary_90() {
        // Exactly 90% -> no change (must exceed, not equal)
        assert_eq!(adjust_markup(2_000, 9_000), 2_000);
    }

    #[test]
    fn test_adjust_markup_boundary_30() {
        // Exactly 30% -> no change (must be below, not equal)
        assert_eq!(adjust_markup(2_000, 3_000), 2_000);
    }


    #[test]
    fn test_utilization_basic() {
        // 500 of 1000 = 50% = 5000 BPS
        assert_eq!(utilization_bps(500, 1_000), Some(5_000));
    }

    #[test]
    fn test_utilization_zero_available() {
        assert_eq!(utilization_bps(100, 0), Some(0));
    }

    #[test]
    fn test_utilization_100_percent() {
        assert_eq!(utilization_bps(1_000, 1_000), Some(10_000));
    }

    #[test]
    fn test_utilization_over_100_clamped() {
        // More bought than available (shouldn't happen but safe)
        assert_eq!(utilization_bps(2_000, 1_000), Some(10_000));
    }


    #[test]
    fn test_vault_receives_with_referral() {
        assert_eq!(vault_receives(1_000, 300), Some(700));
    }

    #[test]
    fn test_vault_receives_no_referral() {
        assert_eq!(vault_receives(1_000, 0), Some(1_000));
    }

    #[test]
    fn test_vault_receives_underflow() {
        assert_eq!(vault_receives(100, 200), None);
    }


    #[test]
    fn test_charged_premium_non_round_fair() {
        // fair=7777, markup=1000 (10%)
        // 7777 * 11000 / 10000 = 85_547_000 / 10000 = 8554 (floor)
        // True value: 8554.7
        assert_eq!(charged_premium_bps(7_777, 1_000), Some(8_554));
    }

    #[test]
    fn test_charged_premium_1_bps_fair() {
        // fair=1, markup=2000 (20%)
        // 1 * 12000 / 10000 = 1 (floor)
        assert_eq!(charged_premium_bps(1, 2_000), Some(1));
    }

    #[test]
    fn test_premium_lamports_tiny_size() {
        // 1 BPS on 1 lamport: ceil(1/10000) = 1
        assert_eq!(premium_lamports(1, 1), Some(1));
    }

    #[test]
    fn test_volume_fee_tiny_premium() {
        // 150 BPS on 1 lamport = floor(150/10000) = 0
        assert_eq!(volume_fee_lamports(1, 150), Some(0));
    }

    #[test]
    fn test_referral_split_1_lamport_fee() {
        // 1 lamport fee, 30% share: floor(0.3) = 0
        let (r, p) = referral_split(1, 3_000).unwrap();
        assert_eq!(r, 0);
        assert_eq!(p, 1);
        assert_eq!(r + p, 1);
    }
}
