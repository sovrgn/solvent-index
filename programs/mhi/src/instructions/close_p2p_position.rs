use anchor_lang::prelude::*;

use crate::errors::MhiError;
use crate::events::PositionClosed;
use crate::state::P2pPosition;

/// Permissionless cleanup of a settled+claimed P2pPosition PDA.
///
/// Mirror of close_position for the P2P pool path. settle_batch_p2p /
/// void_p2p_positions already transferred the payout/refund to the owner;
/// this instruction reclaims the PDA's rent for whoever calls it.
#[derive(Accounts)]
pub struct CloseP2pPosition<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        constraint = position.settled @ MhiError::NotSettled,
        constraint = position.claimed @ MhiError::PositionNotClaimed,
        close = caller,
    )]
    pub position: Account<'info, P2pPosition>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CloseP2pPosition>) -> Result<()> {
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
