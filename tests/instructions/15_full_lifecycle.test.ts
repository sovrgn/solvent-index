import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import {
  setupProtocol, TestCtx,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, warpTime, assertVaultConservation,
  voidCohort, runFullCohort, SOL, getBalance,
  FAST_SETTLEMENT_DEADLINE, FAST_CLAIM_EXPIRY,
  DEFAULT_STRIKES_BPS,
} from "./_setup";

describe("full lifecycle", () => {


  describe("complete cycle - init → seed → start → buy → submit → settle → claim", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("runs full cycle with vault conservation at every step", async () => {
      await assertVaultConservation(t);

      const cohort = await startCohort(t);
      await assertVaultConservation(t);

      const pos = await buyCall(t, cohort, { strikeBps: 12_000, size: SOL(0.5) });
      await assertVaultConservation(t);

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 15_000);
      await assertVaultConservation(t);

      await settleBatch(t, cohort, [pos]);
      await assertVaultConservation(t);

      await claimPosition(t, cohort, pos, t.buyer);
      await assertVaultConservation(t);

      const gs = await t.program.account.globalState.fetch(t.globalState);
      expect(gs.currentCohortIndex.toNumber()).to.be.greaterThan(0);

      const vault = await t.program.account.vault.fetch(t.vault);
      expect(vault.activeCollateralLamports.toNumber()).to.equal(0);
      expect(vault.unclaimedPayoutsLamports.toNumber()).to.equal(0);
    });
  });


  describe("multiple cohorts sequential", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("runs 3 complete cohorts, cohort_index increments correctly", async () => {
      for (let i = 0; i < 3; i++) {
        const gs = await t.program.account.globalState.fetch(t.globalState);
        expect(gs.currentCohortIndex.toNumber()).to.equal(i);

        await runFullCohort(t, 12_000 + i * 1000, [
          { strikeBps: 10_000, nonce: 0 },
          { strikeBps: 12_000, nonce: 0, buyer: t.buyer2 },
        ]);
        await assertVaultConservation(t);
      }

      const gsFinal = await t.program.account.globalState.fetch(t.globalState);
      expect(gsFinal.currentCohortIndex.toNumber()).to.equal(3);
    });
  });


  describe("void path - keeper failure recovery", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("init → seed → start → buy → void → claim refund", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { strikeBps: 12_000, size: SOL(0.2) });

      const posData = await t.program.account.position.fetch(pos);
      const vaultPremium = posData.vaultPremiumLamports.toNumber();

      const vaultBefore = await t.program.account.vault.fetch(t.vault);
      const collateral = vaultBefore.activeCollateralLamports.toNumber();
      expect(collateral).to.be.greaterThan(0);

      // Keeper "dies" - void after recovery deadline
      await voidCohort(t, cohort, [pos]);

      const vaultAfterVoid = await t.program.account.vault.fetch(t.vault);
      expect(vaultAfterVoid.activeCollateralLamports.toNumber()).to.equal(0);

      // Buyer claims refund
      const balBefore = await getBalance(t.context.banksClient, t.buyer.publicKey);
      await claimPosition(t, cohort, pos, t.buyer);
      const balAfter = await getBalance(t.context.banksClient, t.buyer.publicKey);

      // Refund should be approximately vault_premium (minus tx fee)
      expect(balAfter - balBefore).to.be.greaterThan(0);
      await assertVaultConservation(t);
    });
  });


  describe("mixed outcomes - ITM and OTM in same cohort", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("correct payouts for each position", async () => {
      const cohort = await startCohort(t);
      const posITM = await buyCall(t, cohort, { strikeBps: 10_000, size: SOL(0.1), nonce: 0 });
      const posOTM = await buyCall(t, cohort, { strikeBps: 20_000, size: SOL(0.1), nonce: 1 });

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 15_000); // 10000 ITM, 20000 OTM
      await settleBatch(t, cohort, [posITM, posOTM]);

      const itmData = await t.program.account.position.fetch(posITM);
      const otmData = await t.program.account.position.fetch(posOTM);

      expect(itmData.payoutLamports.toNumber()).to.be.greaterThan(0);
      expect(otmData.payoutLamports.toNumber()).to.equal(0);

      await claimPosition(t, cohort, posITM, t.buyer);
      await claimPosition(t, cohort, posOTM, t.buyer);
      await assertVaultConservation(t);
    });
  });


  describe("all 7 strikes in single cohort", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("positions at all strikes settle correctly", async () => {
      const cohort = await startCohort(t);
      const positions = [];
      for (let i = 0; i < DEFAULT_STRIKES_BPS.length; i++) {
        const pos = await buyCall(t, cohort, {
          strikeBps: DEFAULT_STRIKES_BPS[i],
          size: SOL(0.02),
          nonce: i,
        });
        positions.push(pos);
      }

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 14_000); // 10k,11k,12k ITM; 15k,20k OTM
      await settleBatch(t, cohort, positions);

      for (let i = 0; i < positions.length; i++) {
        const data = await t.program.account.position.fetch(positions[i]);
        expect(data.settled).to.equal(true);
        if (DEFAULT_STRIKES_BPS[i] < 14_000) {
          expect(data.payoutLamports.toNumber()).to.be.greaterThan(0);
        } else {
          expect(data.payoutLamports.toNumber()).to.equal(0);
        }
        await claimPosition(t, cohort, positions[i], t.buyer);
      }

      await assertVaultConservation(t);
    });
  });


  describe("expire path - unclaimed payout returns to vault", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("settle → wait → expire → vault.available increases by payout", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { strikeBps: 12_000 });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 15_000);
      await settleBatch(t, cohort, [pos]);

      const posData = await t.program.account.position.fetch(pos);
      const payout = posData.payoutLamports.toNumber();
      expect(payout).to.be.greaterThan(0);

      await warpTime(t.context, FAST_CLAIM_EXPIRY + 1);

      const vaultBefore = await t.program.account.vault.fetch(t.vault);
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

      const vaultAfter = await t.program.account.vault.fetch(t.vault);
      expect(vaultAfter.availableLamports.toNumber()).to.equal(
        vaultBefore.availableLamports.toNumber() + payout,
      );
      expect(vaultAfter.unclaimedPayoutsLamports.toNumber()).to.equal(
        vaultBefore.unclaimedPayoutsLamports.toNumber() - payout,
      );
      await assertVaultConservation(t);
    });
  });


  describe("vault solvency - adversarial max-payout scenario", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol({ seedSol: 10 }); });

    it("max positions at 1.0x strike, MHI at cap - vault can pay all", async () => {
      const cohort = await startCohort(t);

      // Buy 2 positions at 1.0x strike (maximum payout exposure)
      const pos1 = await buyCall(t, cohort, { strikeBps: 10_000, size: SOL(0.1), nonce: 0 });
      const pos2 = await buyCall(t, cohort, { strikeBps: 10_000, size: SOL(0.1), nonce: 1, buyer: t.buyer2 });

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 30_000); // MHI at cap - maximum payout

      await settleBatch(t, cohort, [pos1, pos2]);

      // Both positions should have maximum payout
      const d1 = await t.program.account.position.fetch(pos1);
      const d2 = await t.program.account.position.fetch(pos2);
      // payoff = (30000 - 10000) / 10000 * size = 2.0 * size
      expect(d1.payoutLamports.toNumber()).to.equal(200_000_000);
      expect(d2.payoutLamports.toNumber()).to.equal(200_000_000);

      // Vault must be able to pay both
      await claimPosition(t, cohort, pos1, t.buyer);
      await claimPosition(t, cohort, pos2, t.buyer2);
      await assertVaultConservation(t);

      const vault = await t.program.account.vault.fetch(t.vault);
      expect(vault.activeCollateralLamports.toNumber()).to.equal(0);
      expect(vault.unclaimedPayoutsLamports.toNumber()).to.equal(0);
      // Vault should still have positive balance (seed + premiums - payouts)
      expect(vault.availableLamports.toNumber()).to.be.greaterThan(0);
    });
  });


  describe("stress - many positions, multi-batch settlement", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol({ seedSol: 50 }); });

    it("14 positions across all strikes, settled in batches", async () => {
      const cohort = await startCohort(t);
      const positions = [];

      // 2 positions per strike across 7 strikes = 14 positions
      for (let s = 0; s < DEFAULT_STRIKES_BPS.length; s++) {
        positions.push(await buyCall(t, cohort, {
          strikeBps: DEFAULT_STRIKES_BPS[s],
          size: SOL(0.02),
          nonce: s,
          buyer: t.buyer,
        }));
        positions.push(await buyCall(t, cohort, {
          strikeBps: DEFAULT_STRIKES_BPS[s],
          size: SOL(0.02),
          nonce: s,
          buyer: t.buyer2,
        }));
      }

      expect(positions.length).to.equal(14);

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 14_000);

      // Settle in 3 batches (5, 5, 4)
      await settleBatch(t, cohort, positions.slice(0, 5));
      const gs1 = await t.program.account.globalState.fetch(t.globalState);
      // Not all settled yet - index should NOT have advanced
      const cohortData1 = await t.program.account.cohort.fetch(cohort);
      expect(cohortData1.positionsSettled).to.equal(5);

      await settleBatch(t, cohort, positions.slice(5, 10));
      const cohortData2 = await t.program.account.cohort.fetch(cohort);
      expect(cohortData2.positionsSettled).to.equal(10);

      await settleBatch(t, cohort, positions.slice(10));
      const cohortData3 = await t.program.account.cohort.fetch(cohort);
      expect(cohortData3.positionsSettled).to.equal(14);

      // All settled - index advanced
      const gs2 = await t.program.account.globalState.fetch(t.globalState);
      expect(gs2.currentCohortIndex.toNumber()).to.equal(
        gs1.currentCohortIndex.toNumber() + 1,
      );

      // Claim all
      for (let i = 0; i < positions.length; i++) {
        const buyer = i % 2 === 0 ? t.buyer : t.buyer2;
        await claimPosition(t, cohort, positions[i], buyer);
      }

      await assertVaultConservation(t);
    });
  });


  describe("MHI clamp walkthrough", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("extreme MHI is clamped, gradual rise allowed", async () => {
      // Cohort 1: establish baseline at 12000
      await runFullCohort(t, 12_000, [{ strikeBps: 10_000 }]);

      let gs = await t.program.account.globalState.fetch(t.globalState);
      expect(gs.lastMhiBps).to.equal(12_000);

      // Cohort 2: try to jump to 30000 - should be clamped to ~15960 (12000 + 33%)
      const cohort2 = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort2, 30_000);

      const c2 = await t.program.account.cohort.fetch(cohort2);
      const maxUp = Math.floor(12_000 * 3300 / 10000);
      expect(c2.mhiBps).to.equal(12_000 + maxUp); // clamped to upper bound
      expect(c2.mhiBps).to.be.lessThan(30_000);

      await settleBatch(t, cohort2, []);

      // Cohort 3: try extreme low (1) - should be clamped
      gs = await t.program.account.globalState.fetch(t.globalState);
      const lastMhi = gs.lastMhiBps;
      const cohort3 = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort3, 1);

      const c3 = await t.program.account.cohort.fetch(cohort3);
      const maxDown = Math.floor(lastMhi * 3300 / 10000);
      expect(c3.mhiBps).to.equal(Math.max(lastMhi - maxDown, 1));
      expect(c3.mhiBps).to.be.greaterThan(1);

      await settleBatch(t, cohort3, []);
    });
  });
});
