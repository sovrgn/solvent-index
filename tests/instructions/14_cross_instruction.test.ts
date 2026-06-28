import { expect } from "chai";
import { SystemProgram } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, warpTime, warpToTimestamp, assertVaultConservation,
  voidCohort, runFullCohort, SOL, accountExists,
  currentAtmStrike, currentLiveStrikes,
  FAST_TRADING_WINDOW, FAST_CLAIM_EXPIRY,
  findPositionPda,
} from "./_setup";

describe("cross-instruction state attacks", () => {
  let t: TestCtx;

  before(async () => { t = await setupProtocol(); });


  describe("ordering exploits", () => {
    it("settle_batch on Settled cohort → InvalidCohortStatus", async () => {
      const { cohort, positions } = await runFullCohort(t, undefined, [{}], { skipClaim: true });
      await warpTime(t.context, 1);
      await expectError(
        () => settleBatch(t, cohort, positions),
        "InvalidCohortStatus",
      );
      await claimPosition(t, cohort, positions[0], t.buyer);
    });

    it("settle_batch on Voided cohort → MhiNotSubmitted (first check)", async () => {
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

    it("submit_mhi on Settled cohort → InvalidCohortStatus", async () => {
      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      const atm = await currentAtmStrike(t);
      await submitMhi(t, cohort, atm);
      await settleBatch(t, cohort, []);
      await warpTime(t.context, 1);
      await expectError(
        () => submitMhi(t, cohort, atm),
        "InvalidCohortStatus",
      );
    });

    it("buy_call on Measuring cohort → TradingWindowClosed", async () => {
      const cohort = await startCohort(t);
      const atm = await currentAtmStrike(t);
      await warpTime(t.context, FAST_TRADING_WINDOW + 1);
      const [posPda] = findPositionPda(t.program.programId, cohort, t.buyer.publicKey, atm, 0);
      await expectError(
        () => t.program.methods
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
      await voidCohort(t, cohort);
    });

    it("start_cohort while unclaimed positions exist - succeeds (active_cohorts decrements after settle)", async () => {
      await runFullCohort(t, undefined, [{}], { skipClaim: true });
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
      await voidCohort(t, cohort, []);
    });

    it("invariant holds after settle_batch", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const pos = await buyCall(t, cohort, { strikeBps: live[2] });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, live[5]!); // ITM
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
      const live = await currentLiveStrikes(t);
      const pos = await buyCall(t, cohort, { strikeBps: live[2] });

      const posData = await t.program.account.position.fetch(pos);
      const premium = posData.vaultPremiumLamports.toNumber();

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, live[5]!); // ITM
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
      const atm = await currentAtmStrike(t);
      const cohortData = await t.program.account.cohort.fetch(cohort);
      const deadline = cohortData.tradingDeadline.toNumber();

      await warpToTimestamp(t.context, deadline - 1);
      const pos = await buyCall(t, cohort, { strikeBps: atm, nonce: 0 });
      expect(pos).to.not.be.null;

      await warpToTimestamp(t.context, deadline);
      const [posPda2] = findPositionPda(t.program.programId, cohort, t.buyer.publicKey, atm, 1);
      await expectError(
        () => t.program.methods
          .buyCall(atm, SOL(0.05), 1)
          .accounts({
            buyer: t.buyer.publicKey,
            globalState: t.globalState,
            vault: t.vault,
            p2pPool: t.p2pPool,
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
      await submitMhi(t, cohort, await currentAtmStrike(t));

      const cohortData = await t.program.account.cohort.fetch(cohort);
      const deadline = cohortData.settlementDeadline.toNumber();
      await warpToTimestamp(t.context, deadline);

      await settleBatch(t, cohort, [pos], t.randomUser);
      await claimPosition(t, cohort, pos, t.buyer);
    });

    it.skip("[obsolete: claim removed] claim at claim_deadline fails", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const pos = await buyCall(t, cohort, { strikeBps: live[2] });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, live[5]!);
      await settleBatch(t, cohort, [pos]);

      const posData = await t.program.account.position.fetch(pos);
      const claimDeadline = posData.claimDeadline.toNumber();

      await warpToTimestamp(t.context, claimDeadline);
      await expectError(
        () => claimPosition(t, cohort, pos, t.buyer),
        "ClaimExpired",
      );

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
      const atm1 = await currentAtmStrike(t);
      const pos1 = await buyCall(t, cohort1, { strikeBps: atm1, nonce: 0 });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort1, atm1);
      await settleBatch(t, cohort1, [pos1]);
      await claimPosition(t, cohort1, pos1, t.buyer);

      const cohort2 = await startCohort(t);
      const atm2 = await currentAtmStrike(t);
      const pos2 = await buyCall(t, cohort2, { strikeBps: atm2, nonce: 0 });

      // Cohort PDAs differ even if buyer/strike/nonce match (cohort key is in the seed).
      expect(pos1.toBase58()).to.not.equal(pos2.toBase58());
      await warpPastObservation(t.context);
      await submitMhi(t, cohort2, atm2);
      await settleBatch(t, cohort2, [pos2]);
      await claimPosition(t, cohort2, pos2, t.buyer);
    });

    it.skip("[obsolete: claim removed] position PDA does not exist after claim", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));
      await settleBatch(t, cohort, [pos]);
      await claimPosition(t, cohort, pos, t.buyer);

      expect(await accountExists(t.context.banksClient, pos)).to.be.false;
    });

    it.skip("[obsolete: expire removed] position PDA does not exist after expire", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));
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
