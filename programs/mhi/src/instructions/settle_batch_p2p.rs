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
    // Remaining accounts: (P2pPosition, owner) pairs.
    //
    // For each P2P position to settle, the caller passes the P2pPosition PDA
    // followed by the owner's wallet pubkey. The handler validates
    // owner.key() == position.owner and transfers the payout to the owner
    // directly inside this tx — no separate claim_p2p step. The position PDA
    // stays alive marked settled+claimed as a historical record.
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

    // Pairs must be balanced; odd count is a caller bug.
    require!(
        ctx.remaining_accounts.len() % 2 == 0,
        MhiError::MalformedSettleAccounts
    );

    let mhi_bps = cohort.mhi_bps;
    // cap_bps from cohort snapshot, not live global state — see N-01 fix.
    let cap_bps = cohort.mhi_cap_bps_at_start;
    let cohort_key = cohort.key();
    let pool_key = ctx.accounts.p2p_pool.key();

    let mut settled_count = 0u32;
    let mut total_payouts = 0u64;
    let mut total_collateral_released = 0u64;

    for chunk in ctx.remaining_accounts.chunks(2) {
        let position_ai = &chunk[0];
        let owner_ai = &chunk[1];

        // Verify ownership before deserializing
        require!(position_ai.owner == ctx.program_id, MhiError::CohortMismatch);

        let mut data = position_ai.try_borrow_mut_data()?;
        let mut position: P2pPosition = P2pPosition::try_deserialize(&mut &data[..])?;

        if position.settled { continue; }
        require!(position.cohort == cohort_key, MhiError::CohortMismatch);
        require!(position.p2p_pool == pool_key, MhiError::CohortMismatch);

        // Verify position belongs to a legitimate P2pPosition PDA
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
            position_ai.key() == expected_pda,
            MhiError::CohortMismatch
        );

        // The paired owner account MUST match this position's owner. If the
        // caller could pass an arbitrary recipient, they'd steal payouts.
        require!(
            owner_ai.key() == position.owner,
            MhiError::OwnerMismatch
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

        // Mark position settled+claimed inline. claim_deadline=0 (no claim
        // step). claimed=true gates a future close_position cleanup.
        position.settled = true;
        position.payout_lamports = capped_payout;
        position.claim_deadline = 0;
        position.claimed = true;
        position.try_serialize(&mut &mut data[..])?;
        drop(data);

        total_payouts += capped_payout;
        total_collateral_released += position_collateral.saturating_sub(capped_payout);
        settled_count += 1;

        // Direct payout transfer pool → owner.
        if capped_payout > 0 {
            **ctx.accounts.p2p_pool.to_account_info().try_borrow_mut_lamports()? -= capped_payout;
            **owner_ai.try_borrow_mut_lamports()? = owner_ai
                .lamports()
                .checked_add(capped_payout)
                .ok_or(MhiError::Overflow)?;
        }
    }

    // Update P2P pool accounting. The unclaimed_payouts bucket is no longer
    // used because the payout is transferred to the owner in the same tx.
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
    // outstanding_p2p_positions now means "P2P positions whose terminal
    // state has not yet been resolved". Decrement here even though PDAs
    // stay alive — close_cohort gates on outstanding == 0.
    cohort.outstanding_p2p_positions = cohort.outstanding_p2p_positions
        .checked_sub(settled_count)
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
