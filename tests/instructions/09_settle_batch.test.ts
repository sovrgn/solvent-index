import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  setupProtocol,
  expectError,
  warpTime,
  warpPastObservation,
  startCohort,
  buyCall,
  submitMhi,
  settleBatch,
  claimPosition,
  runFullCohort,
  assertVaultConservation,
  findPositionPda,
  TestCtx,
  SOL,
  FAST_SETTLEMENT_DEADLINE,
} from "./_setup";

describe("09 - settle_batch", () => {
  let t: TestCtx;

  before(async () => {
    t = await setupProtocol();
  });


  it("settle all positions - all marked settled, payouts computed", async () => {
    const cohort = await startCohort(t);
    const pos1 = await buyCall(t, cohort, { strikeBps: 12_000 });
    const pos2 = await buyCall(t, cohort, { buyer: t.buyer2, strikeBps: 15_000 });
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, 14_000); // ITM for 12_000 strike, OTM for 15_000

    await settleBatch(t, cohort, [pos1, pos2]);

    const p1 = await t.program.account.position.fetch(pos1);
    const p2 = await t.program.account.position.fetch(pos2);
    expect(p1.settled).to.equal(true);
    expect(p2.settled).to.equal(true);
  });

  it("ITM position: payout > 0", async () => {
    // pos1 from above (strike 12_000, mhi 14_000) should be ITM
    // Re-fetch from the cohort we just settled - we need a fresh run
    const cohort = await startCohort(t);
    const pos = await buyCall(t, cohort, { strikeBps: 10_000 });
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, 14_000);
    await settleBatch(t, cohort, [pos]);

    const posData = await t.program.account.position.fetch(pos);
    expect(posData.payoutLamports.toNumber()).to.be.greaterThan(0);

    // Clean up
    await claimPosition(t, cohort, pos, t.buyer);
  });

  it("OTM position: payout = 0", async () => {
    const cohort = await startCohort(t);
    const pos = await buyCall(t, cohort, { strikeBps: 20_000 });
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, 14_000); // 14_000 < 20_000, OTM
    await settleBatch(t, cohort, [pos]);

    const posData = await t.program.account.position.fetch(pos);
    expect(posData.payoutLamports.toNumber()).to.equal(0);

    // Clean up
    await claimPosition(t, cohort, pos, t.buyer);
  });

  it("vault accounting: active_collateral decreases, unclaimed increases", async () => {
    const vaultBefore = await t.program.account.vault.fetch(t.vault);
    const collateralBefore = vaultBefore.activeCollateralLamports.toNumber();
    const unclaimedBefore = vaultBefore.unclaimedPayoutsLamports.toNumber();

    const cohort = await startCohort(t);
    const pos = await buyCall(t, cohort, { strikeBps: 10_000 });

    const vaultAfterBuy = await t.program.account.vault.fetch(t.vault);
    const collateralAfterBuy = vaultAfterBuy.activeCollateralLamports.toNumber();
    expect(collateralAfterBuy).to.be.greaterThan(collateralBefore);

    await warpPastObservation(t.context);
    await submitMhi(t, cohort, 14_000);
    await settleBatch(t, cohort, [pos]);

    const vaultAfterSettle = await t.program.account.vault.fetch(t.vault);
    expect(vaultAfterSettle.activeCollateralLamports.toNumber()).to.be.lessThan(collateralAfterBuy);
    expect(vaultAfterSettle.unclaimedPayoutsLamports.toNumber()).to.be.greaterThanOrEqual(unclaimedBefore);

    // Clean up
    await claimPosition(t, cohort, pos, t.buyer);
  });

  it("when all settled: cohort → Settled, globalState → Idle, cohort_index increments", async () => {
    const gsBefore = await t.program.account.globalState.fetch(t.globalState);
    const indexBefore = gsBefore.currentCohortIndex.toNumber();

    const cohort = await startCohort(t);
    const pos = await buyCall(t, cohort);
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, 14_000);
    await settleBatch(t, cohort, [pos]);

    const cohortData = await t.program.account.cohort.fetch(cohort);
    // Status should be Settled (check the enum variant)
    expect(JSON.stringify(cohortData.status)).to.include("settled");

    const gsAfter = await t.program.account.globalState.fetch(t.globalState);
    expect(JSON.stringify(gsAfter.currentCohortStatus)).to.include("idle");
    expect(gsAfter.currentCohortIndex.toNumber()).to.equal(indexBefore + 1);

    // Clean up
    await claimPosition(t, cohort, pos, t.buyer);
  });

  it("vault conservation holds after settle", async () => {
    const cohort = await startCohort(t);
    const pos = await buyCall(t, cohort);
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, 14_000);
    await settleBatch(t, cohort, [pos]);

    await assertVaultConservation(t);

    // Clean up
    await claimPosition(t, cohort, pos, t.buyer);
  });


  it("settle in 2 separate calls - first doesn't advance index, second does", async () => {
    const gsBefore = await t.program.account.globalState.fetch(t.globalState);
    const indexBefore = gsBefore.currentCohortIndex.toNumber();

    const cohort = await startCohort(t);
    const pos1 = await buyCall(t, cohort, { strikeBps: 12_000, nonce: 0 });
    const pos2 = await buyCall(t, cohort, { buyer: t.buyer2, strikeBps: 15_000, nonce: 0 });
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, 14_000);

    // First batch: only pos1
    await settleBatch(t, cohort, [pos1]);

    let cohortData = await t.program.account.cohort.fetch(cohort);
    // Should be Settling (not yet Settled)
    expect(JSON.stringify(cohortData.status)).to.include("settling");

    let gsAfterFirst = await t.program.account.globalState.fetch(t.globalState);
    // Index should NOT have incremented yet
    expect(gsAfterFirst.currentCohortIndex.toNumber()).to.equal(indexBefore);

    // Second batch: pos2
    await settleBatch(t, cohort, [pos2]);

    cohortData = await t.program.account.cohort.fetch(cohort);
    expect(JSON.stringify(cohortData.status)).to.include("settled");

    const gsAfterSecond = await t.program.account.globalState.fetch(t.globalState);
    expect(gsAfterSecond.currentCohortIndex.toNumber()).to.equal(indexBefore + 1);

    // Clean up
    await claimPosition(t, cohort, pos1, t.buyer);
    await claimPosition(t, cohort, pos2, t.buyer2);
  });


  it("after settlement_deadline, non-keeper settles - succeeds", async () => {
    const cohort = await startCohort(t);
    const pos = await buyCall(t, cohort);
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, 14_000);

    // Warp past the settlement deadline
    await warpTime(t.context, FAST_SETTLEMENT_DEADLINE + 1);

    // Non-keeper (randomUser) settles
    await settleBatch(t, cohort, [pos], t.randomUser);

    const posData = await t.program.account.position.fetch(pos);
    expect(posData.settled).to.equal(true);

    // Clean up
    await claimPosition(t, cohort, pos, t.buyer);
  });

  it("before settlement_deadline, non-keeper → SettlementDeadlineNotReached", async () => {
    const cohort = await startCohort(t);
    const pos = await buyCall(t, cohort);
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, 14_000);

    // Do NOT warp past settlement deadline - try immediately
    await expectError(
      () => settleBatch(t, cohort, [pos], t.randomUser),
      "SettlementDeadlineNotReached",
    );

    // Clean up: settle with keeper and claim
    await settleBatch(t, cohort, [pos]);
    await claimPosition(t, cohort, pos, t.buyer);
  });


  it("empty remaining_accounts with positions > 0 → NoPositionsProvided", async () => {
    const cohort = await startCohort(t);
    await buyCall(t, cohort);
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, 14_000);

    await expectError(
      () => settleBatch(t, cohort, []),
      "NoPositionsProvided",
    );

    // Clean up
    const [posPda] = findPositionPda(t.program.programId, cohort, t.buyer.publicKey, 12_000, 0);
    await settleBatch(t, cohort, [posPda]);
    await claimPosition(t, cohort, posPda, t.buyer);
  });

  it("cohort already Settled → InvalidCohortStatus", async () => {
    const { cohort, positions } = await runFullCohort(t, 14_000, [{}], { skipClaim: true });

    // Warp 1s for fresh blockhash (identical instruction otherwise)
    await warpTime(t.context, 1);

    // Cohort is now Settled. Trying to settle again should fail.
    await expectError(
      () => settleBatch(t, cohort, positions),
      "InvalidCohortStatus",
    );

    // Clean up
    await claimPosition(t, cohort, positions[0], t.buyer);
  });


  it("empty cohort (0 positions), empty remaining_accounts → transitions to Settled", async () => {
    const cohort = await startCohort(t);
    // No positions bought
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, 14_000);

    // Settle with empty remaining_accounts
    await settleBatch(t, cohort, []);

    const cohortData = await t.program.account.cohort.fetch(cohort);
    expect(JSON.stringify(cohortData.status)).to.include("settled");
  });
});
