use anchor_lang::prelude::*;

use crate::constants::{ACCOUNT_VERSION, GLOBAL_STATE_SEED, P2P_POOL_SEED};
use crate::errors::MhiError;
use crate::state::{GlobalState, P2pPool};

#[derive(Accounts)]
pub struct InitP2pPool<'info> {
    #[account(
        mut,
        constraint = authority.key() == global_state.authority @ MhiError::UnauthorizedAuthority,
    )]
    pub authority: Signer<'info>,

    #[account(
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        init,
        payer = authority,
        space = P2pPool::SPACE,
        seeds = [P2P_POOL_SEED],
        bump,
    )]
    pub p2p_pool: Account<'info, P2pPool>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitP2pPool>) -> Result<()> {
    let pool = &mut ctx.accounts.p2p_pool;
    pool.version = ACCOUNT_VERSION;
    pool.bump = ctx.bumps.p2p_pool;
    pool.available_lamports = 0;
    pool.active_collateral_lamports = 0;
    pool.unclaimed_payouts_lamports = 0;
    pool.total_shares = 0;
    pool.cumulative_premiums_lamports = 0;
    pool.cumulative_payouts_lamports = 0;
    pool.accepting_deposits = true;

    Ok(())
}
