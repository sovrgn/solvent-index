import { expect } from "chai";
import {
  setupProtocol, expectError, warpTime, warpPastObservation,
  startCohort, submitMhi, settleBatch,
  runFullCohort, voidCohort, TestCtx, MHI_CAP_BPS, DEFAULT_STRIKES_BPS,
  FAST_TRADING_WINDOW, FAST_MEASUREMENT,
} from "./_setup";

describe("08 - submit_mhi", () => {
  let t: TestCtx;

  before(async () => { t = await setupProtocol(); });


  describe("happy path", () => {
    it("keeper submits MHI after observation - cohort.mhiBps set", async () => {
      const { cohort } = await runFullCohort(t, 14_000, [{}]);
      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.mhiBps).to.equal(14_000);
    });

    it("globalState.lastMhiBps updated", async () => {
      const gs = await t.program.account.globalState.fetch(t.globalState);
      expect(gs.lastMhiBps).to.equal(14_000);
    });

    it("first cohort unclamped (lastMhiBps was 0 at time)", async () => {
      // Already verified - the first cohort submitted 14_000 unclamped
      const gs = await t.program.account.globalState.fetch(t.globalState);
      expect(gs.lastMhiBps).to.equal(14_000);
    });
  });


  describe("clamp behavior", () => {
    it("value within 33% passes through approximately", async () => {
      // lastMhiBps = 14_000 from happy path. 15_000 is ~7% above → within 33%.
      const { cohort } = await runFullCohort(t, 15_000, [{}]);
      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.mhiBps).to.be.closeTo(15_000, 100);
    });

    it("value exceeds +33% → clamped to upper bound", async () => {
      const gs = await t.program.account.globalState.fetch(t.globalState);
      const lastMhi = gs.lastMhiBps;

      const { cohort } = await runFullCohort(t, 30_000, [{}]);
      const cohortData = await t.program.account.cohort.fetch(cohort);
      const maxUp = Math.floor(lastMhi * 3300 / 10000);
      expect(cohortData.mhiBps).to.equal(lastMhi + maxUp);
      expect(cohortData.mhiBps).to.be.lessThan(30_000);
    });

    it("index sustained above the cap keeps settling, pinned at the cap", async () => {
      // The liveness property the 6020 fix exists for. A market that stays
      // above 3.0x used to stop settlement entirely; now every cohort settles,
      // the delta band walks the stored value up, and it stops at the cap
      // instead of overshooting it.
      // Empty cohorts: the property under test is submit/settle liveness, and
      // buying would couple it to the ladder the moving anchor produces.
      let stored = 0;
      let pinnedAfter = 0;
      for (let i = 1; i <= 6; i++) {
        const { cohort } = await runFullCohort(t, MHI_CAP_BPS + 50_000, []);
        stored = (await t.program.account.cohort.fetch(cohort)).mhiBps;
        expect(stored, `cohort ${i} stored above cap`).to.be.at.most(MHI_CAP_BPS);
        if (stored === MHI_CAP_BPS && pinnedAfter === 0) pinnedAfter = i;
      }
      expect(pinnedAfter, "never reached the cap in 6 cohorts").to.be.greaterThan(0);
      expect(stored).to.equal(MHI_CAP_BPS);

      // Walk back down so later tests start from a normal index.
      await runFullCohort(t, 14_000, []);
      await runFullCohort(t, 14_000, []);
    });

    it("value below -33% → clamped to lower bound", async () => {
      const gs = await t.program.account.globalState.fetch(t.globalState);
      const lastMhi = gs.lastMhiBps;

      const { cohort } = await runFullCohort(t, 1);
      const cohortData = await t.program.account.cohort.fetch(cohort);
      const maxDown = Math.floor(lastMhi * 3300 / 10000);
      expect(cohortData.mhiBps).to.equal(Math.max(lastMhi - maxDown, 1));
      expect(cohortData.mhiBps).to.be.greaterThan(1);
    });
  });


  describe("error paths", () => {
    it("non-keeper → Unauthorized", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await expectError(
        () => t.program.methods
          .submitMhi(14_000, 20, Array.from({ length: 32 }, () => 0))
          .accounts({
            keeper: t.randomUser.publicKey,
            globalState: t.globalState,
            cohort,
            emaState: t.emaState,
            vault: t.vault,
          } as any)
          .signers([t.randomUser])
          .rpc(),
        "Unauthorized",
      );
      // cleanup
      await submitMhi(t, cohort, 14_000);
      await settleBatch(t, cohort, []);
    });

    it("MHI already submitted → MhiAlreadySubmitted", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 14_000);
      await warpTime(t.context, 1); // fresh blockhash
      await expectError(
        () => submitMhi(t, cohort, 14_000),
        "MhiAlreadySubmitted",
      );
      await settleBatch(t, cohort, []);
    });

    it("mhi_bps = 0 → MhiZero", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await expectError(
        () => submitMhi(t, cohort, 0),
        "MhiZero",
      );
      await submitMhi(t, cohort, 14_000);
      await settleBatch(t, cohort, []);
    });

    it("mhi_bps > cap → clamped, never rejected", async () => {
      // Regression (devnet 2026-08-21): this used to revert with
      // MhiExceedsCap (6020). A median above the cap then stopped settlement
      // outright: the cohort kept its active_cohorts slot and the keeper
      // retried every 5s until the market cooled off. Payoff is already
      // truncated at `cap - strike`, so the rejection protected nothing.
      const gsBefore = await t.program.account.globalState.fetch(t.globalState);
      const lastMhi = gsBefore.lastMhiBps;

      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, MHI_CAP_BPS + 50_000);

      const cohortData = await t.program.account.cohort.fetch(cohort);
      const deltaCeiling = lastMhi + Math.floor((lastMhi * 3300) / 10_000);
      expect(cohortData.mhiBps).to.equal(Math.min(deltaCeiling, MHI_CAP_BPS));
      expect(cohortData.mhiBps).to.be.at.most(MHI_CAP_BPS);

      await settleBatch(t, cohort, []);
    });

    it("before observation complete → ObservationNotComplete", async () => {
      const cohort = await startCohort(t);
      // Warp past trading + measurement but NOT observation
      await warpTime(t.context, FAST_TRADING_WINDOW + FAST_MEASUREMENT + 1);
      await expectError(
        () => submitMhi(t, cohort, 14_000),
        "ObservationNotComplete",
      );
      // cleanup: void
      await voidCohort(t, cohort);
    });
  });


  describe("edge cases", () => {
    it("submit with empty cohort (0 positions) - succeeds", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 14_000);
      const data = await t.program.account.cohort.fetch(cohort);
      expect(data.mhiBps).to.be.greaterThan(0);
      await settleBatch(t, cohort, []);
    });

    it("submit MHI = 1 (minimum) - succeeds (may be clamped)", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 1);
      const data = await t.program.account.cohort.fetch(cohort);
      expect(data.mhiBps).to.be.greaterThan(0);
      await settleBatch(t, cohort, []);
    });
  });
});
