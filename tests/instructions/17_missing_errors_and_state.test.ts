import { expect } from "chai";
import { SystemProgram, PublicKey } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, warpTime,
  voidCohort, runFullCohort, SOL,
  findPositionPda,
  currentAtmStrike, currentLiveStrikes,
  FAST_TRADING_WINDOW,
} from "./_setup";

describe("17 - missing errors and state verification", () => {

  // ═══════════════════════════════════════════════════════════════════════
  // 1. buy_call - duplicate nonce (Position PDA already exists)
  // ═══════════════════════════════════════════════════════════════════════

  describe("buy_call - duplicate nonce", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("buying with same strike + same nonce twice fails with 'already in use'", async () => {
      const cohort = await startCohort(t);
      const atm = await currentAtmStrike(t);

      // First buy succeeds
      await buyCall(t, cohort, { strikeBps: atm, nonce: 0 });

      // Warp for fresh blockhash (identical instruction bytes otherwise)
      await warpTime(t.context, 1);

      // Second buy with identical strike + nonce should fail - PDA already initialized
      const [posPda] = findPositionPda(
        t.program.programId, cohort, t.buyer.publicKey, atm, 0,
      );

      await expectError(
        () =>
          t.program.methods
            .buyCall(atm, SOL(0.05), 0)
            .accounts({
              buyer: t.buyer.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              p2pPool: t.p2pPool,
              cohort,
              emaState: t.emaState,
              position: posPda,
              systemProgram: SystemProgram.programId,
            } as any)
            .signers([t.buyer])
            .rpc(),
        "already in use",
      );

      // Cleanup: void the cohort
      const positions = [posPda];
      await voidCohort(t, cohort, positions);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. submit_mhi - token_count < MIN_COHORT_TOKENS (10) → InvalidConfig
  // ═══════════════════════════════════════════════════════════════════════

  describe("submit_mhi - token_count below minimum", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("token_count=9 → InvalidConfig", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);

      await expectError(
        () =>
          t.program.methods
            .submitMhi(14_000, 9, Array.from({ length: 32 }, () => 0))
            .accounts({
              keeper: t.keeper.publicKey,
              globalState: t.globalState,
              cohort,
              emaState: t.emaState,
              vault: t.vault,
            } as any)
            .signers([t.keeper])
            .rpc(),
        "InvalidConfig",
      );

      // Cleanup: submit properly and settle
      await submitMhi(t, cohort, 14_000);
      await settleBatch(t, cohort, []);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. settle_batch - MhiNotSubmitted (direct test)
  // ═══════════════════════════════════════════════════════════════════════

  describe("settle_batch - MhiNotSubmitted", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("settle without MHI submitted → MhiNotSubmitted", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      await warpPastObservation(t.context);

      // Do NOT submit MHI - try to settle directly
      await expectError(
        () => settleBatch(t, cohort, [pos]),
        "MhiNotSubmitted",
      );

      // Cleanup: submit MHI, settle, claim
      await submitMhi(t, cohort, await currentAtmStrike(t));
      await settleBatch(t, cohort, [pos]);
      await claimPosition(t, cohort, pos, t.buyer);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. void_cohort - PositionsAlreadySettled (unreachable in current flow)
  // ═══════════════════════════════════════════════════════════════════════
  //
  // This error path is unreachable because:
  // - void_cohort requires `!cohort.has_mhi()` (MhiAlreadySubmitted fires first)
  // - settle_batch requires `cohort.has_mhi()`
  // - Therefore positions cannot be settled without MHI, and void cannot
  //   happen after MHI is submitted. The PositionsAlreadySettled check is
  //   defense-in-depth only.
  //

  // ═══════════════════════════════════════════════════════════════════════
  // 5. submit_mhi - EMA state updated for all strikes after submission
  // ═══════════════════════════════════════════════════════════════════════

  describe("submit_mhi - EMA state updates", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("at least one strike EMA changes after submitMhi", async () => {
      const emaBefore = await t.program.account.emaState.fetch(t.emaState);
      const emaValuesBefore = (emaBefore as any).slots.map(
        (e: any) => e.fastFracBps,
      );

      // Run a full cohort to trigger EMA update via submitMhi
      await runFullCohort(t, 14_000, [{}]);

      const emaAfter = await t.program.account.emaState.fetch(t.emaState);
      const emaValuesAfter = (emaAfter as any).slots.map(
        (e: any) => e.fastFracBps,
      );

      // At least one EMA value should have changed
      let anyChanged = false;
      for (let i = 0; i < emaValuesBefore.length; i++) {
        if (emaValuesBefore[i] !== emaValuesAfter[i]) {
          anyChanged = true;
          break;
        }
      }
      expect(anyChanged).to.equal(true, "Expected at least one EMA value to change after submitMhi");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. submit_mhi - total_volume_lamports updated
  // ═══════════════════════════════════════════════════════════════════════

  describe("submit_mhi - total_volume_lamports updated", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("globalState.totalVolumeLamports increases by cohort call volume", async () => {
      const gsBefore = await t.program.account.globalState.fetch(t.globalState);
      const volumeBefore = gsBefore.totalVolumeLamports.toNumber();

      const size = SOL(0.05);
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { size });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));

      const gsAfter = await t.program.account.globalState.fetch(t.globalState);
      const volumeAfter = gsAfter.totalVolumeLamports.toNumber();

      // Volume should have increased by the cohort's total call volume
      const cohortData = await t.program.account.cohort.fetch(cohort);
      const cohortVolume = cohortData.totalCallVolumeLamports.toNumber();
      expect(volumeAfter).to.equal(volumeBefore + cohortVolume);

      // Cleanup
      await settleBatch(t, cohort, [pos]);
      await claimPosition(t, cohort, pos, t.buyer);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. settle_batch - positions_settled counter increments per position
  // ═══════════════════════════════════════════════════════════════════════

  describe("settle_batch - positions_settled counter", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("settles 1, then 2 more - counter goes 1 then 3", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const pos1 = await buyCall(t, cohort, { strikeBps: live[0], nonce: 0 });
      const pos2 = await buyCall(t, cohort, { strikeBps: live[2], nonce: 1 });
      const pos3 = await buyCall(t, cohort, { strikeBps: live[5], nonce: 2 });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, live[3]!);

      // Settle 1 position
      await settleBatch(t, cohort, [pos1]);
      let cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.positionsSettled).to.equal(1);

      // Settle 2 more positions
      await settleBatch(t, cohort, [pos2, pos3]);
      cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.positionsSettled).to.equal(3);

      // Cleanup
      await claimPosition(t, cohort, pos1, t.buyer);
      await claimPosition(t, cohort, pos2, t.buyer);
      await claimPosition(t, cohort, pos3, t.buyer);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8. settle_batch - ATM position (MHI exactly at strike) → payout = 0
  // ═══════════════════════════════════════════════════════════════════════

  describe("settle_batch - ATM position payout", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("MHI exactly at strike → payout = 0", async () => {
      const cohort = await startCohort(t);
      const strike = await currentAtmStrike(t);
      const pos = await buyCall(t, cohort, { strikeBps: strike });
      await warpPastObservation(t.context);

      // Submit MHI equal to the strike (ATM). Clamping may adjust if
      // lastMhiBps is far away — we read the actual stored MHI after.
      await submitMhi(t, cohort, strike);

      const cohortData = await t.program.account.cohort.fetch(cohort);
      const actualMhi = cohortData.mhiBps;

      await settleBatch(t, cohort, [pos]);

      const posData = await t.program.account.position.fetch(pos);

      if (actualMhi === strike) {
        // ATM: payout should be exactly 0
        expect(posData.payoutLamports.toNumber()).to.equal(0);
      } else if (actualMhi > strike) {
        // Clamped above strike - ITM, payout > 0
        expect(posData.payoutLamports.toNumber()).to.be.greaterThan(0);
      } else {
        // Clamped below strike - OTM, payout = 0
        expect(posData.payoutLamports.toNumber()).to.equal(0);
      }

      // Either way, position is settled
      expect(posData.settled).to.equal(true);

      // Cleanup
      await claimPosition(t, cohort, pos, t.buyer);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. settle_batch - already-settled position in batch is silently skipped
  // ═══════════════════════════════════════════════════════════════════════

  describe("settle_batch - already-settled position skipped", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("re-settling [settled, unsettled] succeeds - only unsettled settles", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const pos1 = await buyCall(t, cohort, { strikeBps: live[2], nonce: 0 });
      const pos2 = await buyCall(t, cohort, { strikeBps: live[5], nonce: 1 });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, live[3]!);

      // Settle pos1 only (partial)
      await settleBatch(t, cohort, [pos1]);
      let cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.positionsSettled).to.equal(1);

      // Now settle [pos1, pos2] together - pos1 already settled, should be skipped
      await settleBatch(t, cohort, [pos1, pos2]);
      cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.positionsSettled).to.equal(2);

      // Both positions are settled
      const p1 = await t.program.account.position.fetch(pos1);
      const p2 = await t.program.account.position.fetch(pos2);
      expect(p1.settled).to.equal(true);
      expect(p2.settled).to.equal(true);

      // Cleanup
      await claimPosition(t, cohort, pos1, t.buyer);
      await claimPosition(t, cohort, pos2, t.buyer);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10. buy_call on non-Trading cohort (Measuring status)
  // ═══════════════════════════════════════════════════════════════════════

  describe("buy_call - Measuring status cohort", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("buying after trading window closes → TradingWindowClosed", async () => {
      const cohort = await startCohort(t);
      const atm = await currentAtmStrike(t);

      // Warp past trading window but NOT past observation
      // (cohort is in Measuring state)
      await warpTime(t.context, FAST_TRADING_WINDOW + 1);

      const [posPda] = findPositionPda(
        t.program.programId, cohort, t.buyer.publicKey, atm, 0,
      );

      await expectError(
        () =>
          t.program.methods
            .buyCall(atm, SOL(0.05), 0)
            .accounts({
              buyer: t.buyer.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              p2pPool: t.p2pPool,
              cohort,
              emaState: t.emaState,
              position: posPda,
              systemProgram: SystemProgram.programId,
            } as any)
            .signers([t.buyer])
            .rpc(),
        "TradingWindowClosed",
      );

      // Cleanup: void the cohort
      await voidCohort(t, cohort);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11. propose_authority - propose same address as current authority
  // ═══════════════════════════════════════════════════════════════════════

  describe("propose_authority - self-proposal", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("proposing authority's own pubkey succeeds (valid no-op)", async () => {
      await t.program.methods
        .proposeAuthority(t.authority.publicKey)
        .accounts({
          authority: t.authority.publicKey,
          globalState: t.globalState,
        } as any)
        .rpc();

      const gs = await t.program.account.globalState.fetch(t.globalState);
      expect(gs.pendingAuthority.toBase58()).to.equal(
        t.authority.publicKey.toBase58(),
      );

      // Clean up: cancel the pending transfer
      await t.program.methods
        .cancelAuthorityTransfer()
        .accounts({
          authority: t.authority.publicKey,
          globalState: t.globalState,
        } as any)
        .rpc();

      const gsAfter = await t.program.account.globalState.fetch(t.globalState);
      expect(gsAfter.pendingAuthority.toBase58()).to.equal(
        PublicKey.default.toBase58(),
      );
    });
  });
});
