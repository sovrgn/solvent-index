use anchor_lang::prelude::*;

use crate::constants::WRITER_ACCOUNT_SEED;
use crate::errors::MhiError;
use crate::state::WriterAccount;

/// Close a WriterAccount when the writer has 0 shares and wants to leave.
/// Rent refund goes to the writer.
#[derive(Accounts)]
pub struct CloseWriterAccount<'info> {
    #[account(
        mut,
        constraint = writer.key() == writer_account.writer @ MhiError::UnauthorizedAuthority,
    )]
    pub writer: Signer<'info>,

    #[account(
        mut,
        seeds = [WRITER_ACCOUNT_SEED, writer.key().as_ref()],
        bump = writer_account.bump,
        constraint = writer_account.shares == 0 @ MhiError::InsufficientWriterCollateral,
        close = writer,
    )]
    pub writer_account: Account<'info, WriterAccount>,
}

pub fn handler(_ctx: Context<CloseWriterAccount>) -> Result<()> {
    // Anchor's `close = writer` handles everything:
    // - Zeroes account data
    // - Transfers remaining lamports (rent) to writer
    // - Assigns account to system program
    Ok(())
}
