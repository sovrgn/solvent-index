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

  async function closeCohort(cohort: any, caller = t.randomUser) {
    await t.program.methods
      .closeCohort()
      .accounts({
        caller: caller.publicKey,
        globalState: t.globalState,
        // Rent refund destination — anyone can trigger the close, but rent
        // always goes back to the authority. The authority is NOT a signer here.
        authority: t.authority.publicKey,
        cohort,
      } as any)
      .signers([caller])
      .rpc();
  }


  describe("happy path", () => {
    it("closes settled cohort after claim expiry - PDA gone, rent to authority", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));
      await settleBatch(t, cohort, []);

      await warpTime(t.context, FAST_SETTLEMENT_DEADLINE + FAST_CLAIM_EXPIRY + 3);

      const authorityBefore = await getBalance(t.context.banksClient, t.authority.publicKey);
      await closeCohort(cohort);
      const authorityAfter = await getBalance(t.context.banksClient, t.authority.publicKey);

      expect(await accountExists(t.context.banksClient, cohort)).to.be.false;
      // close = authority sends the rent refund to the protocol authority,
      // not the caller. Caller pays the tx fee and is incentivized only by
      // the gas market, not the rent recovery.
      expect(authorityAfter).to.be.greaterThan(authorityBefore);
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
      await submitMhi(t, cohort, await currentAtmStrike(t));
      await settleBatch(t, cohort, []);

      // Don't warp past claim expiry
      await expectError(() => closeCohort(cohort), "ClaimNotExpired");
    });
  });
});
