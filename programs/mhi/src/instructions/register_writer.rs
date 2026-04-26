use anchor_lang::prelude::*;

use crate::constants::WRITER_ACCOUNT_SEED;
use crate::state::WriterAccount;

#[derive(Accounts)]
pub struct RegisterWriter<'info> {
    #[account(mut)]
    pub writer: Signer<'info>,

    #[account(
        init,
        payer = writer,
        space = WriterAccount::SPACE,
        seeds = [WRITER_ACCOUNT_SEED, writer.key().as_ref()],
        bump,
    )]
    pub writer_account: Account<'info, WriterAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RegisterWriter>) -> Result<()> {
    let wa = &mut ctx.accounts.writer_account;
    wa.bump = ctx.bumps.writer_account;
    wa.writer = ctx.accounts.writer.key();
    wa.shares = 0;
    wa.total_deposited_lamports = 0;
    wa.total_withdrawn_lamports = 0;
    Ok(())
}
