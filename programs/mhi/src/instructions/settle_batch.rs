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
    // Remaining accounts: (position, owner) pairs.
    //
    // For each position to settle, the caller passes the Position PDA followed
    // by the owner's wallet pubkey. The handler validates owner.key() ==
    // position.owner and transfers the payout to the owner directly in this
    // same tx — there is no separate `claim` step.
    //
    // The position PDA is NOT closed here. It stays alive marked settled+
    // claimed as a historical record (and so close_cohort knows there are
    // still position PDAs referencing this cohort). A separate permissionless
    // close_position cleanup sweeps the rent later.
    //
    // Each pair adds 2 accounts to the tx; batch limit ~25-30 positions per
    // tx given Solana's 64-account cap minus the 4 fixed accounts above.
}

pub fn handler(ctx: Context<SettleBatch>) -> Result<()> {
    let clock = Clock::get()?;

    // Read values we need before taking mutable references.
    // cap_bps comes from the cohort snapshot (set at start_cohort), not the
    // live global state — authority `update_config { mhi_cap_bps }` mid-flight
    // must not change the cap used to release collateral or cap payouts for
    // positions that locked against the at-start cap.
    let keeper = ctx.accounts.global_state.keeper;
    let cap_bps = ctx.accounts.cohort.mhi_cap_bps_at_start;
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

    // Empty-call is allowed iff the cohort has no positions (advances status
    // from Measuring → Settled). Otherwise require at least one (position,
    // owner) pair to prevent empty-call DOS.
    require!(
        !ctx.remaining_accounts.is_empty() || ctx.accounts.cohort.total_positions == 0,
        MhiError::NoPositionsProvided
    );

    // Pairs must be balanced; odd count is a caller bug.
    require!(
        ctx.remaining_accounts.len() % 2 == 0,
        MhiError::MalformedSettleAccounts
    );

    for chunk in ctx.remaining_accounts.chunks(2) {
        let position_ai = &chunk[0];
        let owner_ai = &chunk[1];

        // Verify account is owned by this program before deserializing.
        require!(
            position_ai.owner == ctx.program_id,
            MhiError::CohortMismatch
        );

        let mut data = position_ai.try_borrow_mut_data()?;
        let position = Position::try_deserialize(&mut &data[..])?;

        // Validate this position belongs to the cohort
        require!(
            position.cohort == cohort_key,
            MhiError::CohortMismatch
        );

        // Validate this position's PDA was derived from the expected seeds.
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
            position_ai.key() == expected_pda,
            MhiError::CohortMismatch
        );

        // The paired owner account MUST match this position's owner. The
        // payout transfer below sends SOL to whatever pubkey is passed; if
        // the caller could pass an arbitrary recipient, they'd steal payouts.
        require!(
            owner_ai.key() == position.owner,
            MhiError::OwnerMismatch
        );

        // Idempotent: skip already-settled positions (a retry that re-includes
        // an already-settled position must not double-pay).
        if position.settled {
            continue;
        }

        // Transition cohort to Settling on the first actual settlement.
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

        // Update vault accounting. Active collateral is always released; the
        // delta between collateral and payout returns to available. The
        // unclaimed_payouts bucket is no longer touched on this path because
        // the payout is sent directly to the owner below — there is nothing
        // left "unclaimed".
        let vault = &mut ctx.accounts.vault;
        vault.active_collateral_lamports = vault
            .active_collateral_lamports
            .checked_sub(position_collateral)
            .ok_or(MhiError::Overflow)?;

        if payout > 0 {
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

        // Update cohort tracking. outstanding_positions now means "positions
        // whose terminal state has not yet been resolved" (not settled and
        // not voided), so it can be decremented here even though the position
        // PDA stays alive. close_cohort gates on outstanding_positions == 0
        // so it can fire as soon as the last position settles. A separate
        // permissionless close_position retires the PDA rent later.
        let cohort = &mut ctx.accounts.cohort;
        cohort.vault_payouts_due = cohort
            .vault_payouts_due
            .checked_add(payout)
            .ok_or(MhiError::Overflow)?;
        cohort.positions_settled = cohort
            .positions_settled
            .checked_add(1)
            .ok_or(MhiError::Overflow)?;
        cohort.outstanding_positions = cohort
            .outstanding_positions
            .checked_sub(1)
            .ok_or(MhiError::Overflow)?;

        // Write the position back: marked settled AND claimed (the payout
        // has already left the vault below), and claim_deadline=0 because
        // there is no claim step. claimed=true also gates the future
        // close_position cleanup so the position can be retired by anyone.
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
            claim_deadline: 0,
            claimed: true,
        };
        let mut writer = &mut data[..];
        updated_position.try_serialize(&mut writer)?;
        drop(data);

        emit!(PositionSettled {
            cohort_index,
            owner: position.owner,
            strike_bps: position.strike_bps,
            size_lamports: position.size_lamports,
            payout_lamports: payout,
        });

        // Direct payout transfer from the vault PDA to the owner's wallet.
        // Direct lamport manipulation is safe because both accounts are
        // program-owned and mut-borrowable for the duration of this handler.
        if payout > 0 {
            **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= payout;
            **owner_ai.try_borrow_mut_lamports()? = owner_ai
                .lamports()
                .checked_add(payout)
                .ok_or(MhiError::Overflow)?;
        }
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
