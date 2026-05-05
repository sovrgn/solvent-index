import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, warpTime, warpToTimestamp, assertVaultConservation,
  voidCohort, runFullCohort, SOL, getBalance, accountExists,
  FAST_TRADING_WINDOW, FAST_MEASUREMENT, FAST_OBSERVATION,
  FAST_SETTLEMENT_DEADLINE, FAST_CLAIM_EXPIRY,
  findPositionPda,
} from "./_setup";

describe("cross-instruction state attacks", () => {
  let t: TestCtx;

  before(async () => { t = await setupProtocol(); });


  describe("ordering exploits", () => {
    it("settle_batch on Settled cohort → InvalidCohortStatus", async () => {
      const { cohort, positions } = await runFullCohort(t, 14_000, [{}], { skipClaim: true });
      await warpTime(t.context, 1);
      await expectError(
        () => settleBatch(t, cohort, positions),
        "InvalidCohortStatus",
      );
      await claimPosition(t, cohort, positions[0], t.buyer);
    });

    it("settle_batch on Voided cohort → MhiNotSubmitted (first check)", async () => {
      // Program checks MhiNotSubmitted before InvalidCohortStatus.
      // A voided cohort has no MHI, so MhiNotSubmitted fires first.
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      await voidCohort(t, cohort, [pos]);
      await warpTime(t.context, 1);
      await expectError(
        () => settleBatch(t, cohort, [pos]),
        "MhiNotSubmitted",
      );
      await claimPosition(t, cohort, pos, t.buyer);
    });

    it("submit_mhi on Settled cohort → InvalidCohortStatus (status check fires first)", async () => {
      // Program checks status (Trading/Measuring) before MhiAlreadySubmitted.
      // A Settled cohort fails the status check first.
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 12_000);
      await settleBatch(t, cohort, []);
      // Now cohort is Settled
      await warpTime(t.context, 1);
      await expectError(
        () => submitMhi(t, cohort, 13_000),
        "InvalidCohortStatus",
      );
    });

    it("buy_call on Measuring cohort → TradingWindowClosed", async () => {
      const cohort = await startCohort(t);
      await warpTime(t.context, FAST_TRADING_WINDOW + 1);
      const [posPda] = findPositionPda(t.program.programId, cohort, t.buyer.publicKey, 12_000, 0);
      await expectError(
        () => t.program.methods
          .buyCall(12_000, SOL(0.05), 0)
          .accounts({
            buyer: t.buyer.publicKey,
            globalState: t.globalState,
            vault: t.vault,
            cohort,
            emaState: t.emaState,
            position: posPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([t.buyer])
          .rpc(),
        "TradingWindowClosed",
      );
      await voidCohort(t, cohort);
    });

    it("start_cohort while unclaimed positions exist - succeeds (Idle after settle)", async () => {
      await runFullCohort(t, 14_000, [{}], { skipClaim: true });
      // Protocol is Idle (all settled), positions unclaimed but that doesn't block
      const cohort2 = await startCohort(t);
      expect(cohort2).to.not.be.null;
      await voidCohort(t, cohort2);
    });
  });


  describe("vault accounting consistency", () => {
    it("invariant holds after buy_call", async () => {
      const cohort = await startCohort(t);
      await buyCall(t, cohort);
      await assertVaultConservation(t);
      await voidCohort(t, cohort, []); // void without refunding for cleanup
    });

    it("invariant holds after settle_batch", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 15_000);
      await settleBatch(t, cohort, [pos]);
      await assertVaultConservation(t);
      await claimPosition(t, cohort, pos, t.buyer);
    });

    it("invariant holds after void_cohort", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      await voidCohort(t, cohort, [pos]);
      await assertVaultConservation(t);
      await claimPosition(t, cohort, pos, t.buyer);
    });

    it("invariant holds after seed_vault", async () => {
      await t.program.methods
        .seedVault(SOL(1))
        .accounts({
          authority: t.authority.publicKey,
          globalState: t.globalState,
          vault: t.vault,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      await assertVaultConservation(t);
    });

    it("vault available after full cycle = seed + premiums - payouts", async () => {
      const vaultBefore = await t.program.account.vault.fetch(t.vault);
      const availBefore = vaultBefore.availableLamports.toNumber();

      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { strikeBps: 12_000 });

      const posData = await t.program.account.position.fetch(pos);
      const premium = posData.vaultPremiumLamports.toNumber();

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 15_000); // ITM
      await settleBatch(t, cohort, [pos]);

      const posSettled = await t.program.account.position.fetch(pos);
      const payout = posSettled.payoutLamports.toNumber();

      await claimPosition(t, cohort, pos, t.buyer);

      const vaultAfter = await t.program.account.vault.fetch(t.vault);
      expect(vaultAfter.availableLamports.toNumber()).to.equal(
        availBefore + premium - payout,
      );
      await assertVaultConservation(t);
    });
  });


  describe("timing boundaries", () => {
    it("buy_call at trading_deadline - 1 succeeds, at trading_deadline fails", async () => {
      const cohort = await startCohort(t);
      const cohortData = await t.program.account.cohort.fetch(cohort);
      const deadline = cohortData.tradingDeadline.toNumber();

      // Warp to deadline - 1
      await warpToTimestamp(t.context, deadline - 1);
      const pos = await buyCall(t, cohort, { strikeBps: 12_000, nonce: 0 });
      expect(pos).to.not.be.null;

      // Warp to deadline exactly
      await warpToTimestamp(t.context, deadline);
      const [posPda2] = findPositionPda(t.program.programId, cohort, t.buyer.publicKey, 12_000, 1);
      await expectError(
        () => t.program.methods
          .buyCall(12_000, SOL(0.05), 1)
          .accounts({
            buyer: t.buyer.publicKey,
            globalState: t.globalState,
            vault: t.vault,
            cohort,
            emaState: t.emaState,
            position: posPda2,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([t.buyer])
          .rpc(),
        "TradingWindowClosed",
      );
      await voidCohort(t, cohort, [pos]);
      await claimPosition(t, cohort, pos, t.buyer);
    });

    it("settle by non-keeper at settlement_deadline succeeds", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort);

      const cohortData = await t.program.account.cohort.fetch(cohort);
      const deadline = cohortData.settlementDeadline.toNumber();
      await warpToTimestamp(t.context, deadline);

      // Non-keeper should succeed at or after deadline
      await settleBatch(t, cohort, [pos], t.randomUser);
      await claimPosition(t, cohort, pos, t.buyer);
    });

    it("claim at claim_deadline fails (< not <=)", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { strikeBps: 12_000 });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 15_000);
      await settleBatch(t, cohort, [pos]);

      const posData = await t.program.account.position.fetch(pos);
      const claimDeadline = posData.claimDeadline.toNumber();

      // At exactly claim_deadline → claim fails (program checks clock < deadline)
      await warpToTimestamp(t.context, claimDeadline);
      await expectError(
        () => claimPosition(t, cohort, pos, t.buyer),
        "ClaimExpired",
      );

      // Expire needs clock > deadline (grace period), so warp 1 more second
      await warpTime(t.context, 1);
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


  describe("position PDA integrity", () => {
    it("same user, same strike, same nonce in different cohorts → distinct PDAs", async () => {
      const cohort1 = await startCohort(t);
      const pos1 = await buyCall(t, cohort1, { strikeBps: 12_000, nonce: 0 });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort1);
      await settleBatch(t, cohort1, [pos1]);
      await claimPosition(t, cohort1, pos1, t.buyer);

      const cohort2 = await startCohort(t);
      const pos2 = await buyCall(t, cohort2, { strikeBps: 12_000, nonce: 0 });

      expect(pos1.toBase58()).to.not.equal(pos2.toBase58());
      await warpPastObservation(t.context);
      await submitMhi(t, cohort2);
      await settleBatch(t, cohort2, [pos2]);
      await claimPosition(t, cohort2, pos2, t.buyer);
    });

    it("position PDA does not exist after claim", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort);
      await settleBatch(t, cohort, [pos]);
      await claimPosition(t, cohort, pos, t.buyer);

      expect(await accountExists(t.context.banksClient, pos)).to.be.false;
    });

    it("position PDA does not exist after expire", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort);
      await settleBatch(t, cohort, [pos]);
      await warpTime(t.context, FAST_CLAIM_EXPIRY + 1);

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

      expect(await accountExists(t.context.banksClient, pos)).to.be.false;
    });
  });
});
