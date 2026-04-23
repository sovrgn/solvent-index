use anchor_lang::prelude::*;

use crate::constants::VAULT_SEED;
use crate::errors::MhiError;
use crate::events::PayoutClaimed;
use crate::state::{Cohort, Position, Vault};

#[derive(Accounts)]
pub struct Claim<'info> {
    /// Anyone can call claim on behalf of the owner. Rent goes to caller.
    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: The owner receives the payout. Validated against position.owner.
    #[account(
        mut,
        constraint = owner.key() == position.owner @ MhiError::CohortMismatch,
    )]
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    /// The cohort this position belongs to (for event data).
    pub cohort: Account<'info, Cohort>,

    #[account(
        mut,
        constraint = position.cohort == cohort.key() @ MhiError::CohortMismatch,
        close = owner, // Rent refund to owner (prevents MEV bots extracting rent)
    )]
    pub position: Account<'info, Position>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Claim>) -> Result<()> {
    let position = &ctx.accounts.position;
    let vault = &mut ctx.accounts.vault;
    let clock = Clock::get()?;


    require!(position.settled, MhiError::NotSettled);
    require!(!position.claimed, MhiError::AlreadyClaimed);
    require!(
        clock.unix_timestamp < position.claim_deadline,
        MhiError::ClaimExpired
    );

    let payout = position.payout_lamports;


    if payout > 0 {
        vault.unclaimed_payouts_lamports = vault
            .unclaimed_payouts_lamports
            .checked_sub(payout)
            .ok_or(MhiError::Overflow)?;
    }


    // Transfer SOL from vault PDA to position.owner (ALWAYS owner, never caller - Invariant 6)
    // Direct lamport manipulation: safe because we own the vault account (program PDA).
    if payout > 0 {
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= payout;
        **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += payout;
    }

    // The position account is closed by Anchor's `close = caller` constraint.
    // This zeros data, transfers rent to caller, and reassigns owner to system program.

    // Verify tracked total does not exceed actual lamports (sanity check).
    // Read vault fields directly to avoid borrow conflict.
    {
        let v = &ctx.accounts.vault;
        let tracked = v.available_lamports
            .checked_add(v.active_collateral_lamports)
            .and_then(|s| s.checked_add(v.unclaimed_payouts_lamports))
            .ok_or(MhiError::Overflow)?;
        let vault_lamports = v.to_account_info().lamports();
        require!(tracked <= vault_lamports, MhiError::VaultBalanceMismatch);
    }

    emit!(PayoutClaimed {
        cohort_index: ctx.accounts.cohort.index,
        owner: position.owner,
        payout_lamports: payout,
    });

    Ok(())
}
