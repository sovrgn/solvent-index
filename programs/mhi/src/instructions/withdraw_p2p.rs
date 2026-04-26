use anchor_lang::prelude::*;

use crate::constants::{GLOBAL_STATE_SEED, P2P_POOL_SEED, WRITER_ACCOUNT_SEED};
use crate::errors::MhiError;
use crate::state::{GlobalState, P2pPool, WriterAccount};

#[derive(Accounts)]
pub struct WithdrawP2p<'info> {
    #[account(
        mut,
        constraint = writer.key() == writer_account.writer @ MhiError::UnauthorizedAuthority,
    )]
    pub writer: Signer<'info>,

    #[account(
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

    #[account(
        mut,
        seeds = [WRITER_ACCOUNT_SEED, writer.key().as_ref()],
        bump = writer_account.bump,
    )]
    pub writer_account: Account<'info, WriterAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<WithdrawP2p>, shares_to_burn: u64) -> Result<()> {
    require!(shares_to_burn > 0, MhiError::WithdrawAmountZero);

    // Sync pool lamports in case of direct transfers (donation attack mitigation)
    {
        let pool_info = ctx.accounts.p2p_pool.to_account_info();
        let rent = Rent::get()?;
        let rent_exempt = rent.minimum_balance(pool_info.data_len());
        let pool = &mut ctx.accounts.p2p_pool;
        pool.sync_lamports(pool_info.lamports(), rent_exempt);
    }

    let wa = &ctx.accounts.writer_account;
    require!(wa.shares >= shares_to_burn, MhiError::InsufficientWriterCollateral);

    let pool = &ctx.accounts.p2p_pool;

    // Convert shares to lamports at current pool value
    let lamports_out = pool.shares_to_lamports(shares_to_burn);
    require!(lamports_out > 0, MhiError::WithdrawAmountZero);

    // Can only withdraw from available (not locked collateral or unclaimed payouts)
    require!(
        pool.available_lamports >= lamports_out,
        MhiError::InsufficientVaultCollateral
    );

    // Transfer SOL from P2P pool PDA to writer
    // Pool is a PDA - use lamport manipulation
    let pool_info = ctx.accounts.p2p_pool.to_account_info();
    let writer_info = ctx.accounts.writer.to_account_info();

    // Ensure pool stays above rent exemption
    let rent = Rent::get()?;
    let min_balance = rent.minimum_balance(pool_info.data_len());
    require!(
        pool_info.lamports().saturating_sub(lamports_out) >= min_balance,
        MhiError::WithdrawBelowMinimum
    );

    **pool_info.try_borrow_mut_lamports()? -= lamports_out;
    **writer_info.try_borrow_mut_lamports()? += lamports_out;

    // Burn shares and update pool
    let pool = &mut ctx.accounts.p2p_pool;
    pool.available_lamports = pool.available_lamports
        .checked_sub(lamports_out)
        .ok_or(MhiError::Overflow)?;
    pool.total_shares = pool.total_shares
        .checked_sub(shares_to_burn)
        .ok_or(MhiError::Overflow)?;

    // Update writer account
    let wa = &mut ctx.accounts.writer_account;
    wa.shares = wa.shares.checked_sub(shares_to_burn).ok_or(MhiError::Overflow)?;
    wa.total_withdrawn_lamports = wa.total_withdrawn_lamports
        .checked_add(lamports_out)
        .ok_or(MhiError::Overflow)?;

    // Dust threshold: if remaining shares are worth less than dust floor, burn them
    const DUST_THRESHOLD_LAMPORTS: u64 = 100_000; // 0.0001 SOL - reasonable dust floor
    let wa = &mut ctx.accounts.writer_account;
    if wa.shares > 0 {
        let remaining_value = ctx.accounts.p2p_pool.shares_to_lamports(wa.shares);
        if remaining_value < DUST_THRESHOLD_LAMPORTS {
            // Burn dust shares - value stays in pool (benefits other writers)
            let pool = &mut ctx.accounts.p2p_pool;
            pool.total_shares = pool.total_shares.saturating_sub(wa.shares);
            wa.shares = 0;
        }
    }

    // Auto-close writer account if shares are now 0
    if wa.shares == 0 {
        // Transfer account rent lamports to writer, zeroing the account
        let wa_info = ctx.accounts.writer_account.to_account_info();
        let writer_info = ctx.accounts.writer.to_account_info();
        let lamports = wa_info.lamports();
        **wa_info.try_borrow_mut_lamports()? = 0;
        **writer_info.try_borrow_mut_lamports()? += lamports;
        // Zero account data to mark it closed
        wa_info.assign(&anchor_lang::system_program::ID);
        wa_info.realloc(0, false)?;
    }

    Ok(())
}
