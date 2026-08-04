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

/// Default MHI cap: 3.0x = 30_000 BPS
pub const MHI_CAP_BPS_DEFAULT: u32 = 30_000;

/// Base option-premium markup applied on top of the fair premium.
/// Cold-start-amplified during the first COLD_START_COHORTS, then steady at this value.
/// Mirrors keeper's `emaBaseMarkupBps` default in ema-pricer-config.ts.
pub const EMA_BASE_MARKUP_BPS: u16 = 2_000;

/// Floor for the BPS-rate charged in buy_call. When the EMA is cold or every
/// markup layer is zero, charge at least this much of position size. Mirrors
/// keeper's `minPremiumBps` default (0.5%) in ema-pricer-config.ts.
pub const MIN_PREMIUM_BPS_FLOOR: u32 = 50;

/// Strike anchor multipliers (in BPS). Per-cohort strikes = floor(anchor * multiplier[i] / 10_000).
/// Mirrors `STRIKE_MULTIPLIERS` in keeper/lib/constants.ts. Must stay sorted ascending.
pub const STRIKE_MULTIPLIERS_BPS: [u32; NUM_STRIKES] = [9_000, 9_500, 10_000, 10_500, 11_000, 12_000, 13_000];

/// Strike anchor EMA alpha (in BPS). 0.3 = 3_000 / 10_000. Fast adaptation (~2 round half-life).
pub const STRIKE_ANCHOR_ALPHA_BPS: u32 = 3_000;
/// Strike anchor EMA complement: 1 - alpha = 7_000 / 10_000.
pub const STRIKE_ANCHOR_COMPLEMENT_BPS: u32 = 7_000;
/// Cold-start anchor when no settlements have happened yet. 1.25x.
pub const STRIKE_ANCHOR_DEFAULT_BPS: u32 = 12_500;
/// Floor below which derived strikes would degenerate. 0.2x.
pub const STRIKE_ANCHOR_MIN_BPS: u32 = 2_000;

/// Largest entry in `STRIKE_MULTIPLIERS_BPS`. Named separately because the
/// anchor ceiling below is derived from it; if the ladder ever gains a higher
/// slot this must move with it (asserted in `math::ema` tests).
pub const MAX_STRIKE_MULTIPLIER_BPS: u32 = 13_000;

/// Minimum payoff room the TOP strike must retain under `mhi_cap_bps`. 0.2x.
///
/// Every payoff and collateral path computes `cap_bps - strike_bps`. A strike
/// at or above the cap makes that subtraction underflow, and a strike just
/// below the cap produces an option that can never pay enough to matter. The
/// anchor is therefore ceilinged so `top_strike + this <= cap` always holds.
pub const MIN_TOP_STRIKE_HEADROOM_BPS: u32 = 2_000;

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

pub const DEFAULT_MAX_POSITION_PER_ADDRESS_BPS: u16 = 2_000; // 20%
/// Per-cohort risk cap (BPS of pool total). Applied identically to vault and P2P pool.
/// 2_000 = 20%: in the worst case where every position pays max payoff, only this
/// fraction of each pool is at risk for one cohort.
pub const DEFAULT_MAX_VAULT_RISK_PER_COHORT_BPS: u16 = 2_000; // 20%
/// Vault-to-P2P position ratio: for every N vault positions, 1 goes to P2P.
/// 4 = 80/20 split. Rule: route to P2P when `vault_positions >= (p2p_positions + 1) * VAULT_TO_P2P_RATIO`.
pub const VAULT_TO_P2P_RATIO: u32 = 4;
pub const DEFAULT_MAX_POSITION_COLLATERAL_BPS: u16 = 500; // 5% of cohort cap (0.75% of vault)
pub const DEFAULT_MANAGEMENT_FEE_BPS: u16 = 1_500; // 15%
pub const DEFAULT_P2P_BUYER_FEE_BPS: u16 = 500;   // 5%
pub const DEFAULT_P2P_WRITER_FEE_BPS: u16 = 2_000;  // 20%

/// Minimum cohort tokens for a valid cohort
pub const MIN_COHORT_TOKENS: u16 = 10;

/// MHI absolute floor: 0.1x - circuit breaker cannot go below this
pub const MHI_ABSOLUTE_FLOOR_BPS: u32 = 1_000;

/// Account version for future migrations
pub const ACCOUNT_VERSION: u8 = 2;
