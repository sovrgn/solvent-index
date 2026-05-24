use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::{
    COHORT_SEED, EMA_BASE_MARKUP_BPS, EMA_STATE_SEED, GLOBAL_STATE_SEED, MIN_PREMIUM_BPS_FLOOR,
    P2P_POOL_SEED, P2P_POSITION_SEED, VAULT_SEED, VAULT_TO_P2P_RATIO,
};
use crate::errors::MhiError;
use crate::math::bps::mul_bps_u16;
use crate::math::ema::{cold_start_markup, fair_payoff_bps};
use crate::math::payoff::total_collateral_lamports_ceil;
use crate::math::premium::{charged_premium_bps, premium_lamports};
use crate::state::{Cohort, EmaState, GlobalState, P2pPool, P2pPosition, Vault};

#[derive(Accounts)]
#[instruction(strike_bps: u32, size_lamports: u64, nonce: u8)]
pub struct BuyCallP2p<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
        constraint = !global_state.paused @ MhiError::ProtocolPaused,
        constraint = global_state.p2p_enabled @ MhiError::P2pNotEnabled,
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

    #[account(
        seeds = [EMA_STATE_SEED],
        bump = ema_state.bump,
    )]
    pub ema_state: Account<'info, EmaState>,

    #[account(
        init,
        payer = buyer,
        space = P2pPosition::SPACE,
        seeds = [
            P2P_POSITION_SEED,
            cohort.key().as_ref(),
            buyer.key().as_ref(),
            strike_bps.to_le_bytes().as_ref(),
            &[nonce],
        ],
        bump,
    )]
    pub p2p_position: Account<'info, P2pPosition>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<BuyCallP2p>,
    strike_bps: u32,
    size_lamports: u64,
    nonce: u8,
) -> Result<()> {
    let gs = &ctx.accounts.global_state;
    let clock = Clock::get()?;

    // Sync pool lamports in case of direct transfers (donation attack mitigation)
    {
        let pool_info = ctx.accounts.p2p_pool.to_account_info();
        let rent = Rent::get()?;
        let rent_exempt = rent.minimum_balance(pool_info.data_len());
        let pool = &mut ctx.accounts.p2p_pool;
        pool.sync_lamports(pool_info.lamports(), rent_exempt);
    }

    require!(ctx.accounts.cohort.is_trading(), MhiError::InvalidCohortStatus);
    require!(clock.unix_timestamp < ctx.accounts.cohort.trading_deadline, MhiError::TradingWindowClosed);
    require!(size_lamports > 0, MhiError::PositionSizeZero);
    require!(size_lamports >= gs.min_position_lamports, MhiError::PositionTooSmall);

    let strike_idx = ctx
        .accounts
        .cohort
        .strikes
        .iter()
        .position(|&s| s == strike_bps)
        .ok_or(MhiError::InvalidStrike)?;

    // Use the cohort's at-start cap snapshot, not the current global cap.
    // An authority `update_config { mhi_cap_bps }` mid-trading must not
    // retroactively change collateral / premium ceilings for this cohort.
    let mhi_cap_bps = ctx.accounts.cohort.mhi_cap_bps_at_start;

    let collateral = total_collateral_lamports_ceil(
        mhi_cap_bps, strike_bps, size_lamports,
    ).ok_or(MhiError::Overflow)?;

    // Routing gate: a P2P buy is allowed when EITHER
    //   (a) the vault cannot serve this position (full / over cap), OR
    //   (b) the 80/20 ratio rule says this position should go to P2P
    //       (vault_positions >= (p2p_positions + 1) * VAULT_TO_P2P_RATIO).
    // Otherwise reject with VaultNotFull — the client should call buy_call.
    {
        let vault_can_serve = if gs.max_vault_risk_per_cohort_bps > 0 {
            let vault_total = ctx.accounts.vault.available_lamports
                .checked_add(ctx.accounts.vault.active_collateral_lamports)
                .ok_or(MhiError::Overflow)?;
            let max_cohort = mul_bps_u16(vault_total, gs.max_vault_risk_per_cohort_bps)
                .ok_or(MhiError::Overflow)?;
            let remaining_cap = max_cohort.saturating_sub(ctx.accounts.cohort.vault_collateral_locked);
            remaining_cap >= collateral && ctx.accounts.vault.available_lamports >= collateral
        } else {
            ctx.accounts.vault.available_lamports >= collateral
        };

        let next_p2p = ctx.accounts.cohort.p2p_positions
            .checked_add(1)
            .ok_or(MhiError::Overflow)?;
        let ratio_threshold = (next_p2p as u64)
            .checked_mul(VAULT_TO_P2P_RATIO as u64)
            .ok_or(MhiError::Overflow)?;
        let ratio_wants_p2p = (ctx.accounts.cohort.total_positions as u64) >= ratio_threshold;

        require!(!vault_can_serve || ratio_wants_p2p, MhiError::VaultNotFull);
    }

    require!(
        ctx.accounts.p2p_pool.available_lamports >= collateral,
        MhiError::InsufficientWriterCollateral
    );

    // Enforce the same per-cohort risk cap on the P2P pool as on the vault.
    // Base is the pool's own (available + active_collateral) so a small pool
    // can't be flooded with collateral that exceeds its size.
    if gs.max_vault_risk_per_cohort_bps > 0 {
        let pool_total = ctx.accounts.p2p_pool.available_lamports
            .checked_add(ctx.accounts.p2p_pool.active_collateral_lamports)
            .ok_or(MhiError::Overflow)?;
        let p2p_max_cohort = mul_bps_u16(pool_total, gs.max_vault_risk_per_cohort_bps)
            .ok_or(MhiError::Overflow)?;
        let p2p_new_locked = ctx.accounts.cohort.p2p_collateral_locked
            .checked_add(collateral)
            .ok_or(MhiError::Overflow)?;
        require!(p2p_new_locked <= p2p_max_cohort, MhiError::P2pRiskCapExceeded);
    }

    let ema = &ctx.accounts.ema_state;
    let slot = &ema.slots[strike_idx];
    let fair_bps = fair_payoff_bps(slot.fast_frac_bps, slot.slow_frac_bps, gs.strike_anchor_bps)
        .ok_or(MhiError::Overflow)?;

    let cold_base_markup = cold_start_markup(EMA_BASE_MARKUP_BPS, gs.total_cohorts)
        .ok_or(MhiError::Overflow)?;
    let demand_markup = slot.demand_markup_bps;

    let total_markup_u32 = (cold_base_markup as u32)
        .checked_add(demand_markup as u32)
        .ok_or(MhiError::Overflow)?;
    let total_markup_u16 = u16::try_from(total_markup_u32).map_err(|_| MhiError::Overflow)?;

    let charged_bps_raw = charged_premium_bps(fair_bps, total_markup_u16)
        .ok_or(MhiError::Overflow)?;
    let max_payoff_bps = mhi_cap_bps.saturating_sub(strike_bps);
    let mut charged_bps = charged_bps_raw.min(max_payoff_bps);
    if charged_bps < MIN_PREMIUM_BPS_FLOOR {
        charged_bps = MIN_PREMIUM_BPS_FLOOR.min(max_payoff_bps);
    }
    let premium = premium_lamports(charged_bps, size_lamports)
        .ok_or(MhiError::Overflow)?;
    // Reject positions below minimum premium floor.
    // When min_premium_lamports is 0, this degrades to premium > 0 (cold start exploit prevention).
    require!(premium >= gs.min_premium_lamports.max(1), MhiError::PremiumBelowFloor);

    let buyer_fee = mul_bps_u16(premium, gs.p2p_buyer_fee_bps)
        .ok_or(MhiError::Overflow)?;
    let writer_fee = mul_bps_u16(premium, gs.p2p_writer_fee_bps)
        .ok_or(MhiError::Overflow)?;
    let total_buyer_cost = premium.checked_add(buyer_fee)
        .ok_or(MhiError::Overflow)?;
    let writer_share = premium.checked_sub(writer_fee)
        .ok_or(MhiError::Overflow)?;
    let protocol_share = buyer_fee.checked_add(writer_fee)
        .ok_or(MhiError::Overflow)?;


    // Buyer -> P2P pool (writer's share of premium)
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.p2p_pool.to_account_info(),
            },
        ),
        writer_share,
    )?;

    // Buyer -> Vault (protocol fees from both sides)
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        protocol_share,
    )?;

    let pool = &mut ctx.accounts.p2p_pool;
    pool.available_lamports = pool.available_lamports
        .checked_sub(collateral)
        .ok_or(MhiError::Overflow)?;
    pool.active_collateral_lamports = pool.active_collateral_lamports
        .checked_add(collateral)
        .ok_or(MhiError::Overflow)?;
    pool.available_lamports = pool.available_lamports
        .checked_add(writer_share)
        .ok_or(MhiError::Overflow)?;
    pool.cumulative_premiums_lamports = pool.cumulative_premiums_lamports
        .checked_add(writer_share)
        .ok_or(MhiError::Overflow)?;

    let vault = &mut ctx.accounts.vault;
    vault.available_lamports = vault.available_lamports
        .checked_add(protocol_share)
        .ok_or(MhiError::Overflow)?;
    vault.cumulative_premiums_lamports = vault.cumulative_premiums_lamports
        .checked_add(protocol_share)
        .ok_or(MhiError::Overflow)?;

    let cohort = &mut ctx.accounts.cohort;
    cohort.total_call_volume_lamports = cohort.total_call_volume_lamports
        .checked_add(size_lamports)
        .ok_or(MhiError::Overflow)?;
    cohort.p2p_positions = cohort.p2p_positions
        .checked_add(1)
        .ok_or(MhiError::Overflow)?;
    cohort.p2p_premiums_collected = cohort.p2p_premiums_collected
        .checked_add(premium)
        .ok_or(MhiError::Overflow)?;
    cohort.p2p_collateral_locked = cohort.p2p_collateral_locked
        .checked_add(collateral)
        .ok_or(MhiError::Overflow)?;
    cohort.strike_volume_lamports[strike_idx] = cohort.strike_volume_lamports[strike_idx]
        .checked_add(size_lamports)
        .ok_or(MhiError::Overflow)?;
    cohort.outstanding_p2p_positions = cohort.outstanding_p2p_positions
        .checked_add(1)
        .ok_or(MhiError::Overflow)?;

    let pos = &mut ctx.accounts.p2p_position;
    pos.bump = ctx.bumps.p2p_position;
    pos.owner = ctx.accounts.buyer.key();
    pos.cohort = ctx.accounts.cohort.key();
    pos.p2p_pool = ctx.accounts.p2p_pool.key();
    pos.strike_bps = strike_bps;
    pos.size_lamports = size_lamports;
    pos.premium_paid_lamports = total_buyer_cost;
    pos.writer_premium_lamports = writer_share;
    pos.nonce = nonce;
    pos.settled = false;
    pos.payout_lamports = 0;
    pos.claim_deadline = 0;
    pos.claimed = false;

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
