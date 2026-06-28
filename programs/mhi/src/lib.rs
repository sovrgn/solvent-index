use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("6WMM7hg5JKN6RrwL15qVtRUTZQb3jEoZpiwsPFLyDGG");

#[program]
pub mod mhi {
    use super::*;


    pub fn initialize(ctx: Context<Initialize>, config: InitializeConfig) -> Result<()> {
        instructions::initialize::handler(ctx, config)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, params: UpdateConfigParams) -> Result<()> {
        instructions::update_config::handler(ctx, params)
    }

    pub fn seed_vault(ctx: Context<SeedVault>, amount: u64) -> Result<()> {
        instructions::seed_vault::handler(ctx, amount)
    }

    pub fn sync_vault(ctx: Context<SyncVault>) -> Result<()> {
        instructions::sync_vault::handler(ctx)
    }


    pub fn propose_authority(ctx: Context<ProposeAuthority>, new_authority: Pubkey) -> Result<()> {
        instructions::transfer_authority::propose_handler(ctx, new_authority)
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        instructions::transfer_authority::accept_handler(ctx)
    }

    pub fn cancel_authority_transfer(ctx: Context<CancelAuthorityTransfer>) -> Result<()> {
        instructions::transfer_authority::cancel_handler(ctx)
    }


    pub fn start_cohort(
        ctx: Context<StartCohort>,
        strikes: [u32; crate::constants::NUM_STRIKES],
    ) -> Result<()> {
        instructions::start_cohort::handler(ctx, strikes)
    }

    pub fn submit_mhi(
        ctx: Context<SubmitMhi>,
        mhi_bps: u32,
        token_count: u16,
        cohort_hash: [u8; 32],
    ) -> Result<()> {
        instructions::submit_mhi::handler(ctx, mhi_bps, token_count, cohort_hash)
    }


    pub fn buy_call<'info>(
        ctx: Context<'_, '_, 'info, 'info, BuyCall<'info>>,
        strike_bps: u32,
        size_lamports: u64,
        nonce: u8,
    ) -> Result<()> {
        instructions::buy_call::handler(ctx, strike_bps, size_lamports, nonce)
    }


    pub fn settle_batch(ctx: Context<SettleBatch>) -> Result<()> {
        instructions::settle_batch::handler(ctx)
    }


    // `claim`, `expire_position`, `claim_p2p`, and `expire_p2p_position`
    // were all removed: settle_batch and settle_batch_p2p (and the matching
    // void instructions) now pay the owner directly inside the same tx, and
    // mark the position PDA settled+claimed. There is no post-settle state
    // for the user to act on.
    //
    // close_position / close_p2p_position reclaim the PDA's ~0.002 SOL rent
    // for whoever calls them (preserving third-party cleanup incentive
    // analogous to the old expire instructions, without the obsolete
    // forfeit-payout semantics).

    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        instructions::close_position::handler(ctx)
    }

    pub fn close_p2p_position(ctx: Context<CloseP2pPosition>) -> Result<()> {
        instructions::close_p2p_position::handler(ctx)
    }


    pub fn close_cohort(ctx: Context<CloseCohort>) -> Result<()> {
        instructions::close_cohort::handler(ctx)
    }


    pub fn withdraw_vault(ctx: Context<WithdrawVault>, amount: u64) -> Result<()> {
        instructions::withdraw_vault::handler(ctx, amount)
    }


    pub fn void_cohort(ctx: Context<VoidCohort>) -> Result<()> {
        instructions::void_cohort::handler(ctx)
    }

    pub fn void_p2p_positions<'info>(ctx: Context<'_, '_, 'info, 'info, VoidP2pPositions<'info>>) -> Result<()> {
        instructions::void_p2p_positions::handler(ctx)
    }


    pub fn update_p2p_config(ctx: Context<UpdateP2pConfig>, params: UpdateP2pConfigParams) -> Result<()> {
        instructions::update_p2p_config::handler(ctx, params)
    }

    pub fn init_p2p_pool(ctx: Context<InitP2pPool>) -> Result<()> {
        instructions::init_p2p_pool::handler(ctx)
    }

    pub fn close_writer_account(ctx: Context<CloseWriterAccount>) -> Result<()> {
        instructions::close_writer_account::handler(ctx)
    }

    pub fn register_writer(ctx: Context<RegisterWriter>) -> Result<()> {
        instructions::register_writer::handler(ctx)
    }

    pub fn register_and_deposit(ctx: Context<RegisterAndDeposit>, amount: u64) -> Result<()> {
        instructions::register_and_deposit::handler(ctx, amount)
    }

    pub fn deposit_p2p(ctx: Context<DepositP2p>, amount: u64) -> Result<()> {
        instructions::deposit_p2p::handler(ctx, amount)
    }

    pub fn withdraw_p2p(ctx: Context<WithdrawP2p>, shares_to_burn: u64) -> Result<()> {
        instructions::withdraw_p2p::handler(ctx, shares_to_burn)
    }

    pub fn buy_call_p2p(ctx: Context<BuyCallP2p>, strike_bps: u32, size_lamports: u64, nonce: u8) -> Result<()> {
        instructions::buy_call_p2p::handler(ctx, strike_bps, size_lamports, nonce)
    }

    pub fn settle_batch_p2p<'info>(ctx: Context<'_, '_, 'info, 'info, SettleBatchP2p<'info>>) -> Result<()> {
        instructions::settle_batch_p2p::handler(ctx)
    }


}
