import { expect } from "chai";
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
  currentAtmStrike,
  currentLiveStrikes,
  TestCtx,
  FAST_SETTLEMENT_DEADLINE,
} from "./_setup";

describe("09 - settle_batch", () => {
  let t: TestCtx;

  before(async () => {
    t = await setupProtocol();
  });


  it("settle all positions - all marked settled, payouts computed", async () => {
    const cohort = await startCohort(t);
    const live = await currentLiveStrikes(t);
    // ATM = live[2]; OTM = live[5] (well above the MHI we'll submit).
    const pos1 = await buyCall(t, cohort, { strikeBps: live[2] });
    const pos2 = await buyCall(t, cohort, { buyer: t.buyer2, strikeBps: live[5] });
    await warpPastObservation(t.context);
    // mhi between live[2] and live[5] → pos1 ITM, pos2 OTM.
    const mhi = Math.floor((live[2]! + live[5]!) / 2);
    await submitMhi(t, cohort, mhi);

    await settleBatch(t, cohort, [pos1, pos2]);

    const p1 = await t.program.account.position.fetch(pos1);
    const p2 = await t.program.account.position.fetch(pos2);
    expect(p1.settled).to.equal(true);
    expect(p2.settled).to.equal(true);
  });

  it("ITM position: payout > 0", async () => {
    const cohort = await startCohort(t);
    const live = await currentLiveStrikes(t);
    const pos = await buyCall(t, cohort, { strikeBps: live[0] }); // deep ITM at the lowest strike
    await warpPastObservation(t.context);
    // mhi above live[0] guarantees positive payoff.
    await submitMhi(t, cohort, live[3]!);
    await settleBatch(t, cohort, [pos]);

    const posData = await t.program.account.position.fetch(pos);
    expect(posData.payoutLamports.toNumber()).to.be.greaterThan(0);

    await claimPosition(t, cohort, pos, t.buyer);
  });

  it("OTM position: payout = 0", async () => {
    const cohort = await startCohort(t);
    const live = await currentLiveStrikes(t);
    const pos = await buyCall(t, cohort, { strikeBps: live[6] }); // highest strike, well above any MHI we'd submit
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, live[0]!); // mhi below all strikes → OTM
    await settleBatch(t, cohort, [pos]);

    const posData = await t.program.account.position.fetch(pos);
    expect(posData.payoutLamports.toNumber()).to.equal(0);

    await claimPosition(t, cohort, pos, t.buyer);
  });

  it("vault accounting: active_collateral decreases, unclaimed increases", async () => {
    const vaultBefore = await t.program.account.vault.fetch(t.vault);
    const collateralBefore = vaultBefore.activeCollateralLamports.toNumber();
    const unclaimedBefore = vaultBefore.unclaimedPayoutsLamports.toNumber();

    const cohort = await startCohort(t);
    const live = await currentLiveStrikes(t);
    const pos = await buyCall(t, cohort, { strikeBps: live[0] });

    const vaultAfterBuy = await t.program.account.vault.fetch(t.vault);
    const collateralAfterBuy = vaultAfterBuy.activeCollateralLamports.toNumber();
    expect(collateralAfterBuy).to.be.greaterThan(collateralBefore);

    await warpPastObservation(t.context);
    await submitMhi(t, cohort, live[3]!); // ITM
    await settleBatch(t, cohort, [pos]);

    const vaultAfterSettle = await t.program.account.vault.fetch(t.vault);
    expect(vaultAfterSettle.activeCollateralLamports.toNumber()).to.be.lessThan(collateralAfterBuy);
    expect(vaultAfterSettle.unclaimedPayoutsLamports.toNumber()).to.be.greaterThanOrEqual(unclaimedBefore);

    await claimPosition(t, cohort, pos, t.buyer);
  });

  it("when all settled: cohort → Settled, active_cohorts decrements", async () => {
    const cohort = await startCohort(t);
    const pos = await buyCall(t, cohort);
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, await currentAtmStrike(t));
    await settleBatch(t, cohort, [pos]);

    const cohortData = await t.program.account.cohort.fetch(cohort);
    expect(JSON.stringify(cohortData.status)).to.include("settled");

    // currentCohortIndex is monotonic and only moves at start_cohort —
    // settle has no effect on it. The terminal-state signal is now
    // `active_cohorts` decrementing.
    const gsAfter = await t.program.account.globalState.fetch(t.globalState);
    expect(gsAfter.activeCohorts).to.equal(0);

    await claimPosition(t, cohort, pos, t.buyer);
  });

  it("vault conservation holds after settle", async () => {
    const cohort = await startCohort(t);
    const pos = await buyCall(t, cohort);
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, await currentAtmStrike(t));
    await settleBatch(t, cohort, [pos]);

    await assertVaultConservation(t);

    await claimPosition(t, cohort, pos, t.buyer);
  });


  it("settle in 2 separate calls - first → Settling, second → Settled", async () => {
    const cohort = await startCohort(t);
    const live = await currentLiveStrikes(t);
    const pos1 = await buyCall(t, cohort, { strikeBps: live[2], nonce: 0 });
    const pos2 = await buyCall(t, cohort, { buyer: t.buyer2, strikeBps: live[5], nonce: 0 });
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, live[3]!);

    // First batch: only pos1 — cohort transitions to Settling.
    await settleBatch(t, cohort, [pos1]);

    let cohortData = await t.program.account.cohort.fetch(cohort);
    expect(JSON.stringify(cohortData.status)).to.include("settling");

    // Second batch: pos2 — cohort transitions to Settled.
    await settleBatch(t, cohort, [pos2]);

    cohortData = await t.program.account.cohort.fetch(cohort);
    expect(JSON.stringify(cohortData.status)).to.include("settled");

    await claimPosition(t, cohort, pos1, t.buyer);
    await claimPosition(t, cohort, pos2, t.buyer2);
  });


  it("after settlement_deadline, non-keeper settles - succeeds", async () => {
    const cohort = await startCohort(t);
    const pos = await buyCall(t, cohort);
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, await currentAtmStrike(t));

    await warpTime(t.context, FAST_SETTLEMENT_DEADLINE + 1);

    await settleBatch(t, cohort, [pos], t.randomUser);

    const posData = await t.program.account.position.fetch(pos);
    expect(posData.settled).to.equal(true);

    await claimPosition(t, cohort, pos, t.buyer);
  });

  it("before settlement_deadline, non-keeper → SettlementDeadlineNotReached", async () => {
    const cohort = await startCohort(t);
    const pos = await buyCall(t, cohort);
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, await currentAtmStrike(t));

    await expectError(
      () => settleBatch(t, cohort, [pos], t.randomUser),
      "SettlementDeadlineNotReached",
    );

    await settleBatch(t, cohort, [pos]);
    await claimPosition(t, cohort, pos, t.buyer);
  });


  it("empty remaining_accounts with positions > 0 → NoPositionsProvided", async () => {
    const cohort = await startCohort(t);
    const pos = await buyCall(t, cohort);
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, await currentAtmStrike(t));

    await expectError(
      () => settleBatch(t, cohort, []),
      "NoPositionsProvided",
    );

    await settleBatch(t, cohort, [pos]);
    await claimPosition(t, cohort, pos, t.buyer);
  });

  it("cohort already Settled → InvalidCohortStatus", async () => {
    const { cohort, positions } = await runFullCohort(t, undefined, [{}], { skipClaim: true });

    await warpTime(t.context, 1);

    await expectError(
      () => settleBatch(t, cohort, positions),
      "InvalidCohortStatus",
    );

    await claimPosition(t, cohort, positions[0], t.buyer);
  });


  it("empty cohort (0 positions), empty remaining_accounts → transitions to Settled", async () => {
    const cohort = await startCohort(t);
    await warpPastObservation(t.context);
    await submitMhi(t, cohort, await currentAtmStrike(t));

    await settleBatch(t, cohort, []);

    const cohortData = await t.program.account.cohort.fetch(cohort);
    expect(JSON.stringify(cohortData.status)).to.include("settled");
  });
});
