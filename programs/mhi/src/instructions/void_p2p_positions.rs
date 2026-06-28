use anchor_lang::prelude::*;

use crate::constants::{COHORT_SEED, GLOBAL_STATE_SEED, P2P_POOL_SEED};
use crate::errors::MhiError;
use crate::state::{Cohort, CohortStatus, GlobalState, P2pPool, P2pPosition};

/// Void P2P positions in a voided cohort.
/// Called after void_cohort has set the cohort status to Voided.
///
/// For each P2P position:
///   - Refund (writer_premium_lamports) is transferred directly to the
///     owner's wallet in the same tx — no separate claim step.
///   - Released collateral returns to pool available.
///   - The position PDA stays alive marked settled+claimed for history.
///
/// Remaining accounts: (P2pPosition, owner) pairs.
#[derive(Accounts)]
pub struct VoidP2pPositions<'info> {
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
        seeds = [P2P_POOL_SEED],
        bump = p2p_pool.bump,
    )]
    pub p2p_pool: Account<'info, P2pPool>,

    #[account(
        mut,
        seeds = [COHORT_SEED, cohort.index.to_le_bytes().as_ref()],
        bump = cohort.bump,
        constraint = cohort.status == CohortStatus::Voided @ MhiError::InvalidCohortStatus,
    )]
    pub cohort: Account<'info, Cohort>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, VoidP2pPositions<'info>>,
) -> Result<()> {
    let cohort_key = ctx.accounts.cohort.key();
    let cap_bps = ctx.accounts.cohort.mhi_cap_bps_at_start;

    // Pairs must be balanced; odd count is a caller bug.
    require!(
        ctx.remaining_accounts.len() % 2 == 0,
        MhiError::MalformedSettleAccounts
    );

    let mut total_refunds = 0u64;
    let mut total_collateral_released = 0u64;
    let mut settled_count = 0u32;

    for chunk in ctx.remaining_accounts.chunks(2) {
        let position_ai = &chunk[0];
        let owner_ai = &chunk[1];

        require!(position_ai.owner == ctx.program_id, MhiError::CohortMismatch);

        let mut data = position_ai.try_borrow_mut_data()?;
        let mut position: P2pPosition = P2pPosition::try_deserialize(&mut &data[..])?;

        if position.settled { continue; }
        require!(position.cohort == cohort_key, MhiError::CohortMismatch);
        require!(owner_ai.key() == position.owner, MhiError::OwnerMismatch);

        // Refund: see settle_batch_p2p — the pool can only refund
        // writer_premium (the buyer_fee + writer_fee were sent to the vault
        // during buy_call_p2p, the buyer accepts that loss on void).
        let refund = position.writer_premium_lamports;

        let collateral = crate::math::payoff::total_collateral_lamports_ceil(
            cap_bps,
            position.strike_bps,
            position.size_lamports,
        ).ok_or(MhiError::Overflow)?;
        total_collateral_released += collateral;
        total_refunds += refund;
        settled_count += 1;

        // Mark settled+claimed inline; refund transferred below.
        position.settled = true;
        position.payout_lamports = refund;
        position.claim_deadline = 0;
        position.claimed = true;
        position.try_serialize(&mut &mut data[..])?;
        drop(data);

        // Direct refund transfer pool → owner.
        if refund > 0 {
            **ctx.accounts.p2p_pool.to_account_info().try_borrow_mut_lamports()? -= refund;
            **owner_ai.try_borrow_mut_lamports()? = owner_ai
                .lamports()
                .checked_add(refund)
                .ok_or(MhiError::Overflow)?;
        }
    }

    // Update pool: release collateral. The unclaimed_payouts bucket is no
    // longer touched — refunds were transferred directly to owners.
    let pool = &mut ctx.accounts.p2p_pool;
    pool.active_collateral_lamports = pool.active_collateral_lamports
        .checked_sub(total_collateral_released)
        .ok_or(MhiError::Overflow)?;
    pool.available_lamports = pool.available_lamports
        .checked_add(total_collateral_released)
        .ok_or(MhiError::Overflow)?;
    // The refund came out of the pool's premium reserves (premiums were
    // already in available_lamports); subtract them.
    pool.available_lamports = pool.available_lamports
        .checked_sub(total_refunds)
        .ok_or(MhiError::Overflow)?;
    pool.cumulative_payouts_lamports = pool.cumulative_payouts_lamports
        .checked_add(total_refunds)
        .ok_or(MhiError::Overflow)?;

    // Decrement outstanding_p2p_positions. close_cohort gates on this.
    let cohort = &mut ctx.accounts.cohort;
    cohort.outstanding_p2p_positions = cohort.outstanding_p2p_positions
        .checked_sub(settled_count)
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
