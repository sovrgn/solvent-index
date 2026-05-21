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
  deriveStrikes,
  TestCtx,
  STRIKE_ANCHOR_DEFAULT_BPS,
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
        .startCohort(deriveStrikes(STRIKE_ANCHOR_DEFAULT_BPS))
        .accounts({
          keeper: t.keeper.publicKey,
          globalState: t.globalState,
          vault: t.vault,
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

    it("active_cohorts and total_cohorts increment", async () => {
      const gs = await t.program.account.globalState.fetch(t.globalState);
      // ProtocolStatus enum was replaced by active_cohorts counter.
      expect(gs.activeCohorts).to.equal(1);
      expect(gs.totalCohorts.toNumber()).to.equal(1);
    });

    it("deadlines correctly computed from clock + config", async () => {
      const gs = await t.program.account.globalState.fetch(t.globalState);
      // currentCohortIndex was incremented; the active cohort lives at idx-1.
      const idx = gs.currentCohortIndex.toNumber() - 1;
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
      // Resolve the active cohort first via void.
      const gsNow = await t.program.account.globalState.fetch(t.globalState);
      const activeIdx = gsNow.currentCohortIndex.toNumber() - 1;
      const [activeCohort] = findCohortPda(t.program.programId, activeIdx);

      // Cohort 0 is active but empty. Void it.
      await voidCohort(t, activeCohort);

      // Now run a full cohort (start → buy → warp → submit → settle → claim)
      await runFullCohort(t);

      // After settle, the cohort is resolved; active_cohorts should drop to 0.
      const gs2 = await t.program.account.globalState.fetch(t.globalState);
      expect(gs2.activeCohorts).to.equal(0);

      const nextIdx = gs2.currentCohortIndex.toNumber();
      const cohort = await startCohort(t);
      expect(cohort).to.not.be.null;

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
            .startCohort(deriveStrikes(STRIKE_ANCHOR_DEFAULT_BPS))
            .accounts({
              keeper: t.randomUser.publicKey,
              globalState: t.globalState,
              vault: t.vault,
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
            .startCohort(deriveStrikes(STRIKE_ANCHOR_DEFAULT_BPS))
            .accounts({
              keeper: t.keeper.publicKey,
              globalState: t.globalState,
              vault: t.vault,
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

    it("active_cohorts at cap → PreviousCohortNotResolved or already in use", async () => {
      // Start cohorts until we hit the MAX_ACTIVE_COHORTS = 3 cap.
      const started: anchor.web3.PublicKey[] = [];
      for (let i = 0; i < 3; i++) {
        started.push(await startCohort(t));
      }

      // Warp for fresh blockhash
      await warpTime(t.context, 1);
      const gs = await t.program.account.globalState.fetch(t.globalState);
      const idx = gs.currentCohortIndex.toNumber();
      const [nextCohortPda] = findCohortPda(t.program.programId, idx);

      // 4th attempt should fail — either at the active_cohorts gate, or via
      // Anchor's `init` constraint if the PDA happens to collide.
      try {
        await t.program.methods
          .startCohort(deriveStrikes(STRIKE_ANCHOR_DEFAULT_BPS))
          .accounts({
            keeper: t.keeper.publicKey,
            globalState: t.globalState,
            vault: t.vault,
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

      // Clean up: void all the active cohorts
      for (const c of started) {
        await voidCohort(t, c);
      }
    });
  });
});
