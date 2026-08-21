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

    // Every position derived from this cohort must have reached a TERMINAL
    // STATE — settled or voided. That is not the same as its PDA being gone.
    // `settle_batch` decrements `outstanding_positions` when it settles a
    // position and pays it out atomically, while the Position PDA lives on
    // holding rent, so this check can pass with Position PDAs still open.
    //
    // That is deliberate and safe: settlement no longer needs the Cohort
    // account, so closing the cohort cannot strand a settled position. The
    // PDAs are retired afterwards by the permissionless `close_position` /
    // `close_p2p_position`, which need only the position itself.
    //
    // The trade-off is that once this runs, the cohort no longer indexes its
    // positions and only a program-wide scan can find them — so whatever
    // sweeps them must scan by state, not walk cohorts. The keeper's
    // PositionCloser does exactly that.
    //
    // (Historical note: this used to require the PDAs themselves to be gone,
    // cleaned up by `expire_position` / `expire_p2p_position`. Those
    // instructions were removed when settlement became atomic — there is no
    // unclaimed payout left to expire.)
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
