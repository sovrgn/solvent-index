//! Basis point arithmetic with overflow-safe operations.
//!
//! All functions use u128 intermediates to prevent overflow.
//! Rounding convention:
//! - `mul_bps` / `mul_bps_u16`: rounds DOWN (floor) - used for payouts, fee shares
//! - `mul_bps_ceil`: rounds UP (ceiling) - used for premiums charged to buyers
//!

use crate::constants::BPS_DENOMINATOR;

/// Multiply a lamport value by a BPS fraction: `value * bps / 10_000`.
/// Rounds DOWN (floor). Returns None on overflow (should never happen for realistic values).
pub fn mul_bps(value: u64, bps: u32) -> Option<u64> {
    let result = (value as u128)
        .checked_mul(bps as u128)?
        .checked_div(BPS_DENOMINATOR as u128)?;
    u64::try_from(result).ok()
}

/// Multiply a lamport value by a u16 BPS fraction: `value * bps / 10_000`.
/// Rounds DOWN (floor).
pub fn mul_bps_u16(value: u64, bps: u16) -> Option<u64> {
    mul_bps(value, bps as u32)
}

/// Multiply a lamport value by a BPS fraction, rounding UP (ceiling).
/// `ceil(value * bps / 10_000)`.
/// Used for premium calculations so buyers always pay at least the fair price.
pub fn mul_bps_ceil(value: u64, bps: u32) -> Option<u64> {
    let numerator = (value as u128).checked_mul(bps as u128)?;
    let denom = BPS_DENOMINATOR as u128;
    // ceil division: (n + d - 1) / d
    let result = numerator.checked_add(denom - 1)?.checked_div(denom)?;
    u64::try_from(result).ok()
}

/// Multiply two BPS values: `a_bps * b_bps / 10_000`.
/// Used for compound percentages (e.g., markup on top of EMA).
/// Rounds DOWN.
pub fn mul_bps_bps(a_bps: u32, b_bps: u32) -> Option<u32> {
    let result = (a_bps as u64)
        .checked_mul(b_bps as u64)?
        .checked_div(BPS_DENOMINATOR as u64)?;
    u32::try_from(result).ok()
}

/// Compute `value * numerator_bps / denominator_bps`.
/// Rounds DOWN. Returns None on zero denominator or overflow.
pub fn ratio_bps(value: u64, numerator_bps: u32, denominator_bps: u32) -> Option<u64> {
    if denominator_bps == 0 {
        return None;
    }
    let result = (value as u128)
        .checked_mul(numerator_bps as u128)?
        .checked_div(denominator_bps as u128)?;
    u64::try_from(result).ok()
}

/// Checked subtraction for u32 BPS values. Returns None if would underflow.
pub fn sub_bps(a: u32, b: u32) -> Option<u32> {
    a.checked_sub(b)
}

/// Checked addition for u32 BPS values. Returns None if would overflow.
pub fn add_bps(a: u32, b: u32) -> Option<u32> {
    a.checked_add(b)
}

/// Integer square root via Newton's method. Returns floor(sqrt(x)).
pub fn isqrt(x: u64) -> u64 {
    if x < 2 {
        return x;
    }
    let mut guess = x;
    let mut result = (x + 1) / 2;
    while result < guess {
        guess = result;
        result = (guess + x / guess) / 2;
    }
    guess
}

/// Clamp a u16 value to [min, max].
pub fn clamp_u16(value: u16, min: u16, max: u16) -> u16 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

/// Clamp a new value toward a reference value by a maximum delta percentage.
///
/// Returns a value within [ref * (1 - delta_bps/10000), ref * (1 + delta_bps/10000)],
/// clamped to [1, u32::MAX].
///
/// This is the Drift-style circuit breaker: the submitted value is accepted
/// but clamped so it cannot move more than `delta_bps`% from the reference
/// in a single update. Any target value can be reached over multiple updates.
///
/// If reference is 0 (no history), returns value unclamped.
/// If delta_bps is 0, clamp is disabled (returns value unclamped).
pub fn clamp_delta_bps(value: u32, reference: u32, delta_bps: u32) -> u32 {
    if reference == 0 || delta_bps == 0 {
        return value;
    }

    let max_move = (reference as u64)
        .saturating_mul(delta_bps as u64)
        / (BPS_DENOMINATOR as u64);
    let max_move = max_move as u32;

    // Floor at MHI_ABSOLUTE_FLOOR_BPS (currently 0.1x = 1000 BPS) to prevent
    // keeper-driven collapse below a hard absolute minimum.
    let lower = reference.saturating_sub(max_move).max(crate::constants::MHI_ABSOLUTE_FLOOR_BPS);
    let upper = reference.saturating_add(max_move);

    if value < lower {
        lower
    } else if value > upper {
        upper
    } else {
        value
    }
}

/// The MHI a submission actually stores: the keeper's reading held inside the
/// per-cohort delta band, then held under the cohort's payoff cap.
///
/// Both bounds clamp instead of rejecting, on purpose. A submitted MHI is an
/// observation of the market, and the market can print any number; aborting
/// `submit_mhi` on an out-of-range reading hands a hot market the power to stop
/// settlement, during exactly the conditions the cap exists to handle. Nothing
/// downstream needs the rejection: `capped_payoff_bps` truncates payoff at
/// `cap - strike`, so storing `min(value, cap)` settles every position
/// identically to storing the raw value, and the instruction still lands.
///
/// Order matters. The delta band runs first so the circuit breaker keeps
/// measuring movement against the previous cohort's stored MHI. The cap runs
/// last so the stored value can never exceed the cap the cohort's collateral
/// was locked against, which the delta band alone does not guarantee: after an
/// authority lowers `mhi_cap_bps`, the band's lower edge can sit above the new
/// cap.
///
/// A `cap_bps` below `MHI_ABSOLUTE_FLOOR_BPS` is a misconfiguration the floor
/// cannot rescue (a cap under 0.1x leaves no payoff room at any strike); the
/// cap wins there and the value stored is the cap.
pub fn effective_mhi_bps(
    submitted_bps: u32,
    last_mhi_bps: u32,
    max_delta_bps: u32,
    cap_bps: u32,
) -> u32 {
    clamp_delta_bps(submitted_bps, last_mhi_bps, max_delta_bps).min(cap_bps)
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn test_mul_bps_basic() {
        // 1 SOL * 50% = 0.5 SOL
        assert_eq!(mul_bps(1_000_000_000, 5_000), Some(500_000_000));
    }

    #[test]
    fn test_mul_bps_100_percent() {
        assert_eq!(mul_bps(1_000_000_000, 10_000), Some(1_000_000_000));
    }

    #[test]
    fn test_mul_bps_zero_value() {
        assert_eq!(mul_bps(0, 5_000), Some(0));
    }

    #[test]
    fn test_mul_bps_zero_bps() {
        assert_eq!(mul_bps(1_000_000_000, 0), Some(0));
    }

    #[test]
    fn test_mul_bps_1_bps() {
        // 1 SOL * 0.01% = 100_000 lamports
        assert_eq!(mul_bps(1_000_000_000, 1), Some(100_000));
    }

    #[test]
    fn test_mul_bps_rounds_down() {
        // 3 * 3333 / 10000 = 0.9999 -> 0
        assert_eq!(mul_bps(3, 3_333), Some(0));
        // 10_001 * 1 / 10_000 = 1.0001 -> 1
        assert_eq!(mul_bps(10_001, 1), Some(1));
    }

    #[test]
    fn test_mul_bps_large_value() {
        // 1 billion SOL * 250% - u128 intermediate prevents overflow
        let one_billion_sol = 1_000_000_000u64 * 1_000_000_000;
        assert_eq!(mul_bps(one_billion_sol, 25_000), Some(2_500_000_000_000_000_000));
    }

    #[test]
    fn test_mul_bps_u64_max() {
        // u64::MAX * 10_000 / 10_000 = u64::MAX
        assert_eq!(mul_bps(u64::MAX, 10_000), Some(u64::MAX));
    }

    #[test]
    fn test_mul_bps_overflow_returns_none() {
        // u64::MAX * 25_000 / 10_000 = 2.5 * u64::MAX -> overflow u64
        assert_eq!(mul_bps(u64::MAX, 25_000), None);
    }


    #[test]
    fn test_mul_bps_ceil_rounds_up() {
        // 3 * 3333 / 10000 = 0.9999 -> ceil = 1
        assert_eq!(mul_bps_ceil(3, 3_333), Some(1));
    }

    #[test]
    fn test_mul_bps_ceil_exact() {
        // Exact division: no rounding needed
        assert_eq!(mul_bps_ceil(1_000_000_000, 5_000), Some(500_000_000));
    }

    #[test]
    fn test_mul_bps_ceil_zero() {
        assert_eq!(mul_bps_ceil(0, 5_000), Some(0));
    }

    #[test]
    fn test_mul_bps_ceil_always_gte_floor() {
        let test_cases = [
            (100, 3_333u32),
            (7, 1_429),
            (999_999_999, 150),
            (1, 1),
            (1_000_000_000, 10_000),
        ];
        for (value, bps) in test_cases {
            let floor = mul_bps(value, bps).unwrap();
            let ceil = mul_bps_ceil(value, bps).unwrap();
            assert!(ceil >= floor, "ceil({value}, {bps}) = {ceil} < floor = {floor}");
        }
    }


    #[test]
    fn test_mul_bps_bps_basic() {
        // 20% * 50% = 10%
        assert_eq!(mul_bps_bps(2_000, 5_000), Some(1_000));
    }

    #[test]
    fn test_mul_bps_bps_identity() {
        // X * 100% = X
        assert_eq!(mul_bps_bps(1_500, 10_000), Some(1_500));
    }

    #[test]
    fn test_mul_bps_bps_zero() {
        assert_eq!(mul_bps_bps(5_000, 0), Some(0));
    }


    #[test]
    fn test_ratio_bps_basic() {
        // 100 * 3000 / 10000 = 30
        assert_eq!(ratio_bps(100, 3_000, 10_000), Some(30));
    }

    #[test]
    fn test_ratio_bps_zero_denominator() {
        assert_eq!(ratio_bps(100, 3_000, 0), None);
    }


    #[test]
    fn test_sub_bps_basic() {
        assert_eq!(sub_bps(25_000, 10_000), Some(15_000));
    }

    #[test]
    fn test_sub_bps_underflow() {
        assert_eq!(sub_bps(5_000, 10_000), None);
    }

    #[test]
    fn test_add_bps_basic() {
        assert_eq!(add_bps(10_000, 5_000), Some(15_000));
    }

    #[test]
    fn test_add_bps_overflow() {
        assert_eq!(add_bps(u32::MAX, 1), None);
    }


    #[test]
    fn test_clamp_within_range() {
        assert_eq!(clamp_u16(1_000, 500, 5_000), 1_000);
    }

    #[test]
    fn test_clamp_below_min() {
        assert_eq!(clamp_u16(100, 500, 5_000), 500);
    }

    #[test]
    fn test_clamp_above_max() {
        assert_eq!(clamp_u16(10_000, 500, 5_000), 5_000);
    }

    #[test]
    fn test_clamp_at_boundaries() {
        assert_eq!(clamp_u16(500, 500, 5_000), 500);
        assert_eq!(clamp_u16(5_000, 500, 5_000), 5_000);
    }


    #[test]
    fn test_clamp_delta_within_range() {
        // ref=12000, delta=3300 (33%), value=13000 (8.3% up) -> unclamped
        assert_eq!(clamp_delta_bps(13_000, 12_000, 3_300), 13_000);
    }

    #[test]
    fn test_clamp_delta_above_max() {
        // ref=12000, delta=3300 (33%), value=20000 (67% up) -> clamped to 12000+3960=15960
        assert_eq!(clamp_delta_bps(20_000, 12_000, 3_300), 15_960);
    }

    #[test]
    fn test_clamp_delta_below_min() {
        // ref=12000, delta=3300 (33%), value=3000 (75% down) -> clamped to 12000-3960=8040
        assert_eq!(clamp_delta_bps(3_000, 12_000, 3_300), 8_040);
    }

    #[test]
    fn test_clamp_delta_crash_to_near_zero() {
        // ref=12680, delta=3300 (33%), value=1 -> clamped to 12680-4184=8496
        assert_eq!(clamp_delta_bps(1, 12_680, 3_300), 8_496);
    }

    #[test]
    fn test_clamp_delta_walk_down_hits_floor() {
        // Simulate compromised keeper submitting 1 every cohort with 33% clamp.
        // Starting from 12680, MHI walks down but never goes below
        // MHI_ABSOLUTE_FLOOR_BPS (1000 = 0.1x).
        let floor = crate::constants::MHI_ABSOLUTE_FLOOR_BPS;
        let mut mhi = 12_680u32;
        let mut cohorts = 0u32;
        while mhi > floor {
            mhi = clamp_delta_bps(1, mhi, 3_300);
            cohorts += 1;
            assert!(cohorts < 50, "should converge, stuck at {mhi}");
        }
        // Should hit the floor exactly
        assert_eq!(mhi, floor);
        // Should take multiple cohorts to walk from 12680 to floor
        assert!(cohorts >= 3, "only took {cohorts} cohorts, expected >= 3");
        // One more attempt - should stay at floor
        let floored = clamp_delta_bps(1, mhi, 3_300);
        assert_eq!(floored, floor, "MHI must not go below absolute floor");
    }

    #[test]
    fn test_clamp_delta_walk_up_mania() {
        // Legitimate mania: MHI jumps from 12680 to 18620 (47% up)
        // With 33% clamp, first cohort gets: 12680 + 4184 = 16864
        // Second cohort: 16864 + 5565 = 22429 -> but target is 18620, so it arrives
        let clamped_1 = clamp_delta_bps(18_620, 12_680, 3_300);
        assert_eq!(clamped_1, 16_864); // 33% max move
        let clamped_2 = clamp_delta_bps(18_620, clamped_1, 3_300);
        assert_eq!(clamped_2, 18_620); // within range now, passes through
    }

    #[test]
    fn test_clamp_delta_zero_reference_unclamped() {
        // First cohort (no history) -> pass through
        assert_eq!(clamp_delta_bps(12_680, 0, 3_300), 12_680);
    }

    #[test]
    fn test_clamp_delta_zero_delta_disabled() {
        // delta=0 disables clamping
        assert_eq!(clamp_delta_bps(1, 12_680, 0), 1);
    }

    #[test]
    fn test_clamp_delta_floor_at_absolute_minimum() {
        // Lower bound is clamped to MHI_ABSOLUTE_FLOOR_BPS (currently 1000 = 0.1x).
        let floor = crate::constants::MHI_ABSOLUTE_FLOOR_BPS;
        assert_eq!(floor, 1_000, "test assumes MHI_ABSOLUTE_FLOOR_BPS = 1000");

        // ref=100, delta=3300: max_move = 33. lower = max(100-33=67, 1000) = 1000.
        assert_eq!(clamp_delta_bps(1, 100, 3_300), floor);
        // ref=1500, delta=3300: max_move = 495. lower = max(1500-495=1005, 1000) = 1005.
        assert_eq!(clamp_delta_bps(1, 1_500, 3_300), 1_005);
        // ref=6000, delta=3300: max_move = 1980. lower = max(6000-1980=4020, 1000) = 4020.
        assert_eq!(clamp_delta_bps(1, 6_000, 3_300), 4_020);
        // ref=10000, delta=3300: max_move = 3300. lower = max(10000-3300=6700, 1000) = 6700.
        assert_eq!(clamp_delta_bps(1, 10_000, 3_300), 6_700);
    }

    #[test]
    fn test_clamp_delta_exact_boundary() {
        // Exactly at the boundary -> passes through
        // ref=10000, delta=3300, max_move=3300
        // upper = 13300, lower = 6700
        assert_eq!(clamp_delta_bps(13_300, 10_000, 3_300), 13_300);
        assert_eq!(clamp_delta_bps(6_700, 10_000, 3_300), 6_700);
    }


    const CAP: u32 = crate::constants::MHI_CAP_BPS_DEFAULT; // 30_000 = 3.0x

    #[test]
    fn test_effective_mhi_in_band_under_cap_passes_through() {
        // ref=16_000, delta=33% -> band [10_720, 21_280]; 18_000 is inside it
        // and under the cap, so nothing touches it.
        assert_eq!(effective_mhi_bps(18_000, 16_000, 3_300, CAP), 18_000);
    }

    #[test]
    fn test_effective_mhi_above_cap_clamps_to_cap() {
        // No history (ref=0) disables the delta band, so the cap is the only
        // bound left. This is the first-cohort-after-init case.
        assert_eq!(effective_mhi_bps(45_000, 0, 3_300, CAP), CAP);
    }

    #[test]
    fn test_effective_mhi_delta_binds_before_cap() {
        // The devnet case that produced MhiExceedsCap (6020): last stored MHI
        // 16_755, keeper reads a median above 3.0x. The delta band is tighter
        // than the cap, so the cap never even binds — the old `require!` was
        // rejecting a value the chain was about to clamp to 22_284 anyway.
        assert_eq!(effective_mhi_bps(31_500, 16_755, 3_300, CAP), 22_284);
    }

    #[test]
    fn test_effective_mhi_cap_binds_when_band_reaches_past_it() {
        // ref=29_000 -> band upper = 38_570, above the cap. Cap wins.
        assert_eq!(effective_mhi_bps(45_000, 29_000, 3_300, CAP), CAP);
    }

    #[test]
    fn test_effective_mhi_low_submission_still_hits_delta_floor() {
        // The cap only bounds from above; a collapse submission is still held
        // by the delta band's lower edge.
        assert_eq!(effective_mhi_bps(1, 12_680, 3_300, CAP), 8_496);
    }

    #[test]
    fn test_effective_mhi_cap_lowered_below_delta_lower_edge() {
        // Authority lowered mhi_cap_bps to 2.0x while last stored MHI was 4.0x.
        // The delta band's lower edge (26_800) sits ABOVE the new cap, so
        // applying the cap last is what keeps the stored value under it.
        assert_eq!(clamp_delta_bps(20_000, 40_000, 3_300), 26_800);
        assert_eq!(effective_mhi_bps(20_000, 40_000, 3_300, 20_000), 20_000);
    }

    #[test]
    fn test_effective_mhi_cap_below_absolute_floor_is_cap() {
        // Documented misconfiguration: a cap under MHI_ABSOLUTE_FLOOR_BPS
        // leaves no payoff room at any strike. The cap still wins, and the
        // value stays settleable rather than aborting the instruction.
        let floor = crate::constants::MHI_ABSOLUTE_FLOOR_BPS;
        assert_eq!(effective_mhi_bps(1, 12_680, 3_300, 500), 500);
        assert!(500 < floor);
    }

    #[test]
    fn test_effective_mhi_never_exceeds_cap() {
        // The property settle_batch relies on: whatever the keeper submits,
        // the stored MHI is <= the cohort's cap, so `cap - strike` bounds the
        // payout for every slot.
        let refs = [0u32, 1_000, 12_680, 22_284, 29_999, 30_000, 40_000];
        let submissions = [0u32, 1, 9_999, 30_000, 30_001, 120_000, u32::MAX];
        for r in refs {
            for s in submissions {
                let e = effective_mhi_bps(s, r, 3_300, CAP);
                assert!(e <= CAP, "effective {e} exceeds cap for submitted={s}, ref={r}");
            }
        }
    }

    #[test]
    fn test_effective_mhi_disabled_delta_still_capped() {
        // delta_bps = 0 turns the circuit breaker off. The cap must still hold,
        // otherwise a config change would reopen the unbounded path.
        assert_eq!(effective_mhi_bps(u32::MAX, 12_680, 0, CAP), CAP);
    }
}
