# MHI Protocol — Integration Test Matrix

Every test below must be implemented. Each section covers one instruction:
its happy path, every error path, and edge cases from audits.

---

## 1. initialize

### Happy Path
- [ ] Creates GlobalState, Vault, EmaState with correct values from config
- [ ] EMA strikes initialized with provided initial_ema_values
- [ ] Vault has 0 available, 0 active_collateral, 0 unclaimed
- [ ] GlobalState status is Idle, cohort_index 0, paused false
- [ ] pending_authority is Pubkey::default()
- [ ] mhi_max_delta_bps is 3300, mhi_floor_bps is 2000

### Error Paths
- [ ] Fails if called twice (PDA already exists — Anchor init constraint)
- [ ] Fails with mhi_cap_bps = 0 → InvalidConfig
- [ ] Fails with trading_window_seconds = 0 → InvalidConfig
- [ ] Fails with measurement_seconds = 0 → InvalidConfig
- [ ] Fails with observation_seconds = 0 → InvalidConfig
- [ ] Fails with settlement_deadline_seconds = 0 → InvalidConfig
- [ ] Fails with claim_expiry_seconds = 0 → InvalidConfig
- [ ] Fails with min_position_lamports = 0 → InvalidConfig

### Edge Cases
- [ ] Very large config values (u32::MAX for timing) — should succeed
- [ ] Keeper set to authority's own address — should succeed
- [ ] initial_ema_values all 0 — succeeds but buy_call will reject (premium=0)

---

## 2. update_config

### Happy Path
- [ ] Authority can update keeper address
- [ ] Authority can update multiple params in one call
- [ ] Params set to None are not changed
- [ ] Emits ConfigUpdated event

### Error Paths
- [ ] Non-authority signer → UnauthorizedAuthority
- [ ] premium_fee_bps = 1001 (>10%) → InvalidConfig
- [ ] referral_share_bps = 5001 (>50%) → InvalidConfig
- [ ] keeper_fee_lamports = 1_000_000_001 (>1 SOL) → InvalidConfig
- [ ] min_position_lamports = 0 → InvalidConfig
- [ ] min_position_lamports = 1_000_000_001 (>1 SOL) → InvalidConfig
- [ ] max_vault_risk_per_cohort_bps = 5001 (>50%) → InvalidConfig
- [ ] trading_window_seconds = 29 (<30s) → InvalidConfig
- [ ] trading_window_seconds = 3601 (>1h) → InvalidConfig
- [ ] measurement_seconds = 59 (<1m) → InvalidConfig
- [ ] measurement_seconds = 7201 (>2h) → InvalidConfig
- [ ] observation_seconds = 29 (<30s) → InvalidConfig
- [ ] observation_seconds = 3601 (>1h) → InvalidConfig
- [ ] settlement_deadline_seconds = 59 (<1m) → InvalidConfig
- [ ] settlement_deadline_seconds = 86401 (>24h) → InvalidConfig
- [ ] claim_expiry_seconds = 3599 (<1h) → InvalidConfig
- [ ] claim_expiry_seconds = 604801 (>7d) → InvalidConfig
- [ ] mhi_floor_bps = 10001 (>100%) → InvalidConfig
- [ ] mhi_max_delta_bps = 999 (<10%) → InvalidConfig
- [ ] mhi_max_delta_bps = 10001 (>100%) → InvalidConfig

### Edge Cases
- [ ] All params None — succeeds, nothing changes
- [ ] Update config while cohort is active — succeeds (config change doesn't affect active cohort)
- [ ] Set paused = true, then try start_cohort → ProtocolPaused

---

## 3. propose_authority / accept_authority / cancel_authority_transfer

### Happy Path
- [ ] Authority proposes new address → pending_authority set
- [ ] New authority accepts → authority changes, pending_authority cleared
- [ ] Authority cancels proposal → pending_authority cleared
- [ ] Emits AuthorityTransferred event on accept

### Error Paths
- [ ] Non-authority calls propose → UnauthorizedAuthority
- [ ] Propose Pubkey::default() → InvalidConfig
- [ ] Wrong signer calls accept (not pending_authority) → UnauthorizedAuthority
- [ ] Accept with no pending proposal (pending = default) → InvalidConfig
- [ ] Non-authority calls cancel → UnauthorizedAuthority
- [ ] Old authority calls update_config after transfer → UnauthorizedAuthority

### Edge Cases
- [ ] Propose, cancel, propose different address, accept — final authority is the second proposal
- [ ] Propose same address as current authority — succeeds (no-op but valid)

---

## 4. seed_vault

### Happy Path
- [ ] Authority seeds vault with 1 SOL — available_lamports increases, protocol_seed_lamports increases
- [ ] Vault lamport balance matches tracked total + rent
- [ ] Multiple seeds accumulate correctly

### Error Paths
- [ ] Non-authority signer → UnauthorizedAuthority
- [ ] Amount = 0 → SeedAmountZero
- [ ] Authority has insufficient SOL → system_program transfer fails

### Edge Cases
- [ ] Seed during active cohort — succeeds, new collateral available immediately
- [ ] Seed very small amount (1 lamport) — succeeds

---

## 5. sync_vault

### Happy Path
- [ ] After direct SOL transfer to vault PDA, sync_vault recovers surplus into available_lamports
- [ ] No surplus (tracked == actual - rent) — no change

### Error Paths
- [ ] Non-authority signer → UnauthorizedAuthority

### Edge Cases
- [ ] Call sync_vault when no surplus exists — succeeds, no change
- [ ] Call sync_vault after seed_vault — no surplus (seed_vault already tracked it)

---

## 6. start_cohort

### Happy Path
- [ ] Keeper starts cohort — Cohort PDA created with Trading status
- [ ] GlobalState transitions to Active
- [ ] total_cohorts increments by 1
- [ ] Deadlines are correctly computed from current clock + config params
- [ ] Emits CohortStarted event

### Error Paths
- [ ] Non-keeper signer → UnauthorizedKeeper
- [ ] Protocol paused → ProtocolPaused
- [ ] Previous cohort not resolved (status Active) → PreviousCohortNotResolved
- [ ] Cohort PDA already exists for this index (shouldn't happen due to Idle check)

### Edge Cases
- [ ] Start cohort immediately after previous settles — succeeds
- [ ] Start first cohort (index 0) — succeeds
- [ ] Keeper has very low SOL balance (barely enough for rent) — succeeds if rent covered

---

## 7. buy_call

### Happy Path
- [ ] Buyer purchases 1.0x call with 0.5 SOL size — Position PDA created
- [ ] Premium computed correctly (EMA * markup, ceil rounding)
- [ ] Vault: available decreases by collateral, active_collateral increases
- [ ] Vault: available increases by premium received
- [ ] Cohort: total_positions increments, total_call_volume increases
- [ ] Position: owner, cohort, strike, size, premium, vault_premium all set correctly
- [ ] Emits CallPurchased event

### Happy Path — Referral
- [ ] Buy with referrer in remaining_accounts — referrer receives cut, vault receives remainder
- [ ] referral_payout + vault_premium == premium
- [ ] Event includes referrer pubkey and referral_payout

### Error Paths
- [ ] Protocol paused → ProtocolPaused
- [ ] Cohort not in Trading status → InvalidCohortStatus
- [ ] Clock past trading_deadline → TradingWindowClosed
- [ ] size_lamports = 0 → PositionSizeZero
- [ ] size_lamports < min_position_lamports → PositionTooSmall
- [ ] Invalid strike (not in EMA set) → InvalidStrike
- [ ] Premium = 0 (EMAs at 0) → PremiumBelowFloor
- [ ] Vault insufficient collateral → InsufficientVaultCollateral
- [ ] Vault risk cap exceeded → InsufficientVaultCollateral
- [ ] Buyer has insufficient SOL for premium → system_program transfer fails
- [ ] Duplicate nonce (Position PDA already exists) → Anchor init fails

### Edge Cases
- [ ] Buy at minimum position size (0.01 SOL) — premium rounds up to at least 1 lamport
- [ ] Buy at each of the 5 strikes — all succeed with correct premiums
- [ ] Multiple positions same buyer, same strike, different nonces — all succeed
- [ ] Multiple positions same buyer, different strikes — all succeed
- [ ] Buy that exactly exhausts vault available_lamports — succeeds
- [ ] Buy that exactly hits vault risk cap — succeeds
- [ ] Buy with referrer = buyer's own address (self-referral) — succeeds
- [ ] Buy with referrer but referral_share_bps = 0 — no referral transfer
- [ ] Cold-start markup (first 50 cohorts) — premium is higher than base

---

## 8. submit_mhi

### Happy Path
- [ ] Keeper submits MHI after observation window — Cohort.mhi_bps set to clamped value
- [ ] EMA state updated for all strikes
- [ ] Markup adjusted based on utilization
- [ ] GlobalState.last_mhi_bps updated
- [ ] GlobalState.total_volume_lamports updated
- [ ] Emits MhiSubmitted event with clamped value

### Happy Path — Clamp
- [ ] First cohort (last_mhi=0) — value passes through unclamped
- [ ] Value within 33% of last_mhi — passes through unclamped
- [ ] Value exceeds +33% of last_mhi — clamped to upper bound
- [ ] Value below -33% of last_mhi — clamped to lower bound

### Error Paths
- [ ] Non-keeper signer → UnauthorizedKeeper
- [ ] Cohort not in Trading/Measuring status → InvalidCohortStatus
- [ ] Clock before trading_deadline → TradingWindowOpen
- [ ] Clock before observation_end → ObservationNotComplete
- [ ] MHI already submitted (mhi_bps > 0) → MhiAlreadySubmitted
- [ ] mhi_bps = 0 → MhiZero
- [ ] mhi_bps > mhi_cap_bps → clamped to the cohort cap, tx succeeds (MhiExceedsCap is no longer thrown)
- [ ] token_count < MIN_COHORT_TOKENS (10) → InvalidConfig

### Edge Cases
- [ ] Submit exactly at observation_end timestamp — succeeds
- [ ] Submit with empty cohort (0 positions) — succeeds
- [ ] Submit MHI = mhi_cap_bps (maximum) — succeeds (may be clamped)
- [ ] Index sustained above the cap across cohorts — every cohort settles, stored MHI pins at the cap
- [ ] Submit MHI = 1 (minimum) — succeeds (may be clamped)
- [ ] Clamp disabled (mhi_max_delta_bps = 0) — passes through raw value
- [ ] Sequential cohorts: verify clamp walks toward target over multiple submissions

---

## 9. settle_batch

### Happy Path
- [ ] Keeper settles all positions in one batch — all marked settled, payouts computed
- [ ] ITM position: payout = capped_payoff * size (floor division)
- [ ] OTM position: payout = 0
- [ ] ATM position: payout = 0
- [ ] Vault: active_collateral decreases, unclaimed_payouts increases by payout
- [ ] Vault: available increases by (collateral - payout)
- [ ] Cohort: positions_settled increments per position
- [ ] When all settled: cohort → Settled, GlobalState → Idle, cohort_index increments
- [ ] Emits PositionSettled event per position

### Happy Path — Multi-Batch
- [ ] Settle positions in 2 separate calls — both succeed, final call triggers Settled
- [ ] First call transitions Measuring → Settling
- [ ] Second call completes with Settling → Settled

### Happy Path — Permissionless After Deadline
- [ ] After settlement_deadline, non-keeper can call settle_batch — succeeds
- [ ] Before settlement_deadline, non-keeper cannot → SettlementDeadlineNotReached

### Error Paths
- [ ] MHI not submitted → MhiNotSubmitted
- [ ] Cohort not in Measuring/Settling → InvalidCohortStatus
- [ ] Before deadline, non-keeper caller → SettlementDeadlineNotReached
- [ ] Empty remaining_accounts with positions > 0 → NoPositionsProvided
- [ ] Position from wrong cohort in remaining_accounts → CohortMismatch
- [ ] Position account not owned by program → CohortMismatch

### Edge Cases
- [ ] Already-settled position in remaining_accounts — silently skipped (idempotent)
- [ ] Empty cohort (0 positions), empty remaining_accounts — transitions to Settled immediately
- [ ] Position at maximum cap payoff (MHI = cap) — payout = (cap - strike) * size
- [ ] Position with very small size (min_position) — payout may be 0 due to rounding
- [ ] MHI exactly at strike — payout = 0 (ATM has no intrinsic value)
- [ ] Collateral released matches collateral locked (ceil rounding matches)

---

## 10. claim

### Happy Path
- [ ] Owner claims settled position — payout transferred from vault to owner
- [ ] Position PDA closed, rent refunded to caller
- [ ] Vault: unclaimed_payouts decreases by payout
- [ ] Vault conservation check passes (tracked <= lamports)
- [ ] Emits PayoutClaimed event

### Happy Path — Third-Party Claim
- [ ] Non-owner calls claim — payout goes to owner, rent goes to caller
- [ ] Owner's lamport balance increases by payout, caller's by rent

### Error Paths
- [ ] Position not settled → NotSettled
- [ ] Double claim attempt — second call fails because PDA no longer exists (Anchor deserialization error, not AlreadyClaimed)
- [ ] Clock past claim_deadline → ClaimExpired

### Edge Cases
- [ ] Claim with payout = 0 (OTM position) — succeeds, no SOL transferred, PDA closed
- [ ] Claim immediately after settlement — succeeds (within deadline)
- [ ] Claim at clock = claim_deadline - 1 — succeeds (just before expiry)
- [ ] Claim at clock = claim_deadline — fails (>= not <)

---

## 11. expire_position

### Happy Path
- [ ] After claim deadline, anyone expires position — unclaimed payout returns to vault available
- [ ] Position PDA closed, rent refunded to caller
- [ ] Vault: unclaimed_payouts decreases, available increases
- [ ] Emits PositionExpired event

### Error Paths
- [ ] Position not settled → NotSettled
- [ ] Position already claimed (PDA gone) — Anchor deserialization error
- [ ] Clock before claim_deadline → ClaimNotExpired

### Edge Cases
- [ ] Expire position with payout = 0 — succeeds, no vault accounting change, PDA closed
- [ ] Expire at clock = claim_deadline exactly — succeeds (>= check)
- [ ] Expire position that was never claimed (owner forgot) — succeeds, payout → vault

---

## 12. close_cohort

### Happy Path
- [ ] After claim expiry, anyone closes settled cohort PDA — rent refunded to caller
- [ ] Cohort PDA no longer exists

### Error Paths
- [ ] Cohort not resolved (status Trading/Measuring/Settling) → InvalidCohortStatus
- [ ] Clock before settlement_deadline + claim_expiry → ClaimNotExpired

### Edge Cases
- [ ] Close voided cohort (after recovery + claim expiry) — succeeds
- [ ] Close cohort immediately after last position claimed — may fail if claim_expiry not passed
- [ ] Attempt to reference closed cohort in claim/expire — Anchor deserialization fails (account gone)

---

## 13. void_cohort

### Happy Path
- [ ] Authority voids cohort after recovery_deadline — collateral released, positions refunded
- [ ] Each position's vault_premium_lamports moved from available to unclaimed
- [ ] Positions marked settled with payout = vault_premium (for claim/refund)
- [ ] Cohort → Voided, GlobalState → Idle, cohort_index increments
- [ ] Emits CohortVoided event

### Happy Path — With Referrals
- [ ] Position that used referrer — refund is vault_premium (not full premium), no underflow

### Error Paths
- [ ] Non-authority signer → UnauthorizedAuthority
- [ ] Cohort already resolved (Settled/Voided) → CohortAlreadyResolved
- [ ] MHI already submitted → MhiAlreadySubmitted
- [ ] Positions already settled > 0 → PositionsAlreadySettled
- [ ] Clock before recovery_deadline → RecoveryDeadlineNotReached
- [ ] Position from wrong cohort → CohortMismatch
- [ ] Position not owned by program → CohortMismatch

### Edge Cases
- [ ] Void with empty remaining_accounts — succeeds (collateral released, no refunds processed)
- [ ] Void cohort with 0 positions — succeeds
- [ ] Void then claim the refund — buyer calls claim on voided position, receives vault_premium back
- [ ] Void with multiple positions, some with referral some without — correct refund amounts

---

## Cross-Instruction State Attacks

### Ordering Exploits
- [ ] Call settle_batch on an already-Settled cohort → InvalidCohortStatus
- [ ] Call settle_batch on a Voided cohort → InvalidCohortStatus
- [ ] Call submit_mhi on a Settled cohort → InvalidCohortStatus
- [ ] Call submit_mhi on a Voided cohort → InvalidCohortStatus
- [ ] Call buy_call after trading deadline (status still Trading, clock past) → TradingWindowClosed
- [ ] Call buy_call on Measuring status cohort → InvalidCohortStatus
- [ ] Call void_cohort after submit_mhi (MHI blocks void) → MhiAlreadySubmitted
- [ ] Call void_cohort before recovery_deadline but after settlement_deadline → RecoveryDeadlineNotReached
- [ ] Call start_cohort while positions from previous cohort are unclaimed — succeeds (Idle after settle completes)

### Vault Accounting Consistency
- [ ] After buy_call: vault.available + vault.active_collateral + vault.unclaimed == vault.lamports - rent
- [ ] After settle_batch: same invariant holds
- [ ] After claim: same invariant holds
- [ ] After expire_position: same invariant holds
- [ ] After void_cohort: same invariant holds
- [ ] After seed_vault: same invariant holds
- [ ] After full lifecycle (buy → settle → claim): vault.active_collateral == 0, vault.unclaimed == 0
- [ ] Vault available after full cycle = initial_seed + premiums_collected - payouts_distributed

### Position PDA Integrity
- [ ] Same user, same strike, same nonce, different cohort — distinct PDAs (no collision)
- [ ] Position PDA does not exist after claim (Anchor close)
- [ ] Position PDA does not exist after expire_position (Anchor close)
- [ ] Cannot re-create a closed position PDA with same seeds (init fails — account owned by system program with 0 lamports... actually init succeeds for a zeroed system-owned account. Test this.)

### Referral Edge Cases
- [ ] Referrer account not writable — no referral transfer (referral_payout = 0)
- [ ] Referrer is a PDA owned by another program — transfer succeeds (SOL goes to any account)
- [ ] Volume fee = 0 (tiny premium) — referral_payout = 0, no transfer attempted
- [ ] void_cohort refund on position with referral: refund = vault_premium (less than premium_paid)
- [ ] void_cohort refund on position without referral: refund = vault_premium == premium_paid

### Timing Boundary Tests
- [ ] buy_call at clock = trading_deadline - 1 → succeeds
- [ ] buy_call at clock = trading_deadline → fails (>= check in submit, < check in buy)
- [ ] submit_mhi at clock = observation_end - 1 → fails
- [ ] submit_mhi at clock = observation_end → succeeds
- [ ] settle_batch by non-keeper at clock = settlement_deadline - 1 → fails
- [ ] settle_batch by non-keeper at clock = settlement_deadline → succeeds
- [ ] claim at clock = claim_deadline - 1 → succeeds
- [ ] claim at clock = claim_deadline → fails (< not <=)
- [ ] expire_position at clock = claim_deadline - 1 → fails
- [ ] expire_position at clock = claim_deadline → succeeds (>= check)
- [ ] void_cohort at clock = recovery_deadline - 1 → fails
- [ ] void_cohort at clock = recovery_deadline → succeeds
- [ ] close_cohort at clock = (settlement_deadline + claim_expiry) - 1 → fails
- [ ] close_cohort at clock = (settlement_deadline + claim_expiry) → succeeds

---

## Full Lifecycle Tests

### Happy Path — Complete Cycle
- [ ] initialize → seed_vault → start_cohort → buy_call → submit_mhi → settle_batch → claim → close_cohort
- [ ] Verify vault balance correct at every step
- [ ] Verify GlobalState cohort_index increments correctly
- [ ] Verify vault conservation invariant holds throughout

### Multiple Cohorts Sequential
- [ ] Run 3 complete cohorts back-to-back
- [ ] Verify EMA converges toward empirical payoffs
- [ ] Verify markup adjusts based on utilization
- [ ] Verify cohort_index increments: 0, 1, 2

### Void Path
- [ ] initialize → seed_vault → start_cohort → buy_call → (keeper dies) → void_cohort → claim refund
- [ ] Verify buyer receives vault_premium back
- [ ] Verify vault collateral fully released

### Mixed Outcomes
- [ ] Multiple positions at different strikes, some ITM some OTM
- [ ] Verify each position gets correct payout
- [ ] Verify vault net P&L matches: premiums collected - payouts distributed

### Clamp Walkthrough
- [ ] Run 5 cohorts with MHI steadily increasing — verify clamp allows gradual rise
- [ ] Submit extreme MHI after stable history — verify it's clamped
- [ ] Disable clamp (mhi_max_delta_bps=0) — verify raw value used

### Expire Then Reclaim Path
- [ ] initialize → seed → start → buy → submit → settle → (wait 24h) → expire_position → verify payout returned to vault.available
- [ ] Verify vault.unclaimed decreases and vault.available increases by exact payout amount

### Vault Solvency Through Adversarial Cohort
- [ ] Seed vault 10 SOL → buy max positions at 1.0x strike → submit MHI at cap (2.5x) → settle → claim all
- [ ] Verify vault can pay all claims (collateral was sufficient)
- [ ] Verify vault.available = seed + premiums - payouts (may be negative in extreme case — verify it doesn't underflow)

### Stress Test
- [ ] 50+ positions in a single cohort, settled in multiple batches
- [ ] Positions at all 5 strikes simultaneously
- [ ] Verify vault accounting after all settled and claimed

---

## Permission Tests (Every Instruction)

- [ ] initialize: only works with fresh PDAs
- [ ] update_config: only authority
- [ ] propose_authority: only authority
- [ ] accept_authority: only pending_authority
- [ ] cancel_authority_transfer: only authority
- [ ] seed_vault: only authority
- [ ] sync_vault: only authority
- [ ] start_cohort: only keeper, only when idle, only when unpaused
- [ ] submit_mhi: only keeper
- [ ] buy_call: anyone (when trading window open)
- [ ] settle_batch: keeper before deadline, anyone after
- [ ] claim: anyone (payout always to owner)
- [ ] expire_position: anyone (after claim deadline)
- [ ] close_cohort: anyone (after settlement + claim expiry)
- [ ] void_cohort: only authority
