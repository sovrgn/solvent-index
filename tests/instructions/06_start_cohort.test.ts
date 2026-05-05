import * as anchor from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

import {
  setupProtocol,
  expectError,
  warpTime,
  startCohort,
  runFullCohort,
  voidCohort,
  findCohortPda,
  TestCtx,
  FAST_TRADING_WINDOW,
  FAST_MEASUREMENT,
  FAST_OBSERVATION,
  FAST_SETTLEMENT_DEADLINE,
} from "./_setup";

describe("06 - start_cohort", () => {
  let t: TestCtx;

  before(async () => {
    t = await setupProtocol();
  });


  describe("happy path", () => {
    it("keeper starts cohort - PDA created with Trading status", async () => {
      const gsBefore = await t.program.account.globalState.fetch(t.globalState);
      const idx = gsBefore.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(t.program.programId, idx);

      await t.program.methods
        .startCohort()
        .accounts({
          keeper: t.keeper.publicKey,
          globalState: t.globalState,
          vault: t.vault,
          emaState: t.emaState,
          cohort: cohortPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([t.keeper])
        .rpc();

      const cohort = await t.program.account.cohort.fetch(cohortPda);
      // Status should be Trading (0)
      expect(JSON.stringify(cohort.status)).to.include("trading");
      expect(cohort.index.toNumber()).to.equal(idx);
      expect(cohort.totalPositions).to.equal(0);
      expect(cohort.mhiBps).to.equal(0);
    });

    it("GlobalState → Active, total_cohorts increments", async () => {
      const gs = await t.program.account.globalState.fetch(t.globalState);
      expect(JSON.stringify(gs.currentCohortStatus)).to.include("active");
      expect(gs.totalCohorts.toNumber()).to.equal(1);
    });

    it("deadlines correctly computed from clock + config", async () => {
      const gs = await t.program.account.globalState.fetch(t.globalState);
      // currentCohortIndex stays at the active cohort's index until resolved.
      const idx = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(t.program.programId, idx);
      const cohort = await t.program.account.cohort.fetch(cohortPda);

      const start = cohort.tradingStart.toNumber();

      // trading_deadline = start + trading_window
      expect(cohort.tradingDeadline.toNumber()).to.equal(
        start + FAST_TRADING_WINDOW,
      );

      // measurement_deadline = trading_deadline + measurement
      expect(cohort.measurementDeadline.toNumber()).to.equal(
        start + FAST_TRADING_WINDOW + FAST_MEASUREMENT,
      );

      // settlement_deadline = measurement_deadline + observation + settlement_deadline_seconds
      const observationEnd =
        start + FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION;
      expect(cohort.settlementDeadline.toNumber()).to.equal(
        observationEnd + FAST_SETTLEMENT_DEADLINE,
      );

      // recovery_deadline = settlement_deadline + settlement_deadline_seconds
      expect(cohort.recoveryDeadline.toNumber()).to.equal(
        observationEnd + FAST_SETTLEMENT_DEADLINE + FAST_SETTLEMENT_DEADLINE,
      );
    });

    it("start cohort immediately after previous settles - succeeds", async () => {
      // Void the active cohort first to resolve it
      const gsNow = await t.program.account.globalState.fetch(t.globalState);
      const activeIdx = gsNow.currentCohortIndex.toNumber();
      const [activeCohort] = findCohortPda(t.program.programId, activeIdx);

      // Cohort 0 is active but empty. Void it to reach Idle.
      await voidCohort(t, activeCohort);

      // Now run a full cohort (start → buy → warp → submit → settle → claim)
      await runFullCohort(t);

      // Protocol should be idle now - start another cohort
      const gs2 = await t.program.account.globalState.fetch(t.globalState);
      expect(JSON.stringify(gs2.currentCohortStatus)).to.include("idle");

      const nextIdx = gs2.currentCohortIndex.toNumber();
      const cohort = await startCohort(t);
      expect(cohort).to.not.be.null;

      // Verify we can fetch the new cohort
      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.index.toNumber()).to.equal(nextIdx);
      expect(JSON.stringify(cohortData.status)).to.include("trading");

      // Clean up: void this cohort so tests below start clean
      await voidCohort(t, cohort);
    });
  });


  describe("error paths", () => {
    it("non-keeper → Unauthorized or ConstraintRaw", async () => {
      const gs = await t.program.account.globalState.fetch(t.globalState);
      const idx = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(t.program.programId, idx);

      await expectError(
        () =>
          t.program.methods
            .startCohort()
            .accounts({
              keeper: t.randomUser.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              emaState: t.emaState,
              cohort: cohortPda,
              systemProgram: SystemProgram.programId,
            } as any)
            .signers([t.randomUser])
            .rpc(),
        "Unauthorized",
      );
    });

    it("protocol paused → ProtocolPaused", async () => {
      // Pause the protocol
      await t.program.methods
        .updateConfig({
          keeper: null,
          mhiCapBps: null,
          premiumFeeBps: null,
          referralShareBps: null,
          keeperFeeLamports: null,
          minPositionLamports: null,
          maxPositionPerAddressBps: null,
          maxVaultRiskPerCohortBps: null,
          tradingWindowSeconds: null,
          measurementSeconds: null,
          observationSeconds: null,
          settlementDeadlineSeconds: null,
          claimExpirySeconds: null,
          mhiFloorBps: null,
          mhiMaxDeltaBps: null,
          minPremiumLamports: null,
          maxPositionCollateralBps: null,
          paused: true,
         
        } as any)
        .accounts({
          authority: t.authority.publicKey,
          globalState: t.globalState,
        } as any)
        .rpc();

      const gs = await t.program.account.globalState.fetch(t.globalState);
      const idx = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(t.program.programId, idx);

      await expectError(
        () =>
          t.program.methods
            .startCohort()
            .accounts({
              keeper: t.keeper.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              emaState: t.emaState,
              cohort: cohortPda,
              systemProgram: SystemProgram.programId,
            } as any)
            .signers([t.keeper])
            .rpc(),
        "ProtocolPaused",
      );

      // Unpause
      await t.program.methods
        .updateConfig({
          keeper: null,
          mhiCapBps: null,
          premiumFeeBps: null,
          referralShareBps: null,
          keeperFeeLamports: null,
          minPositionLamports: null,
          maxPositionPerAddressBps: null,
          maxVaultRiskPerCohortBps: null,
          tradingWindowSeconds: null,
          measurementSeconds: null,
          observationSeconds: null,
          settlementDeadlineSeconds: null,
          claimExpirySeconds: null,
          mhiFloorBps: null,
          mhiMaxDeltaBps: null,
          minPremiumLamports: null,
          maxPositionCollateralBps: null,
          paused: false,
         
        } as any)
        .accounts({
          authority: t.authority.publicKey,
          globalState: t.globalState,
        } as any)
        .rpc();
    });

    it("previous cohort not resolved → PreviousCohortNotResolved or already in use", async () => {
      // Start a cohort so protocol is Active
      const cohort = await startCohort(t);

      // Warp for fresh blockhash (identical instruction otherwise)
      await warpTime(t.context, 1);
      // Try to start another - should fail
      const gs = await t.program.account.globalState.fetch(t.globalState);
      const idx = gs.currentCohortIndex.toNumber();
      const [nextCohortPda] = findCohortPda(t.program.programId, idx);

      // Anchor's init constraint may fire before the handler's status check,
      // so either PreviousCohortNotResolved or "already in use" is valid.
      try {
        await t.program.methods
          .startCohort()
          .accounts({
            keeper: t.keeper.publicKey,
            globalState: t.globalState,
            vault: t.vault,
            emaState: t.emaState,
            cohort: nextCohortPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([t.keeper])
          .rpc();
        throw new Error("Should have thrown");
      } catch (err: any) {
        const errStr = err.toString() + JSON.stringify(err.logs ?? []);
        const valid =
          errStr.includes("PreviousCohortNotResolved") ||
          errStr.includes("already in use");
        if (!valid) throw err;
      }

      // Clean up: void the active cohort
      await voidCohort(t, cohort);
    });
  });
});
