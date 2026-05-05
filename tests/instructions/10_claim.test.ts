import { expect } from "chai";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, warpTime, getBalance, accountExists,
  assertVaultConservation, SOL, FAST_CLAIM_EXPIRY, fundedKeypair,
} from "./_setup";

describe("claim", () => {
  let t: TestCtx;

  before(async () => { t = await setupProtocol(); });


  describe("happy path", () => {
    it("owner claims settled ITM position - payout transferred, PDA closed", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { strikeBps: 12_000 });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 15_000); // ITM
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
      const pos = await buyCall(t, cohort, { strikeBps: 20_000 }); // far OTM
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 12_000); // below all strikes
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
      const pos = await buyCall(t, cohort, { strikeBps: 12_000 });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 15_000);
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
      await submitMhi(t, cohort);
      // Don't settle - try to claim directly
      await expectError(
        () => claimPosition(t, cohort, pos, t.buyer),
        "NotSettled",
      );
      // cleanup
      await settleBatch(t, cohort, [pos]);
      await claimPosition(t, cohort, pos, t.buyer);
    });

    it("double claim fails (PDA gone)", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort);
      await settleBatch(t, cohort, [pos]);
      await claimPosition(t, cohort, pos, t.buyer);

      await warpTime(t.context, 1);
      // Anchor finds the account zeroed/system-owned → AccountNotInitialized (3012)
      await expectError(
        () => claimPosition(t, cohort, pos, t.buyer),
        "AccountNotInitialized",
      );
    });

    it("claim after deadline → ClaimExpired", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { strikeBps: 12_000 });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 15_000);
      await settleBatch(t, cohort, [pos]);

      await warpTime(t.context, FAST_CLAIM_EXPIRY + 1);

      await expectError(
        () => claimPosition(t, cohort, pos, t.buyer),
        "ClaimExpired",
      );

      // cleanup: expire the position
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
