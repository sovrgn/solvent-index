use anchor_lang::prelude::*;

use crate::constants::VAULT_SEED;
use crate::errors::MhiError;
use crate::events::PositionExpired;
use crate::state::{Cohort, Position, Vault};

#[derive(Accounts)]
pub struct ExpirePosition<'info> {
    /// Anyone can expire unclaimed positions. Rent goes to caller.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub cohort: Account<'info, Cohort>,

    #[account(
        mut,
        constraint = position.cohort == cohort.key() @ MhiError::CohortMismatch,
        close = caller, // Rent refund to caller (incentivizes cleanup)
    )]
    pub position: Account<'info, Position>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ExpirePosition>) -> Result<()> {
    let position = &ctx.accounts.position;
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;


    require!(position.settled, MhiError::NotSettled);
    require!(!position.claimed, MhiError::AlreadyClaimed);
    // +1 second grace: prevents front-running a buyer's last-second claim with expire
    require!(
        clock.unix_timestamp > position.claim_deadline,
        MhiError::ClaimNotExpired
    );

    let unclaimed = position.payout_lamports;


    if unclaimed > 0 {
        vault.unclaimed_payouts_lamports = vault
            .unclaimed_payouts_lamports
            .checked_sub(unclaimed)
            .ok_or(MhiError::Overflow)?;
        vault.available_lamports = vault
            .available_lamports
            .checked_add(unclaimed)
            .ok_or(MhiError::Overflow)?;

        // Move lamports from vault's unclaimed tracking back
        // No actual SOL transfer needed - it's already in the vault PDA
    }

    // Position is closed by Anchor's `close = caller` constraint.
    // Decrement outstanding-position counter so close_cohort can eventually fire.
    let cohort = &mut ctx.accounts.cohort;
    cohort.outstanding_positions = cohort
        .outstanding_positions
        .checked_sub(1)
        .ok_or(MhiError::Overflow)?;

    emit!(PositionExpired {
        cohort_index: ctx.accounts.cohort.index,
        owner: position.owner,
        unclaimed_lamports: unclaimed,
    });

    {
        let v = &ctx.accounts.vault;
        let tracked = v.available_lamports
            .checked_add(v.active_collateral_lamports)
            .and_then(|s| s.checked_add(v.unclaimed_payouts_lamports))
            .ok_or(MhiError::Overflow)?;
        let vault_lamports = v.to_account_info().lamports();
        require!(tracked <= vault_lamports, MhiError::VaultBalanceMismatch);
    }

    Ok(())
}
