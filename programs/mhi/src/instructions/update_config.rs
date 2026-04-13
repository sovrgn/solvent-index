use anchor_lang::prelude::*;

use crate::constants::GLOBAL_STATE_SEED;
use crate::errors::MhiError;
use crate::events::ConfigUpdated;
use crate::state::GlobalState;

/// Optional fields for config updates. None = no change.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct UpdateConfigParams {
    pub keeper: Option<Pubkey>,
    pub mhi_cap_bps: Option<u32>,
    pub premium_fee_bps: Option<u16>,
    pub referral_share_bps: Option<u16>,
    pub keeper_fee_lamports: Option<u64>,
    pub min_position_lamports: Option<u64>,
    pub min_premium_lamports: Option<u64>,
    /// DEPRECATED: Field was never enforced on-chain. Ignored if set.
    pub max_position_per_address_bps: Option<u16>,
    pub max_vault_risk_per_cohort_bps: Option<u16>,
    pub max_position_collateral_bps: Option<u16>,
    pub trading_window_seconds: Option<u32>,
    pub measurement_seconds: Option<u32>,
    pub observation_seconds: Option<u32>,
    pub settlement_deadline_seconds: Option<u32>,
    pub claim_expiry_seconds: Option<u32>,
    pub mhi_floor_bps: Option<u32>,
    pub mhi_max_delta_bps: Option<u32>,
    pub paused: Option<bool>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
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
}

pub fn handler(ctx: Context<UpdateConfig>, params: UpdateConfigParams) -> Result<()> {
    let gs = &mut ctx.accounts.global_state;

    if let Some(v) = params.keeper {
        require!(v != Pubkey::default(), MhiError::InvalidConfig);
        gs.keeper = v;
    }
    if let Some(v) = params.mhi_cap_bps {
        require!(v > 0, MhiError::InvalidConfig);
        gs.mhi_cap_bps = v;
    }
    if let Some(v) = params.premium_fee_bps {
        require!(v <= 1_000, MhiError::InvalidConfig); // max 10%
        gs.premium_fee_bps = v;
    }
    if let Some(v) = params.referral_share_bps {
        require!(v <= 5_000, MhiError::InvalidConfig); // max 50% of fee
        gs.referral_share_bps = v;
    }
    if let Some(v) = params.keeper_fee_lamports {
        require!(v <= 1_000_000_000, MhiError::InvalidConfig); // max 1 SOL
        gs.keeper_fee_lamports = v;
    }
    if let Some(v) = params.min_position_lamports {
        require!(v > 0 && v <= 1_000_000_000, MhiError::InvalidConfig); // 1 lamport to 1 SOL
        gs.min_position_lamports = v;
    }
    if let Some(v) = params.min_premium_lamports {
        require!(v <= 1_000_000_000, MhiError::InvalidConfig); // max 1 SOL (0 = disabled)
        gs.min_premium_lamports = v;
    }
    // max_position_per_address_bps: DEPRECATED - silently ignored.
    // Field kept in struct for account layout compatibility.
    if let Some(v) = params.max_vault_risk_per_cohort_bps {
        require!(v <= 5_000, MhiError::InvalidConfig); // max 50% of vault per cohort
        gs.max_vault_risk_per_cohort_bps = v;
    }
    if let Some(v) = params.max_position_collateral_bps {
        require!(v <= 10_000, MhiError::InvalidConfig); // max 100% of cohort cap (effectively disabled)
        gs.max_position_collateral_bps = v;
    }
    if let Some(v) = params.trading_window_seconds {
        require!(v >= 30 && v <= 3_600, MhiError::InvalidConfig); // 30s to 1h
        gs.trading_window_seconds = v;
    }
    if let Some(v) = params.measurement_seconds {
        require!(v >= 60 && v <= 7_200, MhiError::InvalidConfig); // 1m to 2h
        gs.measurement_seconds = v;
    }
    if let Some(v) = params.observation_seconds {
        require!(v >= 30 && v <= 3_600, MhiError::InvalidConfig); // 30s to 1h
        gs.observation_seconds = v;
    }
    if let Some(v) = params.settlement_deadline_seconds {
        require!(v >= 60 && v <= 86_400, MhiError::InvalidConfig); // 1m to 24h
        gs.settlement_deadline_seconds = v;
    }
    if let Some(v) = params.claim_expiry_seconds {
        require!(v >= 3_600 && v <= 604_800, MhiError::InvalidConfig); // 1h to 7d
        gs.claim_expiry_seconds = v;
    }
    if let Some(v) = params.mhi_floor_bps {
        require!(v <= 10_000, MhiError::InvalidConfig); // max 1.0x floor
        gs.mhi_floor_bps = v;
    }
    if let Some(v) = params.mhi_max_delta_bps {
        require!(v >= 1_000 && v <= 10_000, MhiError::InvalidConfig); // 10%-100% max change
        gs.mhi_max_delta_bps = v;
    }
    if let Some(v) = params.paused {
        gs.paused = v;
    }

    emit!(ConfigUpdated {
        authority: ctx.accounts.authority.key(),
    });

    Ok(())
}
