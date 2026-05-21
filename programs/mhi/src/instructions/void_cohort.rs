use anchor_lang::prelude::*;

use crate::constants::{COHORT_SEED, GLOBAL_STATE_SEED, VAULT_SEED};
use crate::errors::MhiError;
use crate::events::CohortVoided;
use crate::math::payoff::total_collateral_lamports_ceil;
use crate::state::{Cohort, CohortStatus, GlobalState, Position, Vault};

#[derive(Accounts)]
pub struct VoidCohort<'info> {
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
        seeds = [VAULT_SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [COHORT_SEED, cohort.index.to_le_bytes().as_ref()],
        bump = cohort.bump,
    )]
    pub cohort: Account<'info, Cohort>,
    // Remaining accounts: Position accounts to refund (must be mut)
}

pub fn handler(ctx: Context<VoidCohort>) -> Result<()> {
    let clock = Clock::get()?;

    // Read values before mutable borrows.
    // cap_bps from cohort snapshot, not live global state — authority cannot
    // retroactively change the cap that sized this cohort's collateral.
    let cohort_key = ctx.accounts.cohort.key();
    let cohort_index = ctx.accounts.cohort.index;
    let cap_bps = ctx.accounts.cohort.mhi_cap_bps_at_start;

    //
    // First call: status must not be resolved, no MHI, no settlements, past recovery.
    // Subsequent calls (batching): status must be Voiding.

    let is_continuation = ctx.accounts.cohort.status == CohortStatus::Voiding;

    if !is_continuation {
        // First call - full precondition checks
        require!(!ctx.accounts.cohort.is_resolved(), MhiError::CohortAlreadyResolved);
        require!(!ctx.accounts.cohort.has_mhi(), MhiError::MhiAlreadySubmitted);
        require!(ctx.accounts.cohort.positions_settled == 0, MhiError::PositionsAlreadySettled);
        require!(ctx.accounts.cohort.p2p_positions_settled == 0, MhiError::PositionsAlreadySettled);
        require!(
            clock.unix_timestamp >= ctx.accounts.cohort.recovery_deadline,
            MhiError::RecoveryDeadlineNotReached
        );
    }
    // else: Voiding status means preconditions were already verified on first call

    // Each remaining account is a Position PDA. We mark it as settled with
    // payout = premium_paid (full refund) so the buyer can claim it back.
    // Collateral is released per-position to support batched voids.

    let mut batch_voided = 0u32;

    for account_info in ctx.remaining_accounts.iter() {
        let mut data = account_info.try_borrow_mut_data()?;

        require!(
            account_info.owner == ctx.program_id,
            MhiError::CohortMismatch
        );

        let position = Position::try_deserialize(&mut &data[..])?;

        require!(
            position.cohort == cohort_key,
            MhiError::CohortMismatch
        );

        // Skip already processed positions (idempotent)
        if position.settled {
            continue;
        }

        // Refund the FULL premium the buyer paid (including referral portion).
        // The referral was already transferred to the referrer during buy_call and
        // cannot be clawed back. The vault covers this delta from its own reserves.
        // Buyers should not lose money when a cohort is voided through no fault of
        // their own (voids are authority-only, past recovery deadline).
        let refund = position.premium_paid_lamports;

        // Compute collateral locked for this position (same formula as buy_call)
        let position_collateral = total_collateral_lamports_ceil(
            cap_bps,
            position.strike_bps,
            position.size_lamports,
        )
        .ok_or(MhiError::Overflow)?;

        // Release per-position collateral and reserve refund
        {
            let vault = &mut ctx.accounts.vault;

            // Release collateral: active → available
            vault.active_collateral_lamports = vault
                .active_collateral_lamports
                .checked_sub(position_collateral)
                .ok_or(MhiError::Overflow)?;
            vault.available_lamports = vault
                .available_lamports
                .checked_add(position_collateral)
                .ok_or(MhiError::Overflow)?;

            // Reserve refund: available → unclaimed_payouts
            if refund > 0 {
                vault.available_lamports = vault
                    .available_lamports
                    .checked_sub(refund)
                    .ok_or(MhiError::Overflow)?;
                vault.unclaimed_payouts_lamports = vault
                    .unclaimed_payouts_lamports
                    .checked_add(refund)
                    .ok_or(MhiError::Overflow)?;
            }
        }

        // Mark position as settled with premium as payout (refund)
        let updated = Position {
            bump: position.bump,
            owner: position.owner,
            cohort: position.cohort,
            strike_bps: position.strike_bps,
            size_lamports: position.size_lamports,
            premium_paid_lamports: position.premium_paid_lamports,
            vault_premium_lamports: position.vault_premium_lamports,
            nonce: position.nonce,
            settled: true,
            payout_lamports: refund,
            claim_deadline: clock
                .unix_timestamp
                .checked_add(ctx.accounts.global_state.claim_expiry_seconds as i64)
                .ok_or(MhiError::Overflow)?,
            claimed: false,
        };
        let mut writer = &mut data[..];
        updated.try_serialize(&mut writer)?;

        batch_voided += 1;
    }


    let cohort = &mut ctx.accounts.cohort;
    cohort.positions_voided = cohort
        .positions_voided
        .checked_add(batch_voided)
        .ok_or(MhiError::Overflow)?;

    //
    // If all vault positions are voided (or cohort has none): transition to Voided.
    // Otherwise: transition to Voiding (intermediate, allows more batches).

    let all_vault_voided = cohort.total_positions == 0
        || cohort.positions_voided >= cohort.total_positions;

    if all_vault_voided {
        cohort.status = CohortStatus::Voided;

        // Decrement active cohort count (only on final transition)
        if !is_continuation {
            // First and only call - decrement now
            ctx.accounts.global_state.active_cohorts = ctx
                .accounts
                .global_state
                .active_cohorts
                .checked_sub(1)
                .ok_or(MhiError::Overflow)?;
        }
        // If continuation (Voiding → Voided), active_cohorts was already decremented
        // on the first call that set Voiding.

        emit!(CohortVoided {
            cohort_index,
        });
    } else if !is_continuation {
        // First call, not all voided yet - enter Voiding state
        cohort.status = CohortStatus::Voiding;

        // Decrement active_cohorts on first call (Voiding blocks trading/settlement)
        ctx.accounts.global_state.active_cohorts = ctx
            .accounts
            .global_state
            .active_cohorts
            .checked_sub(1)
            .ok_or(MhiError::Overflow)?;
    }
    // else: already Voiding, more batches to come - no status change needed

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
