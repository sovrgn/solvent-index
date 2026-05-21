import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  setupProtocol,
  startCohort,
  buyCall,
  submitMhi,
  settleBatch,
  warpPastObservation,
  assertVaultConservation,
  TestCtx,
  SOL,
  MHI_CAP_BPS,
  DEFAULT_STRIKES_BPS,
} from "./_setup";

/**
 * Regression coverage for N-01: `mhi_cap_bps` is snapshotted on the Cohort
 * at start_cohort. `update_config { mhi_cap_bps }` between buy and settle
 * must NOT corrupt the in-flight cohort's collateral accounting or payouts.
 *
 * Pre-fix behavior at `029949f`-era code:
 *   - buy_call reads cap_live → locks (cap_live - strike) * size of collateral.
 *   - settle_batch reads cap_live → releases (cap_new - strike) * size.
 *   - If cap_new > cap_old: vault.active_collateral.checked_sub underflows
 *     → cohort permanently stuck in Settling.
 *
 * Post-fix:
 *   - Cohort.mhi_cap_bps_at_start is set at start_cohort.
 *   - Every consumer (buy/settle/void) reads from the snapshot.
 *   - update_config { mhi_cap_bps } only affects cohorts started AFTER the change.
 */
async function callUpdateConfig(
  t: TestCtx,
  mhiCapBps: number,
): Promise<void> {
  await t.program.methods
    .updateConfig({
      keeper: null,
      mhiCapBps,
      premiumFeeBps: null,
      referralShareBps: null,
      keeperFeeLamports: null,
      minPositionLamports: null,
      minPremiumLamports: null,
      maxPositionPerAddressBps: null,
      maxVaultRiskPerCohortBps: null,
      maxPositionCollateralBps: null,
      tradingWindowSeconds: null,
      measurementSeconds: null,
      observationSeconds: null,
      settlementDeadlineSeconds: null,
      claimExpirySeconds: null,
      mhiFloorBps: null,
      mhiMaxDeltaBps: null,
      paused: null,
    } as any)
    .accounts({
      authority: t.authority.publicKey,
      globalState: t.globalState,
    } as any)
    .signers([t.authority])
    .rpc();
}

describe("28 - cap snapshot (N-01 regression)", () => {
  let t: TestCtx;

  beforeEach(async () => {
    t = await setupProtocol();
  });

  it("start_cohort writes mhi_cap_bps_at_start = current gs.mhi_cap_bps", async () => {
    const cohort = await startCohort(t);
    const c = await t.program.account.cohort.fetch(cohort);
    expect(c.mhiCapBpsAtStart).to.equal(MHI_CAP_BPS);
  });

  it("cohort snapshot unchanged after authority raises global cap mid-cohort", async () => {
    const cohort = await startCohort(t);
    const newCap = MHI_CAP_BPS * 2;

    await callUpdateConfig(t, newCap);

    const gs = await t.program.account.globalState.fetch(t.globalState);
    expect(gs.mhiCapBps).to.equal(newCap);

    const c = await t.program.account.cohort.fetch(cohort);
    expect(c.mhiCapBpsAtStart).to.equal(MHI_CAP_BPS); // snapshot unchanged
  });

  it("settle_batch succeeds against the original cap after authority doubled gs.mhi_cap_bps", async () => {
    const cohort = await startCohort(t);
    // ATM strike under the cold-start anchor (12_500 BPS). Default strikes[2] = 12_500.
    const pos = await buyCall(t, cohort, { strikeBps: DEFAULT_STRIKES_BPS[2], size: SOL(0.05) });

    // Authority doubles the cap AFTER positions were bought.
    // Pre-fix: settle_batch would compute release = (new_cap - strike) * size,
    // which exceeds the lock from buy_call and underflows active_collateral.
    await callUpdateConfig(t, MHI_CAP_BPS * 2);

    await warpPastObservation(t.context);
    await submitMhi(t, cohort, DEFAULT_STRIKES_BPS[2] + 2_000); // 2_000 BPS ITM
    await settleBatch(t, cohort, [pos]);

    const settled = await t.program.account.position.fetch(pos);
    expect(settled.settled).to.equal(true);

    // Payout uses the cohort snapshot, so it cannot exceed
    // (snapshot_cap - strike) * size / BPS_DENOMINATOR.
    const maxPayoutBps = MHI_CAP_BPS - DEFAULT_STRIKES_BPS[2];
    const maxPayoutLamports = (settled.sizeLamports.toNumber() * maxPayoutBps) / 10_000;
    expect(settled.payoutLamports.toNumber()).to.be.at.most(Math.floor(maxPayoutLamports));

    await assertVaultConservation(t);
  });

  it("settle_batch releases collateral against snapshot, not lowered live cap", async () => {
    // Buy at original cap, then lower the global cap, then settle.
    //
    // submit_mhi enforces `mhi_bps <= gs.mhi_cap_bps` (live cap), so we can't
    // submit above the lowered cap. But we CAN exercise the collateral-release
    // path: collateral was locked at the snapshot cap and must be released at
    // the snapshot cap. Pre-fix (live cap path): release = (lowered - strike) *
    // size, which is less than the lock; the delta sticks in active_collateral
    // and the position's payout is also under-capped.
    const cohort = await startCohort(t);
    const strike = DEFAULT_STRIKES_BPS[2]; // 12_500
    const size = SOL(0.05);
    const pos = await buyCall(t, cohort, { strikeBps: strike, size });

    const vaultBefore = await t.program.account.vault.fetch(t.vault);
    const lockedSnap = vaultBefore.activeCollateralLamports.toNumber();

    // Lower the cap to just above the submit value so submit_mhi's guard passes.
    // strike=12_500, we'll submit mhi=15_000 (2_500 BPS ITM). loweredCap must be >= 15_000.
    const loweredCap = 16_000;
    await callUpdateConfig(t, loweredCap);

    const c = await t.program.account.cohort.fetch(cohort);
    expect(c.mhiCapBpsAtStart).to.equal(MHI_CAP_BPS); // snapshot unchanged

    await warpPastObservation(t.context);
    await submitMhi(t, cohort, strike + 2_500);
    await settleBatch(t, cohort, [pos]);

    // Vault active_collateral must drop to 0 — full release matched the lock.
    // Pre-fix (live cap): would release only (16_000 - 12_500) * size / 10_000
    // and leave residue in active_collateral_lamports.
    const vaultAfter = await t.program.account.vault.fetch(t.vault);
    expect(vaultAfter.activeCollateralLamports.toNumber()).to.equal(0);

    // Payout uses ITM amount (2_500 BPS) since snapshot cap is not binding.
    const settled = await t.program.account.position.fetch(pos);
    const expectedPayout = Math.floor((size.toNumber() * 2_500) / 10_000);
    expect(settled.payoutLamports.toNumber()).to.equal(expectedPayout);

    // Confirm the lock-amount equality (sanity, not the fix-specific assertion).
    const expectedLock = Math.ceil((size.toNumber() * (MHI_CAP_BPS - strike)) / 10_000);
    expect(lockedSnap).to.equal(expectedLock);

    await assertVaultConservation(t);
  });

  it("new cohorts started after a cap change use the new cap", async () => {
    const cohortA = await startCohort(t);

    const newCap = MHI_CAP_BPS + 5_000;
    await callUpdateConfig(t, newCap);

    const cohortB = await startCohort(t);

    const a = await t.program.account.cohort.fetch(cohortA);
    const b = await t.program.account.cohort.fetch(cohortB);
    expect(a.mhiCapBpsAtStart).to.equal(MHI_CAP_BPS);
    expect(b.mhiCapBpsAtStart).to.equal(newCap);
  });
});
