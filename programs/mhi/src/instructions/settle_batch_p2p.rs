use anchor_lang::prelude::*;

use crate::constants::{COHORT_SEED, GLOBAL_STATE_SEED, P2P_POOL_SEED};
use crate::errors::MhiError;
use crate::math::payoff::{capped_payoff_bps, payout_lamports, total_collateral_lamports_ceil};
use crate::state::{Cohort, CohortStatus, GlobalState, P2pPool, P2pPosition};

#[derive(Accounts)]
pub struct SettleBatchP2p<'info> {
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
        seeds = [P2P_POOL_SEED],
        bump = p2p_pool.bump,
    )]
    pub p2p_pool: Account<'info, P2pPool>,

    #[account(
        mut,
        seeds = [COHORT_SEED, cohort.index.to_le_bytes().as_ref()],
        bump = cohort.bump,
    )]
    pub cohort: Account<'info, Cohort>,
    // Remaining accounts: P2pPosition accounts (mut)
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleBatchP2p<'info>>,
) -> Result<()> {
    let cohort = &ctx.accounts.cohort;
    let gs = &ctx.accounts.global_state;
    let clock = Clock::get()?;

    require!(cohort.has_mhi(), MhiError::MhiNotSubmitted);
    require!(
        cohort.status == CohortStatus::Measuring || cohort.status == CohortStatus::Settling,
        MhiError::InvalidCohortStatus
    );

    if clock.unix_timestamp < cohort.settlement_deadline {
        require!(
            ctx.accounts.caller.key() == gs.keeper,
            MhiError::SettlementDeadlineNotReached
        );
    }

    let mhi_bps = cohort.mhi_bps;
    // cap_bps from cohort snapshot, not live global state — see N-01 fix.
    let cap_bps = cohort.mhi_cap_bps_at_start;
    let cohort_key = cohort.key();

    let mut settled_count = 0u32;
    let mut total_payouts = 0u64;
    let mut total_collateral_released = 0u64;

    for account_info in ctx.remaining_accounts.iter() {
        // Verify ownership
        require!(account_info.owner == ctx.program_id, MhiError::CohortMismatch);

        let mut data = account_info.try_borrow_mut_data()?;
        let mut position: P2pPosition = P2pPosition::try_deserialize(&mut &data[..])?;

        if position.settled { continue; }
        require!(position.cohort == cohort_key, MhiError::CohortMismatch);

        // Verify position belongs to this pool
        require!(
            position.p2p_pool == ctx.accounts.p2p_pool.key(),
            MhiError::CohortMismatch
        );

        // Verify account is a legitimate P2pPosition PDA
        let strike_bytes = position.strike_bps.to_le_bytes();
        let (expected_pda, _bump) = Pubkey::find_program_address(
            &[
                crate::constants::P2P_POSITION_SEED,
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

        // Compute payoff
        let payoff_bps = capped_payoff_bps(mhi_bps, position.strike_bps, cap_bps)
            .ok_or(MhiError::Overflow)?;
        let payout = payout_lamports(payoff_bps, position.size_lamports)
            .ok_or(MhiError::Overflow)?;

        let position_collateral = total_collateral_lamports_ceil(
            cap_bps, position.strike_bps, position.size_lamports,
        ).ok_or(MhiError::Overflow)?;
        let capped_payout = payout.min(position_collateral);

        // Update position
        position.settled = true;
        position.payout_lamports = capped_payout;
        position.claim_deadline = clock.unix_timestamp
            .checked_add(gs.claim_expiry_seconds as i64)
            .ok_or(MhiError::Overflow)?;

        position.try_serialize(&mut &mut data[..])?;

        total_payouts += capped_payout;
        // Released collateral = position_collateral - payout (what stays with writers)
        total_collateral_released += position_collateral.saturating_sub(capped_payout);
        settled_count += 1;
    }

    // Update P2P pool: release unused collateral, reserve payouts
    let pool = &mut ctx.accounts.p2p_pool;
    let total_removed = total_collateral_released
        .checked_add(total_payouts)
        .ok_or(MhiError::Overflow)?;
    pool.active_collateral_lamports = pool.active_collateral_lamports
        .checked_sub(total_removed)
        .ok_or(MhiError::Overflow)?;
    pool.available_lamports = pool.available_lamports
        .checked_add(total_collateral_released)
        .ok_or(MhiError::Overflow)?;
    pool.unclaimed_payouts_lamports = pool.unclaimed_payouts_lamports
        .checked_add(total_payouts)
        .ok_or(MhiError::Overflow)?;
    pool.cumulative_payouts_lamports = pool.cumulative_payouts_lamports
        .checked_add(total_payouts)
        .ok_or(MhiError::Overflow)?;

    // Update cohort
    let cohort = &mut ctx.accounts.cohort;
    cohort.p2p_positions_settled = cohort.p2p_positions_settled
        .checked_add(settled_count)
        .ok_or(MhiError::Overflow)?;
    cohort.p2p_payouts_due = cohort.p2p_payouts_due
        .checked_add(total_payouts)
        .ok_or(MhiError::Overflow)?;

    if cohort.status == CohortStatus::Measuring && settled_count > 0 {
        cohort.status = CohortStatus::Settling;
    }

    if cohort.all_settled() {
        cohort.status = CohortStatus::Settled;
        ctx.accounts.global_state.active_cohorts = ctx
            .accounts
            .global_state
            .active_cohorts
            .checked_sub(1)
            .ok_or(MhiError::Overflow)?;
    }

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
