use anchor_lang::prelude::*;

use crate::constants::{GLOBAL_STATE_SEED, VAULT_SEED};
use crate::errors::MhiError;
use crate::events::VaultWithdrawn;
use crate::state::{GlobalState, Vault};

/// Withdraw excess SOL from the vault to the authority wallet.
///
/// Guards:
///   - Signer must be authority
///   - Protocol must be Idle (no active cohort - between rounds)
///   - Cannot withdraw below min_vault_balance_lamports
///   - Cannot withdraw active_collateral or unclaimed_payouts
///   - Only withdraws from available_lamports
///
/// This enables automatic vault right-sizing between cohorts.
/// The keeper calls this after settle_batch completes and before
/// start_cohort, extracting profit while maintaining optimal capacity.
#[derive(Accounts)]
pub struct WithdrawVault<'info> {
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
        mut,
        seeds = [VAULT_SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<WithdrawVault>, amount: u64) -> Result<()> {
    require!(amount > 0, MhiError::WithdrawAmountZero);

    let vault = &mut ctx.accounts.vault;

    // Can only withdraw from available_lamports (not collateral or unclaimed payouts)
    require!(
        amount <= vault.available_lamports,
        MhiError::InsufficientVaultCollateral,
    );

    // Must keep at least min_vault_balance_lamports available after withdrawal
    let remaining = vault
        .available_lamports
        .checked_sub(amount)
        .ok_or(MhiError::Overflow)?;

    require!(
        remaining >= vault.min_vault_balance_lamports,
        MhiError::WithdrawBelowMinimum,
    );

    // Transfer SOL from vault PDA to authority
    // Vault is a PDA - must use lamport manipulation, not CPI transfer
    let vault_info = vault.to_account_info();
    let authority_info = ctx.accounts.authority.to_account_info();

    **vault_info.try_borrow_mut_lamports()? -= amount;
    **authority_info.try_borrow_mut_lamports()? += amount;

    // Update tracked balance
    vault.available_lamports = remaining;

    emit!(VaultWithdrawn {
        authority: ctx.accounts.authority.key(),
        amount,
        remaining_available: remaining,
    });

    Ok(())
}
