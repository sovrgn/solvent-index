use anchor_lang::prelude::*;

use crate::constants::P2P_POOL_SEED;
use crate::errors::MhiError;
use crate::state::{Cohort, P2pPool, P2pPosition};

#[derive(Accounts)]
pub struct ClaimP2p<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    /// The position owner who receives the payout
    /// CHECK: validated against position.owner
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,

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
        close = owner,
    )]
    pub p2p_position: Account<'info, P2pPosition>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimP2p>) -> Result<()> {
    let position = &ctx.accounts.p2p_position;
    let clock = Clock::get()?;

    require!(position.settled, MhiError::PositionNotSettled);
    require!(!position.claimed, MhiError::PositionAlreadyClaimed);
    require!(clock.unix_timestamp < position.claim_deadline, MhiError::ClaimExpired);
    require!(
        ctx.accounts.owner.key() == position.owner,
        MhiError::UnauthorizedAuthority
    );

    let payout = position.payout_lamports;

    if payout > 0 {
        // Transfer payout from P2P pool PDA to owner
        let pool_info = ctx.accounts.p2p_pool.to_account_info();
        let owner_info = ctx.accounts.owner.to_account_info();

        // Ensure pool has enough lamports for payout + rent exemption
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(pool_info.data_len());
        require!(
            pool_info.lamports() >= payout.checked_add(min_balance).ok_or(MhiError::Overflow)?,
            MhiError::InsufficientWriterCollateral
        );

        **pool_info.try_borrow_mut_lamports()? -= payout;
        **owner_info.try_borrow_mut_lamports()? += payout;

        // Update pool tracking
        let pool = &mut ctx.accounts.p2p_pool;
        pool.unclaimed_payouts_lamports = pool.unclaimed_payouts_lamports
            .checked_sub(payout)
            .ok_or(MhiError::Overflow)?;
    }

    let position = &mut ctx.accounts.p2p_position;
    position.claimed = true;

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
