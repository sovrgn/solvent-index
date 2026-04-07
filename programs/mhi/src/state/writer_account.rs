use anchor_lang::prelude::*;

/// Per-writer tracking account. Tracks shares owned and withdrawal state.
/// Writers deposit SOL into the P2pPool and receive shares proportionally.
///
/// PDA seeds: [b"writer_account", writer_pubkey]
#[account]
pub struct WriterAccount {
    pub bump: u8,
    /// The writer's wallet
    pub writer: Pubkey,
    /// Shares owned in the P2pPool
    pub shares: u64,
    /// Total lamports ever deposited (for tracking, not accounting)
    pub total_deposited_lamports: u64,
    /// Total lamports ever withdrawn (for tracking)
    pub total_withdrawn_lamports: u64,
}

impl WriterAccount {
    pub const SPACE: usize = 8  // discriminator
        + 1   // bump
        + 32  // writer
        + 8   // shares
        + 8   // total_deposited_lamports
        + 8;  // total_withdrawn_lamports
}
