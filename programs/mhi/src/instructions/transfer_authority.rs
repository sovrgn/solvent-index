use anchor_lang::prelude::*;

use crate::constants::GLOBAL_STATE_SEED;
use crate::errors::MhiError;
use crate::events::AuthorityTransferred;
use crate::state::GlobalState;


#[derive(Accounts)]
pub struct ProposeAuthority<'info> {
    #[account(
        constraint = authority.key() == global_state.authority @ MhiError::UnauthorizedAuthority,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,
}

pub fn propose_handler(ctx: Context<ProposeAuthority>, new_authority: Pubkey) -> Result<()> {
    // Cannot propose Pubkey::default (zero address) - would brick the protocol
    require!(new_authority != Pubkey::default(), MhiError::InvalidConfig);

    ctx.accounts.global_state.pending_authority = new_authority;
    Ok(())
}


#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        constraint = new_authority.key() == global_state.pending_authority @ MhiError::UnauthorizedAuthority,
    )]
    pub new_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,
}

pub fn accept_handler(ctx: Context<AcceptAuthority>) -> Result<()> {
    // pending_authority must not be default (no pending proposal)
    require!(
        ctx.accounts.global_state.pending_authority != Pubkey::default(),
        MhiError::InvalidConfig,
    );

    let old_authority = ctx.accounts.global_state.authority;
    let new_authority = ctx.accounts.global_state.pending_authority;

    ctx.accounts.global_state.authority = new_authority;
    ctx.accounts.global_state.pending_authority = Pubkey::default();

    emit!(AuthorityTransferred {
        old_authority,
        new_authority,
    });

    Ok(())
}


#[derive(Accounts)]
pub struct CancelAuthorityTransfer<'info> {
    #[account(
        constraint = authority.key() == global_state.authority @ MhiError::UnauthorizedAuthority,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,
}

pub fn cancel_handler(ctx: Context<CancelAuthorityTransfer>) -> Result<()> {
    ctx.accounts.global_state.pending_authority = Pubkey::default();
    Ok(())
}
