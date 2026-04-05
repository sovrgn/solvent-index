/// PDA seeds
pub const GLOBAL_STATE_SEED: &[u8] = b"global_state";
pub const VAULT_SEED: &[u8] = b"vault";
pub const COHORT_SEED: &[u8] = b"cohort";
pub const EMA_STATE_SEED: &[u8] = b"ema_state";
pub const POSITION_SEED: &[u8] = b"position";
pub const P2P_POSITION_SEED: &[u8] = b"p2p_position";
pub const P2P_POOL_SEED: &[u8] = b"p2p_pool";
pub const WRITER_ACCOUNT_SEED: &[u8] = b"writer_account";

/// Basis points denominator: 10_000 = 100%
pub const BPS_DENOMINATOR: u32 = 10_000;

/// Maximum number of strikes supported
pub const NUM_STRIKES: usize = 7;

/// Default strike ladder (in BPS): 1.0x, 1.1x, 1.2x, 1.3x, 1.5x, 1.8x, 2.0x
pub const DEFAULT_STRIKES_BPS: [u32; NUM_STRIKES] = [10_000, 11_000, 12_000, 13_000, 15_000, 18_000, 20_000];

/// Default MHI cap: 3.0x = 30_000 BPS
pub const MHI_CAP_BPS_DEFAULT: u32 = 30_000;

/// Base option-premium markup applied on top of the fair premium.
/// Cold-start-amplified during the first COLD_START_COHORTS, then steady at this value.
pub const BASE_MARKUP_BPS: u16 = 2_000;

/// EMA alpha values (in BPS of BPS_DENOMINATOR)
/// fast_alpha = 0.15 = 1_500 / 10_000
pub const FAST_ALPHA_BPS: u32 = 1_500;
/// slow_alpha = 0.035 = 350 / 10_000
pub const SLOW_ALPHA_BPS: u32 = 350;
/// fast complement: 1 - 0.15 = 0.85 = 8_500 / 10_000
pub const FAST_COMPLEMENT_BPS: u32 = 8_500;
/// slow complement: 1 - 0.035 = 0.965 = 9_650 / 10_000
pub const SLOW_COMPLEMENT_BPS: u32 = 9_650;

/// Markup bounds (in BPS)
pub const MARKUP_MIN_BPS: u16 = 500; // 5%
pub const MARKUP_MAX_BPS: u16 = 5_000; // 50%
pub const MARKUP_DEFAULT_BPS: u16 = 2_000; // 20%
pub const MARKUP_STEP_BPS: u16 = 200; // 2% adjustment per cohort

/// Utilization thresholds (in BPS)
pub const UTILIZATION_HIGH_BPS: u16 = 9_000; // 90%
pub const UTILIZATION_LOW_BPS: u16 = 3_000; // 30%

/// Cold start parameters
pub const COLD_START_COHORTS: u64 = 50;
/// Extra markup during cold start: 50% = 5_000 BPS
pub const COLD_START_EXTRA_BPS: u32 = 5_000;

/// Default timing parameters (seconds)
pub const DEFAULT_TRADING_WINDOW_SECS: u32 = 180; // 3 minutes
pub const DEFAULT_MEASUREMENT_SECS: u32 = 900; // 15 minutes
pub const DEFAULT_OBSERVATION_SECS: u32 = 300; // 5 minutes
pub const DEFAULT_SETTLEMENT_DEADLINE_SECS: u32 = 1_800; // 30 minutes
pub const DEFAULT_CLAIM_EXPIRY_SECS: u32 = 86_400; // 24 hours

/// Default fee parameters
pub const DEFAULT_PREMIUM_FEE_BPS: u16 = 150; // 1.5%
pub const DEFAULT_REFERRAL_SHARE_BPS: u16 = 3_000; // 30% of volume fee
pub const DEFAULT_KEEPER_FEE_LAMPORTS: u64 = 10_000; // 0.00001 SOL
pub const DEFAULT_MIN_POSITION_LAMPORTS: u64 = 10_000_000; // 0.01 SOL

/// Per-strike demand markup bounds (Option A: between cohorts)
pub const STRIKE_DEMAND_MIN_BPS: u16 = 0;       // 0% floor
pub const STRIKE_DEMAND_MAX_BPS: u16 = 5_000;   // 50% ceiling
pub const STRIKE_DEMAND_DEFAULT_BPS: u16 = 500;  // 5% starting point
pub const STRIKE_DEMAND_STEP_BPS: u16 = 100;     // 1% adjustment per cohort
pub const STRIKE_SHARE_HIGH_BPS: u16 = 5_000;    // >50% of volume = high demand
pub const STRIKE_SHARE_LOW_BPS: u16 = 1_000;     // <10% of volume = low demand

/// Intra-cohort bonding curve (Option B: within trading window)
pub const BONDING_MAX_SURGE_BPS: u16 = 2_000;    // 20% max surge at full utilization
pub const DEFAULT_MAX_POSITION_PER_ADDRESS_BPS: u16 = 2_000; // 20%
pub const DEFAULT_MAX_VAULT_RISK_PER_COHORT_BPS: u16 = 1_500; // 15%
pub const DEFAULT_MAX_POSITION_COLLATERAL_BPS: u16 = 500; // 5% of cohort cap (0.75% of vault)
pub const DEFAULT_MANAGEMENT_FEE_BPS: u16 = 1_500; // 15%
pub const DEFAULT_P2P_BUYER_FEE_BPS: u16 = 500;   // 5%
pub const DEFAULT_P2P_WRITER_FEE_BPS: u16 = 2_000;  // 20%

/// Minimum cohort tokens for a valid cohort
pub const MIN_COHORT_TOKENS: u16 = 10;

/// MHI absolute floor: 0.1x - circuit breaker cannot go below this
pub const MHI_ABSOLUTE_FLOOR_BPS: u32 = 1_000;

/// Account version for future migrations
pub const ACCOUNT_VERSION: u8 = 1;
