use anchor_lang::prelude::*;

use crate::constants::{COHORT_SEED, GLOBAL_STATE_SEED, P2P_POOL_SEED};
use crate::errors::MhiError;
use crate::state::{Cohort, CohortStatus, GlobalState, P2pPool, P2pPosition};

/// Void P2P positions in a voided cohort.
/// Called after void_cohort has set the cohort status to Voided.
///
/// For each P2P position:
///   - Mark as settled with payout = writer_premium_lamports (refund)
///   - The payout will be claimable from the P2P pool via claim_p2p
///   - Released collateral returns to pool available
///
/// Remaining accounts: P2pPosition accounts (mut).
#[derive(Accounts)]
pub struct VoidP2pPositions<'info> {
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
        seeds = [P2P_POOL_SEED],
        bump = p2p_pool.bump,
    )]
    pub p2p_pool: Account<'info, P2pPool>,

    #[account(
        seeds = [COHORT_SEED, cohort.index.to_le_bytes().as_ref()],
        bump = cohort.bump,
        constraint = cohort.status == CohortStatus::Voided @ MhiError::InvalidCohortStatus,
    )]
    pub cohort: Account<'info, Cohort>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, VoidP2pPositions<'info>>,
) -> Result<()> {
    let clock = Clock::get()?;
    let cohort_key = ctx.accounts.cohort.key();
    let claim_expiry = ctx.accounts.global_state.claim_expiry_seconds;

    let mut total_refunds = 0u64;
    let mut total_collateral_released = 0u64;

    for account_info in ctx.remaining_accounts.iter() {
        require!(account_info.owner == ctx.program_id, MhiError::CohortMismatch);

        let mut data = account_info.try_borrow_mut_data()?;
        let mut position: P2pPosition = P2pPosition::try_deserialize(&mut &data[..])?;

        if position.settled { continue; }
        require!(position.cohort == cohort_key, MhiError::CohortMismatch);

        // Refund: buyer gets back the FULL amount they paid (premium + buyer_fee).
        // The protocol fees (buyer_fee + writer_fee) went to the vault, not the pool.
        // The writer_premium went to the pool. On void, the pool refunds what it holds
        // (writer_premium), and any shortfall must be covered.
        // Since premium_paid = premium + buyer_fee, and writer_premium = premium - writer_fee,
        // the delta (buyer_fee + writer_fee) was sent to the vault during buy_call_p2p.
        // The pool can only refund writer_premium from its own balance.
        // Full refund requires the pool to pay writer_premium and the vault to pay the rest.
        // For simplicity, we refund writer_premium from pool (what it has) - the protocol
        // fees are accepted as the cost of voiding (same as vault model where referral is lost).
        // TODO: Consider vault contributing protocol_share on void for full buyer refund.
        let refund = position.writer_premium_lamports;
        total_refunds += refund;

        // Compute the collateral that was locked for this position.
        // Use the cohort's at-start cap snapshot, not the live global cap —
        // authority cannot retroactively change the cap that sized the lock.
        let collateral = crate::math::payoff::total_collateral_lamports_ceil(
            ctx.accounts.cohort.mhi_cap_bps_at_start,
            position.strike_bps,
            position.size_lamports,
        ).ok_or(MhiError::Overflow)?;
        total_collateral_released += collateral;

        // Mark position as settled with refund as payout
        position.settled = true;
        position.payout_lamports = refund;
        position.claim_deadline = clock.unix_timestamp
            .checked_add(claim_expiry as i64)
            .ok_or(MhiError::Overflow)?;

        position.try_serialize(&mut &mut data[..])?;
    }

    // Update pool: release collateral, reserve refunds as unclaimed payouts
    let pool = &mut ctx.accounts.p2p_pool;
    pool.active_collateral_lamports = pool.active_collateral_lamports
        .checked_sub(total_collateral_released)
        .ok_or(MhiError::Overflow)?;
    pool.available_lamports = pool.available_lamports
        .checked_add(total_collateral_released)
        .ok_or(MhiError::Overflow)?;
    // Refunds come from the premiums that are already in the pool
    pool.unclaimed_payouts_lamports = pool.unclaimed_payouts_lamports
        .checked_add(total_refunds)
        .ok_or(MhiError::Overflow)?;
    // Reduce available by refund amount (premium that was earned is now owed back)
    pool.available_lamports = pool.available_lamports
        .checked_sub(total_refunds)
        .ok_or(MhiError::Overflow)?;

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
