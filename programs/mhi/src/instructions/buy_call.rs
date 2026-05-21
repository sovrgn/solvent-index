use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::{
    COHORT_SEED, EMA_BASE_MARKUP_BPS, EMA_STATE_SEED, GLOBAL_STATE_SEED, MIN_PREMIUM_BPS_FLOOR,
    POSITION_SEED, VAULT_SEED,
};
use crate::errors::MhiError;
use crate::events::CallPurchased;
use crate::math::ema::{cold_start_markup, fair_payoff_bps};
use crate::math::payoff::total_collateral_lamports_ceil;
use crate::math::premium::{
    charged_premium_bps, premium_lamports, referral_split, volume_fee_lamports,
};
use crate::state::{Cohort, EmaState, GlobalState, Position, Vault};

#[derive(Accounts)]
#[instruction(strike_bps: u32, size_lamports: u64, nonce: u8)]
pub struct BuyCall<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
        constraint = !global_state.paused @ MhiError::ProtocolPaused,
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

    #[account(
        seeds = [EMA_STATE_SEED],
        bump = ema_state.bump,
    )]
    pub ema_state: Account<'info, EmaState>,

    #[account(
        init,
        payer = buyer,
        space = Position::SPACE,
        seeds = [
            POSITION_SEED,
            cohort.key().as_ref(),
            buyer.key().as_ref(),
            strike_bps.to_le_bytes().as_ref(),
            &[nonce],
        ],
        bump,
    )]
    pub position: Account<'info, Position>,

    pub system_program: Program<'info, System>,
    // Remaining accounts: optional referrer (AccountInfo, must be writable)
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, BuyCall<'info>>,
    strike_bps: u32,
    size_lamports: u64,
    nonce: u8,
) -> Result<()> {
    let gs = &ctx.accounts.global_state;
    let clock = Clock::get()?;


    // Must be in trading window
    require!(ctx.accounts.cohort.is_trading(), MhiError::InvalidCohortStatus);
    require!(clock.unix_timestamp < ctx.accounts.cohort.trading_deadline, MhiError::TradingWindowClosed);

    // Size validation
    require!(size_lamports > 0, MhiError::PositionSizeZero);
    require!(size_lamports >= gs.min_position_lamports, MhiError::PositionTooSmall);

    // Strike must be one of the slots set when the cohort started.
    let cohort_ref = &ctx.accounts.cohort;
    let strike_idx = cohort_ref
        .strikes
        .iter()
        .position(|&s| s == strike_bps)
        .ok_or(MhiError::InvalidStrike)?;

    // Fair payoff: max(fast_frac, slow_frac) * current_anchor / BPS_DENOM.
    // Uses the CURRENT global anchor (not the cohort snapshot) so quotes
    // track anchor moves caused by later cohorts settling during this one's
    // trading window.
    let ema = &ctx.accounts.ema_state;
    let slot = &ema.slots[strike_idx];
    let fair_bps = fair_payoff_bps(slot.fast_frac_bps, slot.slow_frac_bps, gs.strike_anchor_bps)
        .ok_or(MhiError::Overflow)?;

    // Layer 1: Base option-premium markup with cold-start amplification.
    let cold_base_markup = cold_start_markup(EMA_BASE_MARKUP_BPS, gs.total_cohorts)
        .ok_or(MhiError::Overflow)?;

    // Layer 2: Per-slot demand markup (adjusted between cohorts).
    let demand_markup = slot.demand_markup_bps;

    let total_markup_u32 = (cold_base_markup as u32)
        .checked_add(demand_markup as u32)
        .ok_or(MhiError::Overflow)?;
    let total_markup_u16 = u16::try_from(total_markup_u32).map_err(|_| MhiError::Overflow)?;

    // Use the cohort's at-start cap snapshot, not the current global cap.
    // An authority `update_config { mhi_cap_bps }` mid-trading must not
    // retroactively change collateral / premium ceilings for this cohort.
    let mhi_cap_bps = ctx.accounts.cohort.mhi_cap_bps_at_start;

    let charged_bps_raw = charged_premium_bps(fair_bps, total_markup_u16)
        .ok_or(MhiError::Overflow)?;
    // Cap charged BPS at the maximum payoff per unit (collateral cap, using
    // the cohort snapshot) and floor at MIN_PREMIUM_BPS_FLOOR. Mirrors
    // keeper's clamp in priceCallEMA — guarantees a non-zero charge even
    // when the EMA is cold.
    let max_payoff_bps = mhi_cap_bps.saturating_sub(strike_bps);
    let mut charged_bps = charged_bps_raw.min(max_payoff_bps);
    if charged_bps < MIN_PREMIUM_BPS_FLOOR {
        charged_bps = MIN_PREMIUM_BPS_FLOOR.min(max_payoff_bps);
    }

    // Premium in lamports (rounds UP)
    let premium = premium_lamports(charged_bps, size_lamports)
        .ok_or(MhiError::Overflow)?;

    // Reject positions below minimum premium floor.
    // When min_premium_lamports is 0, this degrades to premium > 0 (cold start exploit prevention).
    require!(premium >= gs.min_premium_lamports.max(1), MhiError::PremiumBelowFloor);


    let premium_fee_bps = gs.premium_fee_bps;
    let referral_share_bps = gs.referral_share_bps;

    // Collateral rounds UP
    let collateral = total_collateral_lamports_ceil(mhi_cap_bps, strike_bps, size_lamports)
        .ok_or(MhiError::Overflow)?;

    // Check vault has sufficient available collateral
    require!(
        ctx.accounts.vault.available_lamports >= collateral,
        MhiError::InsufficientVaultCollateral
    );

    // Enforce max vault risk per cohort.
    // Total collateral locked in this cohort must not exceed the risk cap.
    let max_risk_per_cohort_bps = gs.max_vault_risk_per_cohort_bps;
    if max_risk_per_cohort_bps > 0 {
        let vault_total = ctx.accounts.vault.available_lamports
            .checked_add(ctx.accounts.vault.active_collateral_lamports)
            .ok_or(MhiError::Overflow)?;
        let max_cohort_collateral = crate::math::bps::mul_bps_u16(vault_total, max_risk_per_cohort_bps)
            .ok_or(MhiError::Overflow)?;
        let new_cohort_locked = ctx.accounts.cohort.vault_collateral_locked
            .checked_add(collateral)
            .ok_or(MhiError::Overflow)?;
        require!(
            new_cohort_locked <= max_cohort_collateral,
            MhiError::InsufficientVaultCollateral
        );

        // Per-position collateral cap (optional, disabled when 0).
        // When enabled, prevents one whale from eating the entire cohort's capacity.
        // When disabled, the bonding curve's midpoint pricing naturally charges
        // whales more for taking large capacity.
        let max_pos_collateral_bps = gs.max_position_collateral_bps;
        if max_pos_collateral_bps > 0 {
            let max_pos_collateral = crate::math::bps::mul_bps_u16(max_cohort_collateral, max_pos_collateral_bps)
                .ok_or(MhiError::Overflow)?;
            require!(
                collateral <= max_pos_collateral,
                MhiError::PositionTooLarge
            );
        }
    }


    let volume_fee = volume_fee_lamports(premium, premium_fee_bps)
        .ok_or(MhiError::Overflow)?;

    let mut referral_payout = 0u64;
    let mut referrer_key: Option<Pubkey> = None;

    // Check remaining accounts for referrer
    if let Some(referrer_info) = ctx.remaining_accounts.first() {
        // Prevent self-referral fee extraction
        require!(
            referrer_info.key() != ctx.accounts.buyer.key(),
            MhiError::SelfReferral
        );
        if referrer_info.is_writable && referral_share_bps > 0 {
            let (ref_amount, _protocol_amount) =
                referral_split(volume_fee, referral_share_bps)
                    .ok_or(MhiError::Overflow)?;

            if ref_amount > 0 {
                // Transfer referral cut atomically
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        system_program::Transfer {
                            from: ctx.accounts.buyer.to_account_info(),
                            to: referrer_info.clone(),
                        },
                    ),
                    ref_amount,
                )?;
                referral_payout = ref_amount;
                referrer_key = Some(referrer_info.key());
            }
        }
    }

    // Record cohort key before mutable borrows
    let cohort_key = ctx.accounts.cohort.key();
    let cohort_index = ctx.accounts.cohort.index;


    let vault = &mut ctx.accounts.vault;

    // Lock collateral in vault
    vault.available_lamports = vault
        .available_lamports
        .checked_sub(collateral)
        .ok_or(MhiError::Overflow)?;
    vault.active_collateral_lamports = vault
        .active_collateral_lamports
        .checked_add(collateral)
        .ok_or(MhiError::Overflow)?;

    // Record premium (minus referral payout, which went directly to referrer)
    let vault_premium = premium
        .checked_sub(referral_payout)
        .ok_or(MhiError::Overflow)?;
    vault.available_lamports = vault
        .available_lamports
        .checked_add(vault_premium)
        .ok_or(MhiError::Overflow)?;
    vault.cumulative_premiums_lamports = vault
        .cumulative_premiums_lamports
        .checked_add(vault_premium)
        .ok_or(MhiError::Overflow)?;

    // Update cohort
    let cohort = &mut ctx.accounts.cohort;
    cohort.total_call_volume_lamports = cohort
        .total_call_volume_lamports
        .checked_add(size_lamports)
        .ok_or(MhiError::Overflow)?;
    // Track per-strike volume for demand-driven pricing
    cohort.strike_volume_lamports[strike_idx] = cohort.strike_volume_lamports[strike_idx]
        .checked_add(size_lamports)
        .ok_or(MhiError::Overflow)?;
    cohort.total_positions = cohort
        .total_positions
        .checked_add(1)
        .ok_or(MhiError::Overflow)?;
    cohort.vault_collateral_locked = cohort
        .vault_collateral_locked
        .checked_add(collateral)
        .ok_or(MhiError::Overflow)?;
    cohort.vault_premiums_collected = cohort
        .vault_premiums_collected
        .checked_add(vault_premium)
        .ok_or(MhiError::Overflow)?;
    cohort.outstanding_positions = cohort
        .outstanding_positions
        .checked_add(1)
        .ok_or(MhiError::Overflow)?;

    // Initialize position
    let position = &mut ctx.accounts.position;
    position.bump = ctx.bumps.position;
    position.owner = ctx.accounts.buyer.key();
    position.cohort = cohort_key;
    position.strike_bps = strike_bps;
    position.size_lamports = size_lamports;
    position.premium_paid_lamports = premium;
    position.vault_premium_lamports = vault_premium;
    position.nonce = nonce;
    position.settled = false;
    position.payout_lamports = 0;
    position.claim_deadline = 0;
    position.claimed = false;


    // Transfer premium (minus referral, which was already sent) to vault
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        vault_premium,
    )?;

    emit!(CallPurchased {
        cohort_index,
        buyer: ctx.accounts.buyer.key(),
        strike_bps,
        size_lamports,
        premium_paid: premium,
        referrer: referrer_key,
        referral_payout,
    });

    Ok(())
}
