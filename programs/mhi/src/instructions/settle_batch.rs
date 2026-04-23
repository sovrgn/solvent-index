use anchor_lang::prelude::*;

use crate::constants::{COHORT_SEED, GLOBAL_STATE_SEED, VAULT_SEED};
use crate::errors::MhiError;
use crate::events::PositionSettled;
use crate::math::payoff::{capped_payoff_bps, payout_lamports, total_collateral_lamports_ceil};
use crate::state::{Cohort, CohortStatus, GlobalState, Position, Vault};

#[derive(Accounts)]
pub struct SettleBatch<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

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
    // Remaining accounts: Position accounts to settle (must be mut)
}

pub fn handler(ctx: Context<SettleBatch>) -> Result<()> {
    let clock = Clock::get()?;

    // Read values we need before taking mutable references
    let keeper = ctx.accounts.global_state.keeper;
    let cap_bps = ctx.accounts.global_state.mhi_cap_bps;
    let claim_expiry = ctx.accounts.global_state.claim_expiry_seconds as i64;
    let cohort_key = ctx.accounts.cohort.key();
    let cohort_index = ctx.accounts.cohort.index;


    // MHI must be submitted
    require!(ctx.accounts.cohort.has_mhi(), MhiError::MhiNotSubmitted);

    // Must be in Measuring or Settling status
    require!(
        ctx.accounts.cohort.status == CohortStatus::Measuring
            || ctx.accounts.cohort.status == CohortStatus::Settling,
        MhiError::InvalidCohortStatus
    );

    // Before settlement_deadline: only keeper can settle
    // After settlement_deadline: anyone can settle (permissionless)
    if clock.unix_timestamp < ctx.accounts.cohort.settlement_deadline {
        require!(
            ctx.accounts.caller.key() == keeper,
            MhiError::SettlementDeadlineNotReached
        );
    }

    let mhi_bps = ctx.accounts.cohort.mhi_bps;

    // Require at least one position account to prevent empty-call DOS.
    // Without this, an empty settle_batch would transition status to Settling
    // without settling any positions, permanently locking the cohort.
    require!(
        !ctx.remaining_accounts.is_empty() || ctx.accounts.cohort.total_positions == 0,
        MhiError::NoPositionsProvided
    );


    for account_info in ctx.remaining_accounts.iter() {
        // Deserialize position
        let mut data = account_info.try_borrow_mut_data()?;

        // Verify account is owned by this program
        require!(
            account_info.owner == ctx.program_id,
            MhiError::CohortMismatch
        );

        // Deserialize - skip 8-byte discriminator
        let position = Position::try_deserialize(&mut &data[..])?;

        // Validate this position belongs to the cohort
        require!(
            position.cohort == cohort_key,
            MhiError::CohortMismatch
        );

        // Verify account is a legitimate Position PDA
        let strike_bytes = position.strike_bps.to_le_bytes();
        let (expected_pda, _bump) = Pubkey::find_program_address(
            &[
                crate::constants::POSITION_SEED,
                cohort_key.as_ref(),
                position.owner.as_ref(),
                strike_bytes.as_ref(),
                &[position.nonce],
            ],
            ctx.program_id,
        );
        require!(
            account_info.key() == expected_pda,
            MhiError::CohortMismatch
        );

        // Skip already settled positions (idempotent)
        if position.settled {
            continue;
        }

        // Transition to Settling on first actual settlement
        if ctx.accounts.cohort.status == CohortStatus::Measuring {
            ctx.accounts.cohort.status = CohortStatus::Settling;
        }

        // Compute payout
        let payoff_bps = capped_payoff_bps(mhi_bps, position.strike_bps, cap_bps)
            .ok_or(MhiError::Overflow)?;
        let payout = payout_lamports(payoff_bps, position.size_lamports)
            .ok_or(MhiError::Overflow)?;

        // Compute collateral that was locked for this position.
        // MUST use ceil to match buy_call's locking calculation.
        let position_collateral = total_collateral_lamports_ceil(
            cap_bps,
            position.strike_bps,
            position.size_lamports,
        )
        .ok_or(MhiError::Overflow)?;

        // Update vault: release collateral, move payout to unclaimed
        let vault = &mut ctx.accounts.vault;
        vault.active_collateral_lamports = vault
            .active_collateral_lamports
            .checked_sub(position_collateral)
            .ok_or(MhiError::Overflow)?;

        if payout > 0 {
            vault.unclaimed_payouts_lamports = vault
                .unclaimed_payouts_lamports
                .checked_add(payout)
                .ok_or(MhiError::Overflow)?;
            vault.cumulative_payouts_lamports = vault
                .cumulative_payouts_lamports
                .checked_add(payout)
                .ok_or(MhiError::Overflow)?;

            let returned = position_collateral
                .checked_sub(payout)
                .ok_or(MhiError::Overflow)?;
            vault.available_lamports = vault
                .available_lamports
                .checked_add(returned)
                .ok_or(MhiError::Overflow)?;
        } else {
            vault.available_lamports = vault
                .available_lamports
                .checked_add(position_collateral)
                .ok_or(MhiError::Overflow)?;
        }

        // Update cohort tracking
        let cohort = &mut ctx.accounts.cohort;
        cohort.vault_payouts_due = cohort
            .vault_payouts_due
            .checked_add(payout)
            .ok_or(MhiError::Overflow)?;
        cohort.positions_settled = cohort
            .positions_settled
            .checked_add(1)
            .ok_or(MhiError::Overflow)?;

        // Write updated position back
        let claim_deadline = clock
            .unix_timestamp
            .checked_add(claim_expiry)
            .ok_or(MhiError::Overflow)?;

        let updated_position = Position {
            bump: position.bump,
            owner: position.owner,
            cohort: position.cohort,
            strike_bps: position.strike_bps,
            size_lamports: position.size_lamports,
            premium_paid_lamports: position.premium_paid_lamports,
            vault_premium_lamports: position.vault_premium_lamports,
            nonce: position.nonce,
            settled: true,
            payout_lamports: payout,
            claim_deadline,
            claimed: false,
        };
        let mut writer = &mut data[..];
        updated_position.try_serialize(&mut writer)?;

        emit!(PositionSettled {
            cohort_index,
            owner: position.owner,
            strike_bps: position.strike_bps,
            size_lamports: position.size_lamports,
            payout_lamports: payout,
        });
    }

    // Check if all positions (vault + P2P) are settled, or cohort is empty
    if ctx.accounts.cohort.all_settled() || ctx.accounts.cohort.is_empty() {
        ctx.accounts.cohort.status = CohortStatus::Settled;
        ctx.accounts.global_state.active_cohorts = ctx
            .accounts
            .global_state
            .active_cohorts
            .checked_sub(1)
            .ok_or(MhiError::Overflow)?;
    }

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
