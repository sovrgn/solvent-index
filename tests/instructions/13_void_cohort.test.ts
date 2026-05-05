import { expect } from "chai";
import { SystemProgram } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, warpTime, getBalance, accountExists,
  assertVaultConservation, SOL,
  FAST_TRADING_WINDOW, FAST_MEASUREMENT, FAST_OBSERVATION,
  FAST_SETTLEMENT_DEADLINE, FAST_CLAIM_EXPIRY,
} from "./_setup";

describe("void_cohort", () => {
  let t: TestCtx;

  before(async () => { t = await setupProtocol(); });

  const RECOVERY_WAIT =
    FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION +
    FAST_SETTLEMENT_DEADLINE + FAST_SETTLEMENT_DEADLINE + 3;

  async function doVoid(cohort: any, positions: any[] = [], caller = t.authority) {
    await t.program.methods
      .voidCohort()
      .accounts({
        authority: caller.publicKey,
        globalState: t.globalState,
        vault: t.vault,
        cohort,
      } as any)
      .remainingAccounts(positions.map((pk: any) => ({ pubkey: pk, isWritable: true, isSigner: false })))
      .signers(caller === t.authority ? [] : [caller])
      .rpc();
  }


  describe("happy path", () => {
    it("voids cohort after recovery - collateral released, positions refunded", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { strikeBps: 12_000 });

      const posBefore = await t.program.account.position.fetch(pos);
      const vaultPremium = posBefore.vaultPremiumLamports.toNumber();

      await warpTime(t.context, RECOVERY_WAIT);
      await doVoid(cohort, [pos]);

      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(JSON.stringify(cohortData.status)).to.include("voided");

      const posAfter = await t.program.account.position.fetch(pos);
      expect(posAfter.settled).to.equal(true);
      expect(posAfter.payoutLamports.toNumber()).to.equal(vaultPremium);

      // Claim the refund
      const balBefore = await getBalance(t.context.banksClient, t.buyer.publicKey);
      await claimPosition(t, cohort, pos, t.buyer);
      const balAfter = await getBalance(t.context.banksClient, t.buyer.publicKey);
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
      const pos = await buyCall(t, cohort, {
        strikeBps: 12_000,
        referrer: t.randomUser.publicKey,
      });

      const posData = await t.program.account.position.fetch(pos);
      expect(posData.vaultPremiumLamports.toNumber()).to.be.lessThan(
        posData.premiumPaidLamports.toNumber(),
      );
      const vaultPremium = posData.vaultPremiumLamports.toNumber();

      await warpTime(t.context, RECOVERY_WAIT);
      await doVoid(cohort, [pos]);

      const posAfter = await t.program.account.position.fetch(pos);
      expect(posAfter.payoutLamports.toNumber()).to.equal(vaultPremium);

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
      await submitMhi(t, cohort, 12_000);
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
