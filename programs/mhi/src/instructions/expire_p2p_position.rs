use anchor_lang::prelude::*;

use crate::constants::P2P_POOL_SEED;
use crate::errors::MhiError;
use crate::state::{Cohort, P2pPool, P2pPosition};

/// Expire an unclaimed P2P position after the claim deadline.
/// Unclaimed payout stays in the pool (writers keep it).
/// Rent refund goes to caller (incentivizes cleanup).
#[derive(Accounts)]
pub struct ExpireP2pPosition<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [P2P_POOL_SEED],
        bump = p2p_pool.bump,
    )]
    pub p2p_pool: Account<'info, P2pPool>,

    #[account(mut)]
    pub cohort: Account<'info, Cohort>,

    #[account(
        mut,
        constraint = p2p_position.cohort == cohort.key() @ MhiError::CohortMismatch,
        close = caller,
    )]
    pub p2p_position: Account<'info, P2pPosition>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ExpireP2pPosition>) -> Result<()> {
    let position = &ctx.accounts.p2p_position;
    let clock = Clock::get()?;

    require!(position.settled, MhiError::PositionNotSettled);
    require!(!position.claimed, MhiError::PositionAlreadyClaimed);
    // +1 second grace: prevents front-running a buyer's last-second claim with expire
    require!(clock.unix_timestamp > position.claim_deadline, MhiError::ClaimNotExpired);

    // Unclaimed payout moves from unclaimed_payouts back to available
    // (stays in pool - writers benefit)
    let pool = &mut ctx.accounts.p2p_pool;
    let unclaimed = position.payout_lamports;
    pool.unclaimed_payouts_lamports = pool.unclaimed_payouts_lamports
        .saturating_sub(unclaimed);
    pool.available_lamports = pool.available_lamports
        .checked_add(unclaimed)
        .ok_or(MhiError::Overflow)?;

    // Decrement outstanding-position counter so close_cohort can eventually fire.
    let cohort = &mut ctx.accounts.cohort;
    cohort.outstanding_p2p_positions = cohort
        .outstanding_p2p_positions
        .checked_sub(1)
        .ok_or(MhiError::Overflow)?;

    // Pool conservation check
    {
        let pool_info = ctx.accounts.p2p_pool.to_account_info();
        let rent = Rent::get()?;
        let rent_exempt = rent.minimum_balance(pool_info.data_len());
        require!(
            ctx.accounts.p2p_pool.check_conservation(pool_info.lamports(), rent_exempt),
            MhiError::VaultBalanceMismatch
        );
    }

    Ok(())
}
