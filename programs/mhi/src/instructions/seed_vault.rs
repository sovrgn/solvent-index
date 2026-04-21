use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::{GLOBAL_STATE_SEED, VAULT_SEED};
use crate::errors::MhiError;
use crate::events::VaultSeeded;
use crate::state::{GlobalState, Vault};

#[derive(Accounts)]
pub struct SeedVault<'info> {
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

pub fn handler(ctx: Context<SeedVault>, amount: u64) -> Result<()> {
    require!(amount > 0, MhiError::SeedAmountZero);

    // Transfer SOL from authority to vault PDA
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        amount,
    )?;

    // Update vault balance tracking
    let vault = &mut ctx.accounts.vault;
    vault.available_lamports = vault
        .available_lamports
        .checked_add(amount)
        .ok_or(MhiError::Overflow)?;
    vault.protocol_seed_lamports = vault
        .protocol_seed_lamports
        .checked_add(amount)
        .ok_or(MhiError::Overflow)?;

    emit!(VaultSeeded {
        authority: ctx.accounts.authority.key(),
        amount,
        new_available: vault.available_lamports,
    });

    Ok(())
}
