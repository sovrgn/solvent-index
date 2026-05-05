import { expect } from "chai";
import { SystemProgram } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, warpTime, warpToTimestamp, assertVaultConservation,
  voidCohort, runFullCohort, SOL, getBalance, accountExists,
  fundedKeypair, findPositionPda,
  FAST_TRADING_WINDOW, FAST_MEASUREMENT, FAST_OBSERVATION,
  FAST_SETTLEMENT_DEADLINE, FAST_CLAIM_EXPIRY,
} from "./_setup";

describe("16 - timing boundaries", () => {


  describe("submit_mhi observation boundary", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("submit_mhi at observation_end - 1 → ObservationNotComplete", async () => {
      const cohort = await startCohort(t);
      const cohortData = await t.program.account.cohort.fetch(cohort);
      const observationEnd = cohortData.measurementDeadline.toNumber() + FAST_OBSERVATION;

      await warpToTimestamp(t.context, observationEnd - 1);

      await expectError(
        () => submitMhi(t, cohort, 14_000),
        "ObservationNotComplete",
      );

      // cleanup: warp past and submit so cohort can be settled
      await warpToTimestamp(t.context, observationEnd);
      await submitMhi(t, cohort, 14_000);
      await settleBatch(t, cohort, []);
    });

    it("submit_mhi at observation_end → succeeds", async () => {
      const cohort = await startCohort(t);
      const cohortData = await t.program.account.cohort.fetch(cohort);
      const observationEnd = cohortData.measurementDeadline.toNumber() + FAST_OBSERVATION;

      await warpToTimestamp(t.context, observationEnd);

      await submitMhi(t, cohort, 14_000);
      const data = await t.program.account.cohort.fetch(cohort);
      expect(data.mhiBps).to.be.greaterThan(0);

      // cleanup
      await settleBatch(t, cohort, []);
    });
  });


  describe("settle_batch non-keeper before settlement deadline", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("non-keeper at settlement_deadline - 1 → SettlementDeadlineNotReached", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { strikeBps: 12_000 });

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 14_000);

      const cohortData = await t.program.account.cohort.fetch(cohort);
      const settlementDeadline = cohortData.settlementDeadline.toNumber();

      await warpToTimestamp(t.context, settlementDeadline - 1);

      await expectError(
        () => settleBatch(t, cohort, [pos], t.randomUser),
        "SettlementDeadlineNotReached",
      );

      // cleanup: keeper settles
      await settleBatch(t, cohort, [pos], t.keeper);
      await claimPosition(t, cohort, pos, t.buyer);
    });
  });


  describe("claim at claim_deadline - 1", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("claim at claim_deadline - 1 → succeeds", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { strikeBps: 12_000 });

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 15_000); // ITM
      await settleBatch(t, cohort, [pos]);

      const posData = await t.program.account.position.fetch(pos);
      const claimDeadline = posData.claimDeadline.toNumber();

      await warpToTimestamp(t.context, claimDeadline - 1);

      const balBefore = await getBalance(t.context.banksClient, t.buyer.publicKey);
      await claimPosition(t, cohort, pos, t.buyer);
      const balAfter = await getBalance(t.context.banksClient, t.buyer.publicKey);
      expect(balAfter).to.be.greaterThan(balBefore);
    });
  });


  describe("expire_position boundary at claim_deadline", () => {
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

    it("expire_position at claim_deadline - 1 → ClaimNotExpired", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { strikeBps: 12_000 });

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 15_000); // ITM
      await settleBatch(t, cohort, [pos]);

      const posData = await t.program.account.position.fetch(pos);
      const claimDeadline = posData.claimDeadline.toNumber();

      await warpToTimestamp(t.context, claimDeadline - 1);

      await expectError(
        () => expirePosition(cohort, pos),
        "ClaimNotExpired",
      );

      // cleanup: claim the position
      await claimPosition(t, cohort, pos, t.buyer);
    });

    it("expire_position at claim_deadline → ClaimNotExpired", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { strikeBps: 12_000 });

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 15_000); // ITM
      await settleBatch(t, cohort, [pos]);

      const posData = await t.program.account.position.fetch(pos);
      const claimDeadline = posData.claimDeadline.toNumber();

      await warpToTimestamp(t.context, claimDeadline);

      await expectError(
        () => expirePosition(cohort, pos),
        "ClaimNotExpired",
      );

      // cleanup: warp past deadline and expire (claim window already closed at deadline)
      await warpTime(t.context, 1);
      await expirePosition(cohort, pos);
    });

    it("expire_position at claim_deadline + 1 → succeeds", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { strikeBps: 12_000 });

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 15_000); // ITM
      await settleBatch(t, cohort, [pos]);

      const posData = await t.program.account.position.fetch(pos);
      const claimDeadline = posData.claimDeadline.toNumber();

      await warpToTimestamp(t.context, claimDeadline + 1);

      await expirePosition(cohort, pos);
      expect(await accountExists(t.context.banksClient, pos)).to.be.false;
    });
  });


  describe("void_cohort at recovery_deadline", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("void_cohort at recovery_deadline → succeeds", async () => {
      const cohort = await startCohort(t);
      const cohortData = await t.program.account.cohort.fetch(cohort);
      const recoveryDeadline = cohortData.recoveryDeadline.toNumber();

      await warpToTimestamp(t.context, recoveryDeadline);

      await t.program.methods
        .voidCohort()
        .accounts({
          authority: t.authority.publicKey,
          globalState: t.globalState,
          vault: t.vault,
          cohort,
        } as any)
        .rpc();

      const data = await t.program.account.cohort.fetch(cohort);
      expect(JSON.stringify(data.status)).to.include("voided");
    });
  });


  describe("close_cohort boundary at settlement_deadline + claim_expiry", () => {
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

    it("close_cohort at (settlement_deadline + claim_expiry) - 1 → ClaimNotExpired", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 12_000);
      await settleBatch(t, cohort, []);

      const cohortData = await t.program.account.cohort.fetch(cohort);
      const closeThreshold = cohortData.settlementDeadline.toNumber() + FAST_CLAIM_EXPIRY;

      await warpToTimestamp(t.context, closeThreshold - 1);

      await expectError(
        () => closeCohort(cohort),
        "ClaimNotExpired",
      );

      // cleanup: warp past and close
      await warpToTimestamp(t.context, closeThreshold);
      await closeCohort(cohort);
    });

    it("close_cohort at (settlement_deadline + claim_expiry) → succeeds", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 12_000);
      await settleBatch(t, cohort, []);

      const cohortData = await t.program.account.cohort.fetch(cohort);
      const closeThreshold = cohortData.settlementDeadline.toNumber() + FAST_CLAIM_EXPIRY;

      await warpToTimestamp(t.context, closeThreshold);

      await closeCohort(cohort);
      expect(await accountExists(t.context.banksClient, cohort)).to.be.false;
    });
  });
});
