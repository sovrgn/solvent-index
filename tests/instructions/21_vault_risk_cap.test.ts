/**
 * Vault risk cap enforcement tests.
 *
 * DESIGN_MHI.md specifies:
 * - max_vault_risk_per_cohort_bps (default 1500 = 15%) limits total collateral
 *   locked in a single cohort to a fraction of total vault capacity.
 * - This is the V1 defense against capacity spam / whale monopolization.
 *   (Per-address cap is deferred to V2 per design doc.)
 *
 * Adversarial scenario from design (line 885):
 *   "Capacity spam - Sybil addresses buy min-size positions to fill cohort capacity,
 *    blocking real buyers"
 *   Mitigation: per-cohort cap limits exposure. Attacker pays non-refundable premiums.
 */
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, assertVaultConservation,
  voidCohort, SOL, fundedKeypair, claimPosition,
  findPositionPda, currentLiveStrikes,
} from "./_setup";

describe("vault risk cap enforcement", () => {


  describe("per-cohort risk cap rejects oversized position", () => {
    let t: TestCtx;

    before(async () => {
      // Seed with 10 SOL, risk cap at 15% → max cohort collateral = ~1.5 SOL
      t = await setupProtocol({ seedSol: 10 });
      // Ensure max_vault_risk_per_cohort_bps is 1500 (default)
      const gs = await t.program.account.globalState.fetch(t.globalState);
      expect(gs.maxVaultRiskPerCohortBps).to.equal(1500);
    });

    it("buy exceeding per-cohort risk cap → InsufficientVaultCollateral", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const lowest = live[0]!; // largest collateral exposure per unit
      const [posPda] = findPositionPda(
        t.program.programId, cohort, t.buyer.publicKey, lowest, 0,
      );

      await expectError(
        () => t.program.methods
          .buyCall(lowest, SOL(2), 0)
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
        "InsufficientVaultCollateral",
      );

      await voidCohort(t, cohort);
    });

    it("buy within per-cohort risk cap succeeds", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      // A small size at the lowest strike comfortably under the cap.
      const pos = await buyCall(t, cohort, {
        strikeBps: live[0],
        size: SOL(0.5),
        nonce: 0,
      });

      const posData = await t.program.account.position.fetch(pos);
      expect(posData.sizeLamports.toNumber()).to.equal(SOL(0.5).toNumber());

      await voidCohort(t, cohort, [pos]);
      await claimPosition(t, cohort, pos, t.buyer);
    });
  });


  describe("risk cap reached by accumulating positions", () => {
    let t: TestCtx;

    before(async () => {
      t = await setupProtocol({ seedSol: 10 });
    });

    it("multiple positions that cumulatively exceed cap → last one rejected", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const highest = live[6]!; // smallest collateral per unit (above ATM)

      const pos1 = await buyCall(t, cohort, {
        strikeBps: highest,
        size: SOL(0.5),
        nonce: 0,
      });

      const pos2 = await buyCall(t, cohort, {
        strikeBps: highest,
        size: SOL(0.5),
        nonce: 1,
      });

      const [posPda3] = findPositionPda(
        t.program.programId, cohort, t.buyer.publicKey, highest, 2,
      );

      await expectError(
        () => t.program.methods
          .buyCall(highest, SOL(0.7), 2)
          .accounts({
            buyer: t.buyer.publicKey,
            globalState: t.globalState,
            vault: t.vault,
            cohort,
            emaState: t.emaState,
            position: posPda3,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([t.buyer])
          .rpc(),
        "InsufficientVaultCollateral",
      );

      // Verify the cohort's locked collateral is close to cap
      const cohortData = await t.program.account.cohort.fetch(cohort);
      const vault = await t.program.account.vault.fetch(t.vault);
      const vaultTotal = vault.availableLamports.toNumber() +
        vault.activeCollateralLamports.toNumber();
      const maxCohortCollateral = Math.floor(vaultTotal * 1500 / 10000);

      // Locked should be < cap (2 positions went through)
      expect(cohortData.vaultCollateralLocked.toNumber()).to.be.lessThanOrEqual(
        maxCohortCollateral,
      );

      await voidCohort(t, cohort, [pos1, pos2]);
      await claimPosition(t, cohort, pos1, t.buyer);
      await claimPosition(t, cohort, pos2, t.buyer);
    });
  });


  describe("risk cap = 0 disables per-cohort limit", () => {
    let t: TestCtx;

    before(async () => {
      t = await setupProtocol({ seedSol: 10 });
      // Set risk cap to 0 (disabled)
      await t.program.methods
        .updateConfig({
          keeper: null, mhiCapBps: null, premiumFeeBps: null,
          referralShareBps: null, keeperFeeLamports: null,
          minPositionLamports: null, maxPositionPerAddressBps: null,
          maxVaultRiskPerCohortBps: 0,
          tradingWindowSeconds: null, measurementSeconds: null,
          observationSeconds: null, settlementDeadlineSeconds: null,
          claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null,
          minPremiumLamports: null, maxPositionCollateralBps: null, paused: null,
         
        } as any)
        .accounts({ authority: t.authority.publicKey, globalState: t.globalState } as any)
        .rpc();
    });

    it("large position succeeds when risk cap is disabled", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);

      // SOL(2) at the lowest strike would breach the 15% cap on a 10 SOL vault.
      const pos = await buyCall(t, cohort, {
        strikeBps: live[0],
        size: SOL(2),
        nonce: 0,
      });

      const posData = await t.program.account.position.fetch(pos);
      expect(posData.sizeLamports.toNumber()).to.equal(SOL(2).toNumber());

      await voidCohort(t, cohort, [pos]);
      await claimPosition(t, cohort, pos, t.buyer);
    });
  });


  describe("adversarial: sybil capacity spam blocked by cohort cap", () => {
    let t: TestCtx;

    before(async () => {
      t = await setupProtocol({ seedSol: 10 });
    });

    it("multiple sybil buyers cannot exceed per-cohort risk cap", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const highest = live[6]!;

      const sybil1 = await fundedKeypair(t.context);
      const sybil2 = await fundedKeypair(t.context);

      const pos1 = await buyCall(t, cohort, {
        buyer: sybil1,
        strikeBps: highest,
        size: SOL(0.5),
        nonce: 0,
      });
      const pos2 = await buyCall(t, cohort, {
        buyer: sybil2,
        strikeBps: highest,
        size: SOL(0.5),
        nonce: 0,
      });

      const sybil3 = await fundedKeypair(t.context);
      const [posPda3] = findPositionPda(
        t.program.programId, cohort, sybil3.publicKey, highest, 0,
      );

      await expectError(
        () => t.program.methods
          .buyCall(highest, SOL(0.7), 0)
          .accounts({
            buyer: sybil3.publicKey,
            globalState: t.globalState,
            vault: t.vault,
            cohort,
            emaState: t.emaState,
            position: posPda3,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([sybil3])
          .rpc(),
        "InsufficientVaultCollateral",
      );

      // Each sybil paid non-refundable premium - attack has a cost
      const posData1 = await t.program.account.position.fetch(pos1);
      const posData2 = await t.program.account.position.fetch(pos2);
      expect(posData1.premiumPaidLamports.toNumber()).to.be.greaterThan(0);
      expect(posData2.premiumPaidLamports.toNumber()).to.be.greaterThan(0);

      // Vault conservation still holds
      await assertVaultConservation(t);

      await voidCohort(t, cohort, [pos1, pos2]);
      await claimPosition(t, cohort, pos1, sybil1);
      await claimPosition(t, cohort, pos2, sybil2);
    });
  });


  describe("V1: per-address cap not enforced (deferred to V2 per design)", () => {
    let t: TestCtx;

    before(async () => {
      t = await setupProtocol({ seedSol: 10 });
      // Disable per-cohort risk cap to isolate per-address behavior
      await t.program.methods
        .updateConfig({
          keeper: null, mhiCapBps: null, premiumFeeBps: null,
          referralShareBps: null, keeperFeeLamports: null,
          minPositionLamports: null, maxPositionPerAddressBps: null,
          maxVaultRiskPerCohortBps: 0,
          tradingWindowSeconds: null, measurementSeconds: null,
          observationSeconds: null, settlementDeadlineSeconds: null,
          claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null,
          minPremiumLamports: null, maxPositionCollateralBps: null, paused: null,
         
        } as any)
        .accounts({ authority: t.authority.publicKey, globalState: t.globalState } as any)
        .rpc();
    });

    it("single buyer can take multiple positions (no per-address limit in V1)", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);

      // Buy at three different strikes with same buyer - all should succeed.
      const pos1 = await buyCall(t, cohort, { strikeBps: live[0], nonce: 0, size: SOL(0.5) });
      const pos2 = await buyCall(t, cohort, { strikeBps: live[3], nonce: 0, size: SOL(0.5) });
      const pos3 = await buyCall(t, cohort, { strikeBps: live[5], nonce: 0, size: SOL(0.5) });

      // Verify all created with same owner
      for (const pos of [pos1, pos2, pos3]) {
        const data = await t.program.account.position.fetch(pos);
        expect(data.owner.toBase58()).to.equal(t.buyer.publicKey.toBase58());
      }

      await voidCohort(t, cohort, [pos1, pos2, pos3]);
      for (const pos of [pos1, pos2, pos3]) {
        await claimPosition(t, cohort, pos, t.buyer);
      }
    });
  });
});
