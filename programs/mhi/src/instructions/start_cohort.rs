use anchor_lang::prelude::*;

use crate::constants::{COHORT_SEED, EMA_STATE_SEED, GLOBAL_STATE_SEED, VAULT_SEED};
use crate::errors::MhiError;
use crate::events::CohortStarted;
use crate::state::{Cohort, CohortStatus, EmaState, GlobalState, Vault};

#[derive(Accounts)]
pub struct StartCohort<'info> {
    #[account(
        mut,
        constraint = keeper.key() == global_state.keeper @ MhiError::UnauthorizedKeeper,
    )]
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
        constraint = !global_state.paused @ MhiError::ProtocolPaused,
        constraint = global_state.can_start_cohort() @ MhiError::PreviousCohortNotResolved,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        seeds = [VAULT_SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = keeper,
        space = Cohort::SPACE,
        seeds = [COHORT_SEED, global_state.current_cohort_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub cohort: Account<'info, Cohort>,

    #[account(
        seeds = [EMA_STATE_SEED],
        bump = ema_state.bump,
    )]
    pub ema_state: Account<'info, EmaState>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<StartCohort>) -> Result<()> {
    let gs = &mut ctx.accounts.global_state;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Verify EMA is seeded (at least one strike has non-zero premium)
    // Without seeded EMA, premiums would be zero, allowing free calls
    let ema = &ctx.accounts.ema_state;
    let has_seeded_ema = ema.strikes.iter().any(|s| s.fast_ema_bps > 0 || s.slow_ema_bps > 0);
    require!(has_seeded_ema, MhiError::InvalidConfig);

    let trading_deadline = now
        .checked_add(gs.trading_window_seconds as i64)
        .ok_or(MhiError::Overflow)?;
    let measurement_deadline = trading_deadline
        .checked_add(gs.measurement_seconds as i64)
        .ok_or(MhiError::Overflow)?;
    // settlement_deadline is from measurement end + observation
    let observation_end = measurement_deadline
        .checked_add(gs.observation_seconds as i64)
        .ok_or(MhiError::Overflow)?;
    let settlement_deadline = observation_end
        .checked_add(gs.settlement_deadline_seconds as i64)
        .ok_or(MhiError::Overflow)?;
    let recovery_deadline = settlement_deadline
        .checked_add(gs.settlement_deadline_seconds as i64)
        .ok_or(MhiError::Overflow)?;

    // Initialize cohort
    let cohort = &mut ctx.accounts.cohort;
    cohort.bump = ctx.bumps.cohort;
    cohort.index = gs.current_cohort_index;
    cohort.status = CohortStatus::Trading;
    cohort.trading_start = now;
    cohort.trading_deadline = trading_deadline;
    cohort.measurement_deadline = measurement_deadline;
    cohort.settlement_deadline = settlement_deadline;
    cohort.recovery_deadline = recovery_deadline;
    cohort.mhi_bps = 0;
    cohort.token_count = 0;
    cohort.cohort_hash = [0u8; 32];
    cohort.total_call_volume_lamports = 0;
    cohort.total_positions = 0;
    cohort.positions_settled = 0;
    cohort.vault_collateral_locked = 0;
    cohort.vault_premiums_collected = 0;
    cohort.vault_payouts_due = 0;
    cohort.strike_volume_lamports = [0u64; crate::constants::NUM_STRIKES];
    cohort.p2p_collateral_locked = 0;
    cohort.p2p_premiums_collected = 0;
    cohort.p2p_payouts_due = 0;
    cohort.p2p_positions = 0;
    cohort.p2p_positions_settled = 0;
    cohort.p2p_strike_collateral = [0u64; crate::constants::NUM_STRIKES];
    cohort.positions_voided = 0;
    cohort.outstanding_positions = 0;
    cohort.outstanding_p2p_positions = 0;

    // Update global state
    gs.active_cohorts = gs.active_cohorts.checked_add(1).ok_or(MhiError::Overflow)?;
    gs.current_cohort_index = gs.current_cohort_index.checked_add(1).ok_or(MhiError::Overflow)?;
    gs.total_cohorts = gs.total_cohorts.checked_add(1).ok_or(MhiError::Overflow)?;

    emit!(CohortStarted {
        index: cohort.index,
        trading_start: now,
        trading_deadline,
    });

    Ok(())
}
