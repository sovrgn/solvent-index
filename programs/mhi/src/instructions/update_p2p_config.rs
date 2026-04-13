use anchor_lang::prelude::*;

use crate::constants::{GLOBAL_STATE_SEED, P2P_POOL_SEED};
use crate::errors::MhiError;
use crate::state::{GlobalState, P2pPool};

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct UpdateP2pConfigParams {
    pub p2p_buyer_fee_bps: u16,
    pub p2p_writer_fee_bps: u16,
    pub p2p_enabled: bool,
    pub accepting_deposits: bool,
}

#[derive(Accounts)]
pub struct UpdateP2pConfig<'info> {
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

    #[account(
        mut,
        seeds = [P2P_POOL_SEED],
        bump = p2p_pool.bump,
    )]
    pub p2p_pool: Account<'info, P2pPool>,
}

pub fn handler(ctx: Context<UpdateP2pConfig>, params: UpdateP2pConfigParams) -> Result<()> {
    require!(params.p2p_buyer_fee_bps <= 2_000, MhiError::InvalidConfig);  // max 20%
    require!(params.p2p_writer_fee_bps <= 3_000, MhiError::InvalidConfig); // max 30%

    let gs = &mut ctx.accounts.global_state;
    gs.p2p_buyer_fee_bps = params.p2p_buyer_fee_bps;
    gs.p2p_writer_fee_bps = params.p2p_writer_fee_bps;
    gs.p2p_enabled = params.p2p_enabled;

    ctx.accounts.p2p_pool.accepting_deposits = params.accepting_deposits;

    Ok(())
}
