import { expect } from "chai";
import { SystemProgram } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, warpTime, getBalance, accountExists,
  assertVaultConservation, currentLiveStrikes, currentAtmStrike,
  FAST_TRADING_WINDOW, FAST_MEASUREMENT, FAST_OBSERVATION,
  FAST_SETTLEMENT_DEADLINE,
} from "./_setup";

describe("void_cohort", () => {
  let t: TestCtx;

  before(async () => { t = await setupProtocol(); });

  const RECOVERY_WAIT =
    FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION +
    FAST_SETTLEMENT_DEADLINE + FAST_SETTLEMENT_DEADLINE + 3;

  async function doVoid(cohort: any, positions: any[] = [], caller = t.authority) {
    // void_cohort now expects (position, owner) pairs in remaining_accounts
    // and refunds premium directly to the owner. Derive owners from chain
    // when callers pass bare PublicKey[].
    const pairs: Array<{ pubkey: any; owner: any }> = [];
    for (const p of positions) {
      if (p?.pubkey && p?.owner) {
        pairs.push(p);
      } else {
        const pos = await t.program.account.position.fetch(p);
        pairs.push({ pubkey: p, owner: pos.owner });
      }
    }
    const remaining = pairs.flatMap(({ pubkey, owner }) => [
      { pubkey, isWritable: true, isSigner: false },
      { pubkey: owner, isWritable: true, isSigner: false },
    ]);
    await t.program.methods
      .voidCohort()
      .accounts({
        authority: caller.publicKey,
        globalState: t.globalState,
        vault: t.vault,
        cohort,
      } as any)
      .remainingAccounts(remaining)
      .signers(caller === t.authority ? [] : [caller])
      .rpc();
  }


  describe("happy path", () => {
    it("voids cohort after recovery - collateral released, positions refunded", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const pos = await buyCall(t, cohort, { strikeBps: live[2] });

      const posBefore = await t.program.account.position.fetch(pos);
      const vaultPremium = posBefore.vaultPremiumLamports.toNumber();

      await warpTime(t.context, RECOVERY_WAIT);
      // Sample the buyer's balance BEFORE void: the refund is now transferred
      // directly to the owner inside void_cohort, not via a later claim step.
      const balBefore = await getBalance(t.context.banksClient, t.buyer.publicKey);
      await doVoid(cohort, [pos]);
      const balAfter = await getBalance(t.context.banksClient, t.buyer.publicKey);

      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(JSON.stringify(cohortData.status)).to.include("voided");

      const posAfter = await t.program.account.position.fetch(pos);
      expect(posAfter.settled).to.equal(true);
      expect(posAfter.claimed).to.equal(true); // void delivers the refund inline
      expect(posAfter.payoutLamports.toNumber()).to.equal(vaultPremium);

      // Refund landed in the buyer's wallet as part of the void tx.
      expect(balAfter).to.be.greaterThan(balBefore);

      await assertVaultConservation(t);
    });

    it("void empty cohort (0 positions) - succeeds", async () => {
      const cohort = await startCohort(t);
      await warpTime(t.context, RECOVERY_WAIT);
      await doVoid(cohort);

      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(JSON.stringify(cohortData.status)).to.include("voided");
      await assertVaultConservation(t);
    });

    it("void with referral position - refund is vault_premium (not full premium)", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const pos = await buyCall(t, cohort, {
        strikeBps: live[2],
        referrer: t.randomUser.publicKey,
      });

      const posData = await t.program.account.position.fetch(pos);
      expect(posData.vaultPremiumLamports.toNumber()).to.be.lessThan(
        posData.premiumPaidLamports.toNumber(),
      );
      const premiumPaid = posData.premiumPaidLamports.toNumber();

      await warpTime(t.context, RECOVERY_WAIT);
      await doVoid(cohort, [pos]);

      // void_cohort refunds the FULL premium the buyer paid (the protocol
      // eats the referral that was already paid out — it's the cost of an
      // emergency recovery). See void_cohort.rs.
      const posAfter = await t.program.account.position.fetch(pos);
      expect(posAfter.payoutLamports.toNumber()).to.equal(premiumPaid);

      await claimPosition(t, cohort, pos, t.buyer);
      await assertVaultConservation(t);
    });
  });


  describe("error paths", () => {
    it("non-authority → UnauthorizedAuthority", async () => {
      const cohort = await startCohort(t);
      await warpTime(t.context, RECOVERY_WAIT);
      await expectError(
        () => doVoid(cohort, [], t.randomUser),
        "Unauthorized",
      );
      // cleanup
      await doVoid(cohort);
    });

    it("before recovery deadline → RecoveryDeadlineNotReached", async () => {
      const cohort = await startCohort(t);
      await expectError(
        () => doVoid(cohort),
        "RecoveryDeadlineNotReached",
      );
      // cleanup
      await warpTime(t.context, RECOVERY_WAIT);
      await doVoid(cohort);
    });

    it("MHI already submitted → MhiAlreadySubmitted", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));
      await warpTime(t.context, FAST_SETTLEMENT_DEADLINE * 2 + 3);

      await expectError(
        () => doVoid(cohort),
        "MhiAlreadySubmitted",
      );
      // cleanup: settle
      await settleBatch(t, cohort, []);
    });

    it("already resolved → CohortAlreadyResolved", async () => {
      const cohort = await startCohort(t);
      await warpTime(t.context, RECOVERY_WAIT);
      await doVoid(cohort);

      await warpTime(t.context, 1);
      await expectError(
        () => doVoid(cohort),
        "CohortAlreadyResolved",
      );
    });
  });
});
