import { expect } from "chai";
import { SystemProgram } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, warpTime, getBalance, accountExists,
  assertVaultConservation, currentLiveStrikes, currentAtmStrike,
  FAST_CLAIM_EXPIRY,
} from "./_setup";

describe("claim", () => {
  let t: TestCtx;

  before(async () => { t = await setupProtocol(); });


  describe("happy path", () => {
    it("owner claims settled ITM position - payout transferred, PDA closed", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const pos = await buyCall(t, cohort, { strikeBps: live[2] }); // ATM
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, live[5]!); // well above ATM → ITM
      await settleBatch(t, cohort, [pos]);

      const posData = await t.program.account.position.fetch(pos);
      expect(posData.settled).to.equal(true);
      expect(posData.payoutLamports.toNumber()).to.be.greaterThan(0);

      const balBefore = await getBalance(t.context.banksClient, t.buyer.publicKey);
      await claimPosition(t, cohort, pos, t.buyer);
      const balAfter = await getBalance(t.context.banksClient, t.buyer.publicKey);

      expect(balAfter).to.be.greaterThan(balBefore);
      expect(await accountExists(t.context.banksClient, pos)).to.be.false;
      await assertVaultConservation(t);
    });

    it("claim OTM position (payout=0) - PDA closed, no SOL transferred", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const pos = await buyCall(t, cohort, { strikeBps: live[6] }); // highest = most-OTM
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, live[0]!); // mhi below every strike → OTM
      await settleBatch(t, cohort, [pos]);

      const posData = await t.program.account.position.fetch(pos);
      expect(posData.payoutLamports.toNumber()).to.equal(0);

      await claimPosition(t, cohort, pos, t.buyer);
      expect(await accountExists(t.context.banksClient, pos)).to.be.false;
      await assertVaultConservation(t);
    });
  });


  describe("third-party claim", () => {
    it("non-owner calls claim - payout goes to owner, rent to caller", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const pos = await buyCall(t, cohort, { strikeBps: live[2] });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, live[5]!);
      await settleBatch(t, cohort, [pos]);

      const ownerBefore = await getBalance(t.context.banksClient, t.buyer.publicKey);
      await claimPosition(t, cohort, pos, t.buyer, t.randomUser);
      const ownerAfter = await getBalance(t.context.banksClient, t.buyer.publicKey);

      expect(ownerAfter).to.be.greaterThan(ownerBefore);
    });
  });


  describe("error paths", () => {
    it("claim unsettled position → NotSettled", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));
      // Don't settle - try to claim directly
      await expectError(
        () => claimPosition(t, cohort, pos, t.buyer),
        "NotSettled",
      );
      await settleBatch(t, cohort, [pos]);
      await claimPosition(t, cohort, pos, t.buyer);
    });

    it("double claim fails (PDA gone)", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));
      await settleBatch(t, cohort, [pos]);
      await claimPosition(t, cohort, pos, t.buyer);

      await warpTime(t.context, 1);
      await expectError(
        () => claimPosition(t, cohort, pos, t.buyer),
        "AccountNotInitialized",
      );
    });

    it("claim after deadline → ClaimExpired", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const pos = await buyCall(t, cohort, { strikeBps: live[2] });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, live[5]!);
      await settleBatch(t, cohort, [pos]);

      await warpTime(t.context, FAST_CLAIM_EXPIRY + 1);

      await expectError(
        () => claimPosition(t, cohort, pos, t.buyer),
        "ClaimExpired",
      );

      await t.program.methods
        .expirePosition()
        .accounts({
          caller: t.randomUser.publicKey,
          vault: t.vault,
          cohort,
          position: pos,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([t.randomUser])
        .rpc();
    });
  });
});
