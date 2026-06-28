use anchor_lang::prelude::*;

use crate::errors::MhiError;
use crate::events::PositionClosed;
use crate::state::Position;

/// Permissionless cleanup of a settled+claimed vault Position PDA.
///
/// In the post-atomic-settle world, `settle_batch` already transferred the
/// payout to the owner inside the same tx that marked the position
/// settled+claimed. The Position PDA still exists holding ~0.002 SOL rent,
/// which has no further purpose. This instruction reclaims that rent for
/// whoever calls it — which restores the third-party cleanup incentive the
/// old `expire_position` had, without the old "forfeit payout" semantics
/// (because there is no unclaimed payout to forfeit).
///
/// Anyone can call this. The owner can self-serve to recover their own
/// rent; a cleanup bot can run it for the rent reward; the keeper can sweep
/// it as part of its routine close_cohort flow.
#[derive(Accounts)]
pub struct ClosePosition<'info> {
    /// Whoever pays the tx fee and receives the rent. Permissionless.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        constraint = position.settled @ MhiError::NotSettled,
        constraint = position.claimed @ MhiError::PositionNotClaimed,
        close = caller,
    )]
    pub position: Account<'info, Position>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClosePosition>) -> Result<()> {
    // Capture position state before Anchor's `close = caller` drains rent
    // and zeroes the account (close runs after the handler returns).
    let position = &ctx.accounts.position;
    let rent_recovered = position.to_account_info().lamports();

    emit!(PositionClosed {
        cohort: position.cohort,
        owner: position.owner,
        strike_bps: position.strike_bps,
        nonce: position.nonce,
        caller: ctx.accounts.caller.key(),
        rent_recovered,
    });

    Ok(())
}
