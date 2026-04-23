use anchor_lang::prelude::*;

use crate::constants::{COHORT_SEED, EMA_STATE_SEED, GLOBAL_STATE_SEED, VAULT_SEED};
use crate::errors::MhiError;
use crate::events::MhiSubmitted;
use crate::math::bps::clamp_delta_bps;
use crate::math::ema::update_emas_for_strike;
use crate::math::premium::{adjust_markup, adjust_strike_demand_markup, strike_share_bps, utilization_bps};
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
    let gs = &ctx.accounts.global_state;
    let cohort = &mut ctx.accounts.cohort;
    let ema = &mut ctx.accounts.ema_state;
    let clock = Clock::get()?;


    // Must be in Measuring status (trading deadline passed)
    // The status is still "Trading" on-chain but we check clock
    require!(
        cohort.status == CohortStatus::Trading || cohort.status == CohortStatus::Measuring,
        MhiError::InvalidCohortStatus
    );
    require!(
        clock.unix_timestamp >= cohort.trading_deadline,
        MhiError::TradingWindowOpen
    );

    // Observation must be complete
    let observation_end = cohort
        .measurement_deadline
        .checked_add(gs.observation_seconds as i64)
        .ok_or(MhiError::Overflow)?;
    require!(
        clock.unix_timestamp >= observation_end,
        MhiError::ObservationNotComplete
    );

    // MHI not already submitted
    require!(!cohort.has_mhi(), MhiError::MhiAlreadySubmitted);

    // Validate MHI value
    require!(mhi_bps > 0, MhiError::MhiZero);
    require!(mhi_bps <= gs.mhi_cap_bps, MhiError::MhiExceedsCap);

    //
    // The keeper submits any value. The program clamps it so it cannot
    // move more than mhi_max_delta_bps% from the previous cohort's MHI.
    //
    // This does NOT reject the submission - it accepts a clamped value.
    // Any target can be reached over multiple cohorts. A compromised
    // keeper must sustain false submissions across many cohorts to walk
    // the MHI to an extreme, giving monitoring time to detect and rotate.
    //
    // Example with 33% clamp (mhi_max_delta_bps=3300):
    //   Legitimate crash 1.27→0.50: takes 3 cohorts (~75 min) to fully reflect
    //   Compromised keeper 1.27→0.01: takes 6+ cohorts (~150 min), all obviously wrong
    //
    // First cohort (last_mhi_bps==0) is unclamped. delta_bps==0 disables clamping.
    let effective_mhi = clamp_delta_bps(mhi_bps, gs.last_mhi_bps, gs.mhi_max_delta_bps);

    // Validate token count
    require!(token_count >= crate::constants::MIN_COHORT_TOKENS, MhiError::InvalidConfig);


    cohort.status = CohortStatus::Measuring;
    cohort.mhi_bps = effective_mhi;
    cohort.token_count = token_count;
    cohort.cohort_hash = cohort_hash;


    for strike_ema in ema.strikes.iter_mut() {
        if strike_ema.strike_bps == 0 {
            continue; // Skip uninitialized slots
        }
        let (new_fast, new_slow) = update_emas_for_strike(
            effective_mhi,
            strike_ema.strike_bps,
            strike_ema.fast_ema_bps,
            strike_ema.slow_ema_bps,
        )
        .ok_or(MhiError::Overflow)?;
        strike_ema.fast_ema_bps = new_fast;
        strike_ema.slow_ema_bps = new_slow;
    }
    ema.last_updated_cohort = cohort.index;

    // Each strike's demand markup adjusts based on its share of total volume.
    let total_vol = cohort.total_call_volume_lamports;
    for (i, strike_ema) in ema.strikes.iter_mut().enumerate() {
        if strike_ema.strike_bps == 0 {
            continue;
        }
        let strike_vol = cohort.strike_volume_lamports[i];
        let share = strike_share_bps(strike_vol, total_vol);
        strike_ema.demand_markup_bps = adjust_strike_demand_markup(
            strike_ema.demand_markup_bps,
            share,
        );
    }

    // Legacy global markup (kept for layout compat, uses vault utilization)
    let vault_total = ctx.accounts.vault.available_lamports
        .checked_add(ctx.accounts.vault.active_collateral_lamports)
        .unwrap_or(0);
    let util_bps = utilization_bps(cohort.vault_collateral_locked, vault_total)
        .unwrap_or(0);
    ema.markup_bps = adjust_markup(ema.markup_bps, util_bps);

    // Update global volume counter
    ctx.accounts.global_state.total_volume_lamports = ctx
        .accounts
        .global_state
        .total_volume_lamports
        .checked_add(cohort.total_call_volume_lamports)
        .unwrap_or(ctx.accounts.global_state.total_volume_lamports); // saturate on overflow

    // Track clamped MHI as reference for next cohort's clamp
    ctx.accounts.global_state.last_mhi_bps = effective_mhi;

    emit!(MhiSubmitted {
        cohort_index: cohort.index,
        mhi_bps: effective_mhi,
        token_count,
        cohort_hash,
    });

    Ok(())
}
