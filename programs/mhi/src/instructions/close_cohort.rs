use anchor_lang::prelude::*;

use crate::constants::{COHORT_SEED, GLOBAL_STATE_SEED};
use crate::errors::MhiError;
use crate::state::{Cohort, GlobalState};

#[derive(Accounts)]
pub struct CloseCohort<'info> {
    /// Anyone can trigger the close - they pay the tx fee, but the
    /// rent refund always goes to `authority`.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    /// CHECK: validated against global_state.authority via the address
    /// constraint. Pure rent destination - no data is read.
    #[account(
        mut,
        address = global_state.authority @ MhiError::UnauthorizedAuthority,
    )]
    pub authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [COHORT_SEED, cohort.index.to_le_bytes().as_ref()],
        bump = cohort.bump,
        close = authority,
    )]
    pub cohort: Account<'info, Cohort>,
}

pub fn handler(ctx: Context<CloseCohort>) -> Result<()> {
    let cohort = &ctx.accounts.cohort;
    let gs = &ctx.accounts.global_state;
    let clock = Clock::get()?;

    // Must be settled or voided
    require!(cohort.is_resolved(), MhiError::InvalidCohortStatus);

    // Must be past claim expiry window so all positions have been
    // claimed or expired. This ensures no position PDA still references
    // this cohort for claim/expire_position calls.
    //
    // settlement_deadline is the latest a cohort could have been settled.
    // claim_expiry_seconds is the time window after settlement for claims.
    // After both have passed, all positions are either claimed or expirable.
    let earliest_close = cohort
        .settlement_deadline
        .checked_add(gs.claim_expiry_seconds as i64)
        .ok_or(MhiError::Overflow)?;
    require!(
        clock.unix_timestamp >= earliest_close,
        MhiError::ClaimNotExpired
    );

    // Anchor's `close = caller` handles zeroing, rent refund, and owner reassignment.
    Ok(())
}
