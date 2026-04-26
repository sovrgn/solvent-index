use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::{P2P_POOL_SEED, WRITER_ACCOUNT_SEED};
use crate::errors::MhiError;
use crate::state::{P2pPool, WriterAccount};

#[derive(Accounts)]
pub struct DepositP2p<'info> {
    #[account(mut)]
    pub writer: Signer<'info>,

    #[account(
        mut,
        seeds = [P2P_POOL_SEED],
        bump = p2p_pool.bump,
        constraint = p2p_pool.accepting_deposits @ MhiError::InvalidConfig,
    )]
    pub p2p_pool: Account<'info, P2pPool>,

    #[account(
        mut,
        seeds = [WRITER_ACCOUNT_SEED, writer.key().as_ref()],
        bump = writer_account.bump,
        constraint = writer_account.writer == writer.key() @ MhiError::UnauthorizedAuthority,
    )]
    pub writer_account: Account<'info, WriterAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositP2p>, amount: u64) -> Result<()> {
    require!(amount >= 100_000_000, MhiError::PositionTooSmall); // min 0.1 SOL

    // First deposit must be at least 1 SOL to prevent first-depositor attack
    if ctx.accounts.p2p_pool.total_shares == 0 {
        require!(amount >= 1_000_000_000, MhiError::PositionTooSmall); // 1 SOL minimum first deposit
    }

    // Sync pool lamports in case of direct transfers (donation attack mitigation)
    {
        let pool_info = ctx.accounts.p2p_pool.to_account_info();
        let rent = Rent::get()?;
        let rent_exempt = rent.minimum_balance(pool_info.data_len());
        let pool = &mut ctx.accounts.p2p_pool;
        pool.sync_lamports(pool_info.lamports(), rent_exempt);
    }

    // Transfer SOL from writer to P2P pool PDA
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.writer.to_account_info(),
                to: ctx.accounts.p2p_pool.to_account_info(),
            },
        ),
        amount,
    )?;

    // Mint shares to writer
    let pool = &mut ctx.accounts.p2p_pool;
    let shares = pool.lamports_to_shares(amount);
    require!(shares > 0, MhiError::PositionTooSmall);

    pool.available_lamports = pool.available_lamports
        .checked_add(amount)
        .ok_or(MhiError::Overflow)?;
    pool.total_shares = pool.total_shares
        .checked_add(shares)
        .ok_or(MhiError::Overflow)?;

    // Update writer account
    let wa = &mut ctx.accounts.writer_account;
    wa.shares = wa.shares.checked_add(shares).ok_or(MhiError::Overflow)?;
    wa.total_deposited_lamports = wa.total_deposited_lamports
        .checked_add(amount)
        .ok_or(MhiError::Overflow)?;

    Ok(())
}
