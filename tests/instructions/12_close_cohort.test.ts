import { expect } from "chai";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, warpPastObservation, submitMhi, settleBatch,
  warpTime, accountExists, getBalance,
  voidCohort, currentAtmStrike,
  FAST_SETTLEMENT_DEADLINE, FAST_CLAIM_EXPIRY,
} from "./_setup";

describe("close_cohort", () => {
  let t: TestCtx;

  before(async () => { t = await setupProtocol(); });

  // Close is keeper-only now: the keeper paid the cohort rent at start_cohort,
  // so it (and only it) reclaims that rent here. Caller defaults to the keeper.
  async function closeCohort(cohort: any, caller = t.keeper) {
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
    it("closes settled cohort after claim expiry - PDA gone, rent to keeper", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));
      await settleBatch(t, cohort, []);

      await warpTime(t.context, FAST_SETTLEMENT_DEADLINE + FAST_CLAIM_EXPIRY + 3);

      const keeperBefore = await getBalance(t.context.banksClient, t.keeper.publicKey);
      await closeCohort(cohort); // caller defaults to the keeper
      const keeperAfter = await getBalance(t.context.banksClient, t.keeper.publicKey);

      expect(await accountExists(t.context.banksClient, cohort)).to.be.false;
      // close = caller refunds the cohort rent to the keeper — which funded it
      // at start_cohort — net of the small tx fee. Rent-neutral lifecycle, so
      // the keeper hot wallet doesn't bleed SOL every round.
      expect(keeperAfter).to.be.greaterThan(keeperBefore);
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
    it("non-keeper caller → UnauthorizedKeeper (rent can't be sniped)", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));
      await settleBatch(t, cohort, []);
      await warpTime(t.context, FAST_SETTLEMENT_DEADLINE + FAST_CLAIM_EXPIRY + 3);

      // A third party must not be able to close a settled cohort to grab the
      // rent the keeper paid at start_cohort.
      await expectError(() => closeCohort(cohort, t.randomUser), "UnauthorizedKeeper");
      // The keeper can still close it (cleanup).
      await closeCohort(cohort);
    });

    it("close active cohort → InvalidCohortStatus", async () => {
      const cohort = await startCohort(t);
      await expectError(() => closeCohort(cohort), "InvalidCohortStatus");
      // cleanup
      await voidCohort(t, cohort);
    });

    it("close settled cohort before claim expiry → ClaimNotExpired", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));
      await settleBatch(t, cohort, []);

      // Don't warp past claim expiry
      await expectError(() => closeCohort(cohort), "ClaimNotExpired");
    });
  });
});
