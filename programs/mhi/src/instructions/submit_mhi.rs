use anchor_lang::prelude::*;

use crate::constants::{COHORT_SEED, EMA_STATE_SEED, GLOBAL_STATE_SEED, NUM_STRIKES, VAULT_SEED};
use crate::errors::MhiError;
use crate::events::MhiSubmitted;
use crate::math::bps::effective_mhi_bps;
use crate::math::ema::{update_slot_frac_emas, update_strike_anchor};
use crate::math::premium::{adjust_strike_demand_markup, strike_share_bps};
use crate::state::{Cohort, CohortStatus, EmaState, GlobalState, Vault};

#[derive(Accounts)]
pub struct SubmitMhi<'info> {
    #[account(
        constraint = keeper.key() == global_state.keeper @ MhiError::UnauthorizedKeeper,
    )]
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [COHORT_SEED, cohort.index.to_le_bytes().as_ref()],
        bump = cohort.bump,
    )]
    pub cohort: Account<'info, Cohort>,

    #[account(
        mut,
        seeds = [EMA_STATE_SEED],
        bump = ema_state.bump,
    )]
    pub ema_state: Account<'info, EmaState>,

    #[account(
        seeds = [VAULT_SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
}

pub fn handler(
    ctx: Context<SubmitMhi>,
    mhi_bps: u32,
    token_count: u16,
    cohort_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;

    // Snapshot the inputs we need before we take mutable borrows. The cap
    // we settle against is the cohort's at-start snapshot, not the current
    // global cap — `update_config { mhi_cap_bps }` mid-flight must not
    // change in-flight cohort economics.
    let mhi_cap_bps = ctx.accounts.cohort.mhi_cap_bps_at_start;
    let global_mhi_cap_bps = ctx.accounts.global_state.mhi_cap_bps;
    let mhi_max_delta_bps = ctx.accounts.global_state.mhi_max_delta_bps;
    let last_mhi_bps = ctx.accounts.global_state.last_mhi_bps;
    let prev_anchor_bps = ctx.accounts.global_state.strike_anchor_bps;
    let prev_settlement_count = ctx.accounts.global_state.strike_anchor_settlement_count;
    let observation_seconds = ctx.accounts.global_state.observation_seconds;

    let cohort = &mut ctx.accounts.cohort;

    require!(
        cohort.status == CohortStatus::Trading || cohort.status == CohortStatus::Measuring,
        MhiError::InvalidCohortStatus
    );
    require!(
        clock.unix_timestamp >= cohort.trading_deadline,
        MhiError::TradingWindowOpen
    );

    let observation_end = cohort
        .measurement_deadline
        .checked_add(observation_seconds as i64)
        .ok_or(MhiError::Overflow)?;
    require!(
        clock.unix_timestamp >= observation_end,
        MhiError::ObservationNotComplete
    );

    require!(!cohort.has_mhi(), MhiError::MhiAlreadySubmitted);

    // Zero stays a rejection: it is the keeper saying "no reading", not a
    // reading of zero, and clamping it would fabricate an index value out of a
    // data outage. The keeper's own defer path handles a missing MHI (it waits,
    // then flags the cohort for void); the chain must not paper over it.
    require!(mhi_bps > 0, MhiError::MhiZero);
    require!(
        token_count >= crate::constants::MIN_COHORT_TOKENS,
        MhiError::InvalidConfig
    );

    // Drift-style clamp, then the cap. The keeper submits any value; we hold it
    // inside ±delta of the previous cohort's MHI (with an absolute floor) and
    // under this cohort's cap. The resulting value is what we record and feed
    // into anchor/EMA updates — never the raw input.
    //
    // The cap used to be `require!(mhi_bps <= cap)`, which made a hot market
    // able to stop settlement: every submission above 3.0x reverted with
    // MhiExceedsCap, the cohort never got its MHI, and the keeper retried until
    // the median came back down while its active_cohorts slot stayed occupied.
    // Rejecting bought nothing, because `capped_payoff_bps` already truncates
    // payoff at `cap - strike` — a stored `min(value, cap)` settles every
    // position identically to the raw value. The bound the protocol actually
    // relies on against a lying keeper is the delta band, which still applies.
    //
    // The cap is the COHORT's at-start snapshot, not the live global cap: an
    // authority that lowers `mhi_cap_bps` mid-flight must not cut payoffs for
    // positions already priced and collateralized against the higher one. The
    // keeper clamps to the live global cap on its side, which is where that
    // config-consistency concern belongs.
    let effective_mhi = effective_mhi_bps(mhi_bps, last_mhi_bps, mhi_max_delta_bps, mhi_cap_bps);
    if effective_mhi != mhi_bps {
        msg!(
            "mhi clamped: submitted={} stored={} (last={} delta_bps={} cap={})",
            mhi_bps,
            effective_mhi,
            last_mhi_bps,
            mhi_max_delta_bps,
            mhi_cap_bps
        );
    }

    cohort.status = CohortStatus::Measuring;
    cohort.mhi_bps = effective_mhi;
    cohort.token_count = token_count;
    cohort.cohort_hash = cohort_hash;

    let cohort_strikes = cohort.strikes;
    let cohort_anchor_at_start = cohort.strike_anchor_bps_at_start;
    let total_vol = cohort.total_call_volume_lamports;
    let cohort_index = cohort.index;
    // Per-slot strike volumes — copy out before we mutate ema_state.
    let strike_volumes = cohort.strike_volume_lamports;
    let cohort_volume_for_global = cohort.total_call_volume_lamports;

    let ema = &mut ctx.accounts.ema_state;

    // Fractional EMA update per slot. Uses the cohort's anchor snapshot as the
    // denominator — NOT the current global anchor, because later cohorts may
    // have already shifted it before this one settled.
    for i in 0..NUM_STRIKES {
        let strike = cohort_strikes[i];
        if strike == 0 {
            continue;
        }
        // A strike at or above the cohort's cap has no payoff room: every
        // `cap - strike` in the payoff/collateral path underflows on it.
        // `buy_call` rejects such strikes so no position can exist here, and
        // the anchor ceiling stops new ladders from containing them — but
        // cohorts opened before that ceiling landed still carry them, and
        // aborting the whole instruction over a slot nobody can trade would
        // strand those cohorts forever. Skip the slot, leaving its EMAs
        // untouched rather than decaying them toward zero (a decayed EMA
        // would underprice the slot the moment the anchor falls back and
        // makes it tradeable again).
        if strike >= mhi_cap_bps {
            continue;
        }
        let (new_fast, new_slow) = update_slot_frac_emas(
            effective_mhi,
            strike,
            cohort_anchor_at_start,
            mhi_cap_bps,
            ema.slots[i].fast_frac_bps,
            ema.slots[i].slow_frac_bps,
        )
        .ok_or(MhiError::Overflow)?;
        ema.slots[i].fast_frac_bps = new_fast;
        ema.slots[i].slow_frac_bps = new_slow;
    }
    ema.last_updated_cohort = cohort_index;

    // Per-slot demand markup adjustment based on this cohort's volume share.
    for i in 0..NUM_STRIKES {
        if cohort_strikes[i] == 0 {
            continue;
        }
        let share = strike_share_bps(strike_volumes[i], total_vol);
        ema.slots[i].demand_markup_bps =
            adjust_strike_demand_markup(ema.slots[i].demand_markup_bps, share);
    }

    // Anchor + settlement-count update. Ceilinged against the CURRENT global
    // cap (not the cohort snapshot) because the anchor it produces is what the
    // NEXT cohort's ladder is derived from, and that cohort will snapshot the
    // global cap as it stands then.
    let new_anchor = update_strike_anchor(
        prev_anchor_bps,
        effective_mhi,
        prev_settlement_count,
        global_mhi_cap_bps,
    )
    .ok_or(MhiError::Overflow)?;
    let gs = &mut ctx.accounts.global_state;
    gs.strike_anchor_bps = new_anchor;
    gs.strike_anchor_settlement_count = prev_settlement_count
        .checked_add(1)
        .ok_or(MhiError::Overflow)?;
    gs.last_mhi_bps = effective_mhi;
    gs.total_volume_lamports = gs
        .total_volume_lamports
        .checked_add(cohort_volume_for_global)
        .unwrap_or(gs.total_volume_lamports);

    emit!(MhiSubmitted {
        cohort_index,
        mhi_bps: effective_mhi,
        token_count,
        cohort_hash,
        new_strike_anchor_bps: new_anchor,
    });

    Ok(())
}
