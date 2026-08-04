use anchor_lang::prelude::*;

use crate::constants::{COHORT_SEED, GLOBAL_STATE_SEED};
use crate::errors::MhiError;
use crate::state::{Cohort, GlobalState};

#[derive(Accounts)]
pub struct CloseCohort<'info> {
    /// The keeper triggers the close and RECEIVES the cohort rent refund. The
    /// keeper funded that rent when it created the cohort at start_cohort, so
    /// returning it here makes cohort creation rent-neutral over the round's
    /// life (the keeper only ever spends tx fees). Keeper-only on purpose: the
    /// rent must return to the wallet that paid it, not to a third party who
    /// front-runs the close to snipe it.
    #[account(
        mut,
        constraint = caller.key() == global_state.keeper @ MhiError::UnauthorizedKeeper,
    )]
    pub caller: Signer<'info>,

    #[account(
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [COHORT_SEED, cohort.index.to_le_bytes().as_ref()],
        bump = cohort.bump,
        close = caller,
    )]
    pub cohort: Account<'info, Cohort>,
}

pub fn handler(ctx: Context<CloseCohort>) -> Result<()> {
    let cohort = &ctx.accounts.cohort;
    let _gs = &ctx.accounts.global_state;
    let clock = Clock::get()?;

    // Must be settled or voided
    require!(cohort.is_resolved(), MhiError::InvalidCohortStatus);

    // Tight invariant: every Position / P2pPosition PDA derived from this cohort
    // must have been closed (via claim or expire). Without this, close_cohort
    // could brick still-open positions because claim and expire both require
    // the Cohort account to deserialize.
    //
    // expire_position / expire_p2p_position are permissionless after
    // claim_deadline (rent reward → caller), so unclaimed positions get
    // cleaned up reliably regardless of buyer behaviour. The counter will
    // reach zero on its own.
    require!(cohort.is_quiescent(), MhiError::ClaimNotExpired);

    // Soft floor: prevent close from running during an in-progress cohort
    // even if some future bug zeroed the counter prematurely.
    require!(
        clock.unix_timestamp >= cohort.settlement_deadline,
        MhiError::ClaimNotExpired
    );

    // Anchor's `close = caller` handles zeroing, rent refund to the keeper
    // (the caller, validated == global_state.keeper), and owner reassignment to
    // the system program.
    Ok(())
}
