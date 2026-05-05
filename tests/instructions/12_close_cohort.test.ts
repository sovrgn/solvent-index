import { expect } from "chai";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, warpTime, accountExists, getBalance,
  voidCohort, SOL,
  FAST_SETTLEMENT_DEADLINE, FAST_CLAIM_EXPIRY,
  FAST_TRADING_WINDOW, FAST_MEASUREMENT, FAST_OBSERVATION,
} from "./_setup";

describe("close_cohort", () => {
  let t: TestCtx;

  before(async () => { t = await setupProtocol(); });

  async function closeCohort(cohort: any, caller = t.randomUser) {
    await t.program.methods
      .closeCohort()
      .accounts({
        caller: caller.publicKey,
        globalState: t.globalState,
        cohort,
      } as any)
      .signers([caller])
      .rpc();
  }


  describe("happy path", () => {
    it("closes settled cohort after claim expiry - PDA gone, rent to caller", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 12_000);
      await settleBatch(t, cohort, []);

      await warpTime(t.context, FAST_SETTLEMENT_DEADLINE + FAST_CLAIM_EXPIRY + 3);

      const callerBefore = await getBalance(t.context.banksClient, t.randomUser.publicKey);
      await closeCohort(cohort);
      const callerAfter = await getBalance(t.context.banksClient, t.randomUser.publicKey);

      expect(await accountExists(t.context.banksClient, cohort)).to.be.false;
      expect(callerAfter).to.be.greaterThan(callerBefore);
    });

    it("closes voided cohort after claim expiry", async () => {
      const cohort = await startCohort(t);
      await voidCohort(t, cohort);

      await warpTime(t.context, FAST_CLAIM_EXPIRY + 3);
      await closeCohort(cohort);
      expect(await accountExists(t.context.banksClient, cohort)).to.be.false;
    });
  });


  describe("error paths", () => {
    it("close active cohort → InvalidCohortStatus", async () => {
      const cohort = await startCohort(t);
      await expectError(() => closeCohort(cohort), "InvalidCohortStatus");
      // cleanup
      await voidCohort(t, cohort);
    });

    it("close settled cohort before claim expiry → ClaimNotExpired", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 12_000);
      await settleBatch(t, cohort, []);

      // Don't warp past claim expiry
      await expectError(() => closeCohort(cohort), "ClaimNotExpired");
    });
  });
});
