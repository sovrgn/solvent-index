use anchor_lang::prelude::*;

use crate::constants::{COHORT_SEED, GLOBAL_STATE_SEED, NUM_STRIKES, VAULT_SEED};
use crate::errors::MhiError;
use crate::events::CohortStarted;
use crate::math::ema::{clamp_anchor_for_cap, derive_strikes};
use crate::state::{Cohort, CohortStatus, GlobalState, Vault};

#[derive(Accounts)]
pub struct StartCohort<'info> {
    #[account(
        mut,
        constraint = keeper.key() == global_state.keeper @ MhiError::UnauthorizedKeeper,
    )]
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
        constraint = !global_state.paused @ MhiError::ProtocolPaused,
        constraint = global_state.can_start_cohort() @ MhiError::PreviousCohortNotResolved,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        seeds = [VAULT_SEED],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = keeper,
        space = Cohort::SPACE,
        seeds = [COHORT_SEED, global_state.current_cohort_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub cohort: Account<'info, Cohort>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<StartCohort>, strikes: [u32; NUM_STRIKES]) -> Result<()> {
    let gs = &mut ctx.accounts.global_state;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Verify the keeper-supplied strikes are exactly what the on-chain anchor
    // would derive. Strict equality — both sides use identical integer floor
    // and the same multiplier table, so there is no rounding-tolerance argument.
    // Catches: keeper running with a stale local anchor view (e.g., feeding raw
    // unclamped MHI into its local strike-anchor instead of the chain's clamped
    // value), or a mismatched multiplier constant.
    //
    // The anchor is ceilinged against the cap before derivation. `submit_mhi`
    // already stores a ceilinged anchor, so this is normally a no-op — it
    // matters for an anchor written before the ceiling existed, and after an
    // `update_config` that lowers `mhi_cap_bps` beneath the standing anchor.
    // Without it the ladder's top slot lands above the cap, `cap - strike`
    // underflows in settlement, and the cohort can never resolve.
    let effective_anchor = clamp_anchor_for_cap(gs.strike_anchor_bps, gs.mhi_cap_bps);
    let expected = derive_strikes(effective_anchor);
    require!(strikes == expected, MhiError::StrikesDoNotMatchAnchor);

    // The ladder is only settleable if every slot leaves payoff room under the
    // cap. Guaranteed by the clamp above; asserted so a future change to the
    // multiplier table or to `max_anchor_for_cap` cannot silently reintroduce
    // unsettleable cohorts.
    for i in 0..NUM_STRIKES {
        require!(strikes[i] < gs.mhi_cap_bps, MhiError::StrikeExceedsCap);
    }

    // Defense in depth: monotonic strikes are a property of `derive_strikes`
    // when no slot hits the floor. Asserting it in storage means downstream
    // code (settle, premium ladders) can rely on it without re-checking.
    for i in 1..NUM_STRIKES {
        require!(strikes[i] >= strikes[i - 1], MhiError::StrikesNotMonotonic);
    }

    let trading_deadline = now
        .checked_add(gs.trading_window_seconds as i64)
        .ok_or(MhiError::Overflow)?;
    let measurement_deadline = trading_deadline
        .checked_add(gs.measurement_seconds as i64)
        .ok_or(MhiError::Overflow)?;
    let observation_end = measurement_deadline
        .checked_add(gs.observation_seconds as i64)
        .ok_or(MhiError::Overflow)?;
    let settlement_deadline = observation_end
        .checked_add(gs.settlement_deadline_seconds as i64)
        .ok_or(MhiError::Overflow)?;
    let recovery_deadline = settlement_deadline
        .checked_add(gs.settlement_deadline_seconds as i64)
        .ok_or(MhiError::Overflow)?;

    let cohort = &mut ctx.accounts.cohort;
    cohort.bump = ctx.bumps.cohort;
    cohort.index = gs.current_cohort_index;
    cohort.status = CohortStatus::Trading;
    cohort.trading_start = now;
    cohort.trading_deadline = trading_deadline;
    cohort.measurement_deadline = measurement_deadline;
    cohort.settlement_deadline = settlement_deadline;
    cohort.recovery_deadline = recovery_deadline;
    cohort.mhi_bps = 0;
    cohort.token_count = 0;
    cohort.cohort_hash = [0u8; 32];
    cohort.total_call_volume_lamports = 0;
    cohort.total_positions = 0;
    cohort.positions_settled = 0;
    cohort.vault_collateral_locked = 0;
    cohort.vault_premiums_collected = 0;
    cohort.vault_payouts_due = 0;
    cohort.strike_volume_lamports = [0u64; NUM_STRIKES];
    cohort.p2p_collateral_locked = 0;
    cohort.p2p_premiums_collected = 0;
    cohort.p2p_payouts_due = 0;
    cohort.p2p_positions = 0;
    cohort.p2p_positions_settled = 0;
    cohort.p2p_strike_collateral = [0u64; NUM_STRIKES];
    cohort.positions_voided = 0;
    cohort.outstanding_positions = 0;
    cohort.outstanding_p2p_positions = 0;
    cohort.strikes = strikes;
    // Snapshot the anchor the ladder was actually derived from, not the raw
    // global one. `submit_mhi` uses this as the denominator that turns payoffs
    // into anchor-relative fractions; if it disagreed with the ladder the EMAs
    // would be scaled against an anchor that never priced these strikes.
    cohort.strike_anchor_bps_at_start = effective_anchor;
    cohort.mhi_cap_bps_at_start = gs.mhi_cap_bps;

    gs.active_cohorts = gs.active_cohorts.checked_add(1).ok_or(MhiError::Overflow)?;
    gs.current_cohort_index = gs.current_cohort_index.checked_add(1).ok_or(MhiError::Overflow)?;
    gs.total_cohorts = gs.total_cohorts.checked_add(1).ok_or(MhiError::Overflow)?;

    emit!(CohortStarted {
        index: cohort.index,
        trading_start: now,
        trading_deadline,
        strikes,
        strike_anchor_bps: cohort.strike_anchor_bps_at_start,
    });

    Ok(())
}
