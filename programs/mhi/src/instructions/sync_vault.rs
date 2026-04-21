use anchor_lang::prelude::*;

use crate::constants::{GLOBAL_STATE_SEED, VAULT_SEED};
use crate::errors::MhiError;
use crate::state::{GlobalState, Vault};

/// Reconciles the vault's tracked balance with its actual lamport balance.
///
/// If SOL was sent directly to the vault PDA (outside of seed_vault),
/// the tracked fields won't reflect it. This instruction detects the
/// surplus and adds it to available_lamports so the protocol can use it.
///
/// Authority-only to prevent griefing (someone sends 1 lamport then calls sync
/// to inflate available_lamports in a way that could affect risk calculations).
#[derive(Accounts)]
pub struct SyncVault<'info> {
    #[account(
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
}

pub fn handler(ctx: Context<SyncVault>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let actual_lamports = vault.to_account_info().lamports();

    let tracked = vault
        .tracked_total()
        .ok_or(MhiError::Overflow)?;

    // Rent-exempt minimum is whatever remains after tracked balances.
    // On a fresh vault, this is the rent-exempt minimum for the account size.
    // We compute surplus as: actual - rent_exempt - tracked.
    // Since we don't know rent_exempt exactly, we use: actual - tracked,
    // but only if actual > tracked (surplus exists).
    // The rent_exempt amount stays untouched because we never touch it.

    let rent = Rent::get()?;
    let rent_exempt = rent.minimum_balance(Vault::SPACE);

    // Surplus = actual lamports - rent_exempt - tracked
    let accountable = rent_exempt
        .checked_add(tracked)
        .ok_or(MhiError::Overflow)?;

    if actual_lamports > accountable {
        let surplus = actual_lamports
            .checked_sub(accountable)
            .ok_or(MhiError::Overflow)?;

        vault.available_lamports = vault
            .available_lamports
            .checked_add(surplus)
            .ok_or(MhiError::Overflow)?;
    }

    Ok(())
}
