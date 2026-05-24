use anchor_lang::prelude::*;

#[error_code]
pub enum MhiError {
    #[msg("Unauthorized: signer is not the authority")]
    UnauthorizedAuthority,

    #[msg("Unauthorized: signer is not the keeper")]
    UnauthorizedKeeper,

    #[msg("Protocol is paused")]
    ProtocolPaused,

    #[msg("Invalid cohort status for this operation")]
    InvalidCohortStatus,

    #[msg("Previous cohort must be settled or voided before starting a new one")]
    PreviousCohortNotResolved,

    #[msg("Cohort is already settled or voided")]
    CohortAlreadyResolved,

    #[msg("Trading window has closed")]
    TradingWindowClosed,

    #[msg("Trading window is still open")]
    TradingWindowOpen,

    #[msg("Measurement period has not completed")]
    MeasurementNotComplete,

    #[msg("Observation window has not completed")]
    ObservationNotComplete,

    #[msg("MHI has already been submitted for this cohort")]
    MhiAlreadySubmitted,

    #[msg("MHI has not been submitted for this cohort")]
    MhiNotSubmitted,

    #[msg("Position size is below minimum")]
    PositionTooSmall,

    #[msg("Position collateral exceeds per-position cap")]
    PositionTooLarge,

    #[msg("Position size is zero")]
    PositionSizeZero,

    #[msg("Per-address position cap exceeded for this cohort")]
    PositionCapExceeded,

    #[msg("Strike is not a valid strike from the EMA state")]
    InvalidStrike,

    #[msg("Strikes do not match the anchor-derived ladder")]
    StrikesDoNotMatchAnchor,

    #[msg("Strikes must be monotonically increasing")]
    StrikesNotMonotonic,

    #[msg("MHI value must be greater than zero")]
    MhiZero,

    #[msg("MHI value exceeds the cap")]
    MhiExceedsCap,

    // MhiOutOfBounds removed: on-chain MHI bounds would cause self-DOS
    // during black swan events. Keeper trust is the V1 model.

    #[msg("Insufficient available collateral in vault")]
    InsufficientVaultCollateral,

    #[msg("Vault balance invariant violated")]
    VaultBalanceMismatch,

    #[msg("Seed amount must be greater than zero")]
    SeedAmountZero,

    #[msg("Withdraw amount must be greater than zero")]
    WithdrawAmountZero,

    #[msg("Withdrawal would leave vault below minimum balance")]
    WithdrawBelowMinimum,

    #[msg("Position has already been settled")]
    AlreadySettled,

    #[msg("Position has not been settled yet")]
    NotSettled,

    #[msg("Position does not belong to this cohort")]
    CohortMismatch,

    #[msg("Settlement deadline has not passed (keeper-only before deadline)")]
    SettlementDeadlineNotReached,

    #[msg("No position accounts provided for settlement")]
    NoPositionsProvided,

    #[msg("Position has already been claimed")]
    AlreadyClaimed,

    #[msg("Claim window has expired")]
    ClaimExpired,

    #[msg("Claim window has not expired yet")]
    ClaimNotExpired,

    #[msg("Cannot void: some positions have already been settled")]
    PositionsAlreadySettled,

    #[msg("Recovery deadline has not been reached")]
    RecoveryDeadlineNotReached,

    #[msg("Arithmetic overflow")]
    Overflow,

    #[msg("Division by zero")]
    DivisionByZero,

    #[msg("On-chain invariant violation detected")]
    InvariantViolation,

    #[msg("Invalid configuration parameter")]
    InvalidConfig,

    #[msg("Premium floor not met")]
    PremiumBelowFloor,

    #[msg("Buyer has insufficient lamports")]
    InsufficientBuyerFunds,

    #[msg("P2P functionality is not enabled")]
    P2pNotEnabled,

    #[msg("Vault is not full - use buy_call for vault positions first")]
    VaultNotFull,

    #[msg("Writer has insufficient available collateral")]
    InsufficientWriterCollateral,

    #[msg("80/20 routing dictates this position goes to P2P - call buy_call_p2p instead")]
    RouteToP2p,

    #[msg("P2P pool risk cap exceeded for this cohort")]
    P2pRiskCapExceeded,


    #[msg("Referrer cannot be the buyer")]
    SelfReferral,

    #[msg("Position has not been settled yet")]
    PositionNotSettled,

    #[msg("Position has already been claimed")]
    PositionAlreadyClaimed,
}
