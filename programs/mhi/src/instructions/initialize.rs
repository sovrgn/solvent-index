use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::MhiError;
use crate::events::ProtocolInitialized;
use crate::state::{EmaState, GlobalState, SlotEma, Vault};

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeConfig {
    pub keeper: Pubkey,
    pub mhi_cap_bps: u32,
    pub premium_fee_bps: u16,
    pub referral_share_bps: u16,
    pub min_position_lamports: u64,
    pub min_premium_lamports: u64,
    pub trading_window_seconds: u32,
    pub measurement_seconds: u32,
    pub observation_seconds: u32,
    pub settlement_deadline_seconds: u32,
    pub claim_expiry_seconds: u32,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = GlobalState::SPACE,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        init,
        payer = authority,
        space = Vault::SPACE,
        seeds = [VAULT_SEED],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = authority,
        space = EmaState::SPACE,
        seeds = [EMA_STATE_SEED],
        bump,
    )]
    pub ema_state: Account<'info, EmaState>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, config: InitializeConfig) -> Result<()> {
    require!(config.mhi_cap_bps > 0, MhiError::InvalidConfig);
    require!(config.trading_window_seconds > 0, MhiError::InvalidConfig);
    require!(config.measurement_seconds > 0, MhiError::InvalidConfig);
    require!(config.observation_seconds > 0, MhiError::InvalidConfig);
    require!(config.settlement_deadline_seconds > 0, MhiError::InvalidConfig);
    require!(config.claim_expiry_seconds > 0, MhiError::InvalidConfig);
    require!(config.min_position_lamports > 0, MhiError::InvalidConfig);
    require!(config.keeper != Pubkey::default(), MhiError::InvalidConfig);

    // Initialize GlobalState
    let gs = &mut ctx.accounts.global_state;
    gs.version = ACCOUNT_VERSION;
    gs.bump = ctx.bumps.global_state;
    gs.authority = ctx.accounts.authority.key();
    gs.pending_authority = Pubkey::default();
    gs.keeper = config.keeper;
    gs.mhi_cap_bps = config.mhi_cap_bps;
    gs.premium_fee_bps = config.premium_fee_bps;
    gs.keeper_fee_lamports = DEFAULT_KEEPER_FEE_LAMPORTS;
    gs.min_position_lamports = config.min_position_lamports;
    gs.min_premium_lamports = config.min_premium_lamports;
    gs._deprecated_max_position_per_address_bps = DEFAULT_MAX_POSITION_PER_ADDRESS_BPS;
    gs.max_vault_risk_per_cohort_bps = DEFAULT_MAX_VAULT_RISK_PER_COHORT_BPS;
    gs.max_position_collateral_bps = 0; // disabled by default, set via update_config
    gs.referral_share_bps = config.referral_share_bps;
    gs.trading_window_seconds = config.trading_window_seconds;
    gs.measurement_seconds = config.measurement_seconds;
    gs.observation_seconds = config.observation_seconds;
    gs.settlement_deadline_seconds = config.settlement_deadline_seconds;
    gs.claim_expiry_seconds = config.claim_expiry_seconds;
    // MHI circuit breaker - Drift-style clamp
    gs.mhi_floor_bps = 2_000; // advisory, for off-chain alerting
    gs.mhi_max_delta_bps = 3_300; // 33% max change per cohort
    gs.last_mhi_bps = 0; // no history - first cohort is unclamped
    gs.current_cohort_index = 0;
    gs.active_cohorts = 0;
    gs.total_cohorts = 0;
    gs.total_volume_lamports = 0;
    gs.paused = false;
    gs.p2p_buyer_fee_bps = DEFAULT_P2P_BUYER_FEE_BPS;
    gs.p2p_writer_fee_bps = DEFAULT_P2P_WRITER_FEE_BPS;
    gs.p2p_enabled = false;
    // Strike anchor: cold-start default until the first settlement lands.
    // The cold-start markup amplifies premium during the first 50 cohorts so
    // even a zero EMA produces a non-zero charge (combined with
    // min_premium_lamports floor in buy_call).
    gs.strike_anchor_bps = STRIKE_ANCHOR_DEFAULT_BPS;
    gs.strike_anchor_settlement_count = 0;

    // Initialize Vault
    let vault = &mut ctx.accounts.vault;
    vault.version = ACCOUNT_VERSION;
    vault.bump = ctx.bumps.vault;
    vault.available_lamports = 0;
    vault.active_collateral_lamports = 0;
    vault.unclaimed_payouts_lamports = 0;
    vault.cumulative_premiums_lamports = 0;
    vault.cumulative_payouts_lamports = 0;
    vault.total_deposits_lamports = 0;
    vault.total_shares = 0;
    vault.protocol_seed_lamports = 0;
    vault.protocol_shares = 0;
    vault.management_fee_bps = DEFAULT_MANAGEMENT_FEE_BPS;
    vault.min_vault_balance_lamports = 0;
    vault.accepting_deposits = false;

    // Initialize EmaState with empty fractional slots. Cold-start markup
    // carries the launch period; there is no zero-premium exploit because
    // buy_call enforces premium >= max(min_premium_lamports, 1).
    let ema = &mut ctx.accounts.ema_state;
    ema.version = ACCOUNT_VERSION;
    ema.bump = ctx.bumps.ema_state;
    ema.markup_bps = MARKUP_DEFAULT_BPS; // deprecated, retained for layout
    ema.last_updated_cohort = 0;
    for slot in ema.slots.iter_mut() {
        *slot = SlotEma {
            fast_frac_bps: 0,
            slow_frac_bps: 0,
            demand_markup_bps: STRIKE_DEMAND_DEFAULT_BPS,
        };
    }

    emit!(ProtocolInitialized {
        authority: ctx.accounts.authority.key(),
        keeper: config.keeper,
    });

    Ok(())
}
