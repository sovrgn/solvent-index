import { expect } from "chai";
import { SystemProgram } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, warpTime, accountExists,
  assertVaultConservation, currentLiveStrikes, currentAtmStrike,
  FAST_CLAIM_EXPIRY,
} from "./_setup";

describe("expire_position", () => {
  let t: TestCtx;

  before(async () => { t = await setupProtocol(); });

  async function expirePosition(cohort: any, pos: any, caller = t.randomUser) {
    await t.program.methods
      .expirePosition()
      .accounts({
        caller: caller.publicKey,
        vault: t.vault,
        cohort,
        position: pos,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([caller])
      .rpc();
  }


  describe("happy path", () => {
    it("after claim deadline, anyone expires - payout returns to vault available", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const pos = await buyCall(t, cohort, { strikeBps: live[2] });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, live[5]!); // ITM
      await settleBatch(t, cohort, [pos]);

      const posData = await t.program.account.position.fetch(pos);
      const payout = posData.payoutLamports.toNumber();
      expect(payout).to.be.greaterThan(0);

      await warpTime(t.context, FAST_CLAIM_EXPIRY + 1);

      const vaultBefore = await t.program.account.vault.fetch(t.vault);
      await expirePosition(cohort, pos);

      const vaultAfter = await t.program.account.vault.fetch(t.vault);
      expect(vaultAfter.availableLamports.toNumber()).to.equal(
        vaultBefore.availableLamports.toNumber() + payout,
      );
      expect(vaultAfter.unclaimedPayoutsLamports.toNumber()).to.equal(
        vaultBefore.unclaimedPayoutsLamports.toNumber() - payout,
      );
      expect(await accountExists(t.context.banksClient, pos)).to.be.false;
      await assertVaultConservation(t);
    });

    it("expire OTM position (payout=0) - PDA closed, no vault accounting change", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const pos = await buyCall(t, cohort, { strikeBps: live[6] }); // most-OTM
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, live[0]!); // below all strikes → OTM
      await settleBatch(t, cohort, [pos]);

      await warpTime(t.context, FAST_CLAIM_EXPIRY + 1);

      const vaultBefore = await t.program.account.vault.fetch(t.vault);
      await expirePosition(cohort, pos);
      const vaultAfter = await t.program.account.vault.fetch(t.vault);

      expect(vaultAfter.availableLamports.toNumber()).to.equal(
        vaultBefore.availableLamports.toNumber(),
      );
      expect(await accountExists(t.context.banksClient, pos)).to.be.false;
    });
  });


  describe("error paths", () => {
    it("expire before claim deadline → ClaimNotExpired", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));
      await settleBatch(t, cohort, [pos]);

      // Don't warp - try immediately
      await expectError(
        () => expirePosition(cohort, pos),
        "ClaimNotExpired",
      );

      // cleanup
      await claimPosition(t, cohort, pos, t.buyer);
    });

    it("expire unsettled position → NotSettled", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));
      // Don't settle

      await warpTime(t.context, FAST_CLAIM_EXPIRY + 1);

      await expectError(
        () => expirePosition(cohort, pos),
        "NotSettled",
      );

      // cleanup
      await settleBatch(t, cohort, [pos]);
      // position claim_deadline was set at settlement, which just happened, so we need to warp again
      await warpTime(t.context, FAST_CLAIM_EXPIRY + 1);
      await expirePosition(cohort, pos);
    });
  });
});
