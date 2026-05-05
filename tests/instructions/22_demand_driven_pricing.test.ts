// tests/instructions/22_demand_driven_pricing.test.ts
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import {
  setupProtocol, TestCtx,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, assertVaultConservation,
  voidCohort, SOL, fundedKeypair,
  DEFAULT_STRIKES_BPS, NUM_STRIKES,
} from "./_setup";

describe("22 - demand-driven pricing", () => {

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Bonding surge: first buyer pays no surge, subsequent buyers pay more
  // ═══════════════════════════════════════════════════════════════════════

  describe("bonding surge - intra-cohort price escalation", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("first buyer pays less premium than second buyer at same strike", async () => {
      const cohort = await startCohort(t);

      const pos1 = await buyCall(t, cohort, {
        strikeBps: 12_000,
        size: SOL(0.05),
        nonce: 0,
        buyer: t.buyer,
      });

      const pos2 = await buyCall(t, cohort, {
        strikeBps: 12_000,
        size: SOL(0.05),
        nonce: 0,
        buyer: t.buyer2,
      });

      const p1 = await t.program.account.position.fetch(pos1);
      const p2 = await t.program.account.position.fetch(pos2);

      // Both same size, same strike - difference is the bonding surge
      expect(p2.premiumPaidLamports.toNumber()).to.be.greaterThan(
        p1.premiumPaidLamports.toNumber(),
      );

      await assertVaultConservation(t);
      await voidCohort(t, cohort, [pos1, pos2]);
      await claimPosition(t, cohort, pos1, t.buyer);
      await claimPosition(t, cohort, pos2, t.buyer2);
    });

    it("bonding surge is per-strike, not global", async () => {
      const cohort = await startCohort(t);

      // Build heavy volume at strike 10_000
      const pos1 = await buyCall(t, cohort, {
        strikeBps: 10_000,
        size: SOL(0.5),
        nonce: 0,
        buyer: t.buyer,
      });

      // First buyer at a DIFFERENT strike - should have no surge
      const pos2 = await buyCall(t, cohort, {
        strikeBps: 15_000,
        size: SOL(0.05),
        nonce: 0,
        buyer: t.buyer2,
      });

      const cohortData = await t.program.account.cohort.fetch(cohort);
      const idx15k = DEFAULT_STRIKES_BPS.indexOf(15_000);
      // pos2 was the first buyer at 15_000 - volume is exactly their size
      expect(cohortData.strikeVolumeLamports[idx15k].toNumber()).to.equal(
        SOL(0.05).toNumber(),
      );

      await assertVaultConservation(t);
      await voidCohort(t, cohort, [pos1, pos2]);
      await claimPosition(t, cohort, pos1, t.buyer);
      await claimPosition(t, cohort, pos2, t.buyer2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Strike volume tracking
  // ═══════════════════════════════════════════════════════════════════════

  describe("strike volume tracking", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("cohort.strike_volume_lamports starts at zero for all strikes", async () => {
      const cohort = await startCohort(t);
      const cohortData = await t.program.account.cohort.fetch(cohort);

      for (let i = 0; i < NUM_STRIKES; i++) {
        expect(cohortData.strikeVolumeLamports[i].toNumber()).to.equal(0);
      }

      await voidCohort(t, cohort);
    });

    it("buying at a strike increments only that strike's volume", async () => {
      const cohort = await startCohort(t);
      const targetStrike = 13_000;
      const targetIdx = DEFAULT_STRIKES_BPS.indexOf(targetStrike);
      const size = SOL(0.05);

      const pos = await buyCall(t, cohort, {
        strikeBps: targetStrike,
        size,
        nonce: 0,
      });

      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.strikeVolumeLamports[targetIdx].toNumber()).to.equal(
        size.toNumber(),
      );

      for (let i = 0; i < NUM_STRIKES; i++) {
        if (i !== targetIdx) {
          expect(cohortData.strikeVolumeLamports[i].toNumber()).to.equal(0);
        }
      }

      await voidCohort(t, cohort, [pos]);
      await claimPosition(t, cohort, pos, t.buyer);
    });

    it("multiple buys at same strike accumulate volume", async () => {
      const cohort = await startCohort(t);
      const targetStrike = 12_000;
      const targetIdx = DEFAULT_STRIKES_BPS.indexOf(targetStrike);
      const size1 = SOL(0.03);
      const size2 = SOL(0.07);

      const pos1 = await buyCall(t, cohort, {
        strikeBps: targetStrike,
        size: size1,
        nonce: 0,
      });
      const pos2 = await buyCall(t, cohort, {
        strikeBps: targetStrike,
        size: size2,
        nonce: 1,
      });

      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.strikeVolumeLamports[targetIdx].toNumber()).to.equal(
        size1.toNumber() + size2.toNumber(),
      );

      await voidCohort(t, cohort, [pos1, pos2]);
      await claimPosition(t, cohort, pos1, t.buyer);
      await claimPosition(t, cohort, pos2, t.buyer);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Per-strike demand markup adjustment after settlement
  // ═══════════════════════════════════════════════════════════════════════

  describe("per-strike demand markup adjustment", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("demand_markup_bps starts at 500 (5%) for all strikes", async () => {
      const ema = await t.program.account.emaState.fetch(t.emaState);

      for (let i = 0; i < NUM_STRIKES; i++) {
        expect(ema.strikes[i].demandMarkupBps).to.equal(500);
      }
    });

    it("strike with >50% volume share gets markup increase after settlement", async () => {
      const emaBefore = await t.program.account.emaState.fetch(t.emaState);
      const targetStrike = 12_000;
      const targetIdx = DEFAULT_STRIKES_BPS.indexOf(targetStrike);

      // Buy only at one strike → 100% volume share
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, {
        strikeBps: targetStrike,
        size: SOL(0.5),
        nonce: 0,
      });

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 14_000);

      const emaAfter = await t.program.account.emaState.fetch(t.emaState);

      // Target strike: 100% share > 50% → markup +100 bps
      expect(emaAfter.strikes[targetIdx].demandMarkupBps).to.equal(
        emaBefore.strikes[targetIdx].demandMarkupBps + 100,
      );

      // Other strikes: 0% share < 10% → markup -100 bps
      for (let i = 0; i < NUM_STRIKES; i++) {
        if (i !== targetIdx) {
          const expected = Math.max(
            emaBefore.strikes[i].demandMarkupBps - 100, 0,
          );
          expect(emaAfter.strikes[i].demandMarkupBps).to.equal(expected);
        }
      }

      await settleBatch(t, cohort, [pos]);
      await claimPosition(t, cohort, pos, t.buyer);
    });

    it("demand markup floors at 0 after repeated low demand", async () => {
      const targetStrike = 18_000;
      const targetIdx = DEFAULT_STRIKES_BPS.indexOf(targetStrike);

      // Run cohorts buying only at 10_000 - 18_000 gets 0% share each time
      for (let i = 0; i < 5; i++) {
        const cohort = await startCohort(t);
        const pos = await buyCall(t, cohort, {
          strikeBps: 10_000,
          size: SOL(0.05),
          nonce: 0,
        });
        await warpPastObservation(t.context);
        await submitMhi(t, cohort, 14_000);
        await settleBatch(t, cohort, [pos]);
        await claimPosition(t, cohort, pos, t.buyer);
      }

      const ema = await t.program.account.emaState.fetch(t.emaState);
      expect(ema.strikes[targetIdx].demandMarkupBps).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Three-layer markup composition
  // ═══════════════════════════════════════════════════════════════════════

  describe("three-layer markup composition", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("premiums escalate monotonically with consecutive buys at same strike", async () => {
      const cohort = await startCohort(t);
      const positions: anchor.web3.PublicKey[] = [];
      const extraBuyers = [
        t.buyer,
        t.buyer2,
        await fundedKeypair(t.context),
        await fundedKeypair(t.context),
        await fundedKeypair(t.context),
      ];

      for (let i = 0; i < 5; i++) {
        const pos = await buyCall(t, cohort, {
          strikeBps: 12_000,
          size: SOL(0.02),
          nonce: 0,
          buyer: extraBuyers[i],
        });
        positions.push(pos);
      }

      const premiums: number[] = [];
      for (const pos of positions) {
        const p = await t.program.account.position.fetch(pos);
        premiums.push(p.premiumPaidLamports.toNumber());
      }

      // Each subsequent premium should be >= previous (bonding surge)
      for (let i = 1; i < premiums.length; i++) {
        expect(premiums[i]).to.be.greaterThanOrEqual(premiums[i - 1]!);
      }

      await assertVaultConservation(t);
      await voidCohort(t, cohort, positions);
      for (let i = 0; i < positions.length; i++) {
        await claimPosition(t, cohort, positions[i]!, extraBuyers[i]!);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Vault conservation holds throughout
  // ═══════════════════════════════════════════════════════════════════════

  describe("vault conservation with demand-driven pricing", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("conservation holds across full lifecycle with bonding surge", async () => {
      const cohort = await startCohort(t);
      const positions: anchor.web3.PublicKey[] = [];

      for (let i = 0; i < 3; i++) {
        const pos = await buyCall(t, cohort, {
          strikeBps: 12_000,
          size: SOL(0.02),
          nonce: i,
        });
        positions.push(pos);
        await assertVaultConservation(t);
      }

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 14_000);
      await assertVaultConservation(t);

      await settleBatch(t, cohort, positions);
      await assertVaultConservation(t);

      for (const pos of positions) {
        await claimPosition(t, cohort, pos, t.buyer);
      }
      await assertVaultConservation(t);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Empty cohort - all demand markups decrease
  // ═══════════════════════════════════════════════════════════════════════

  describe("empty cohort edge case", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("submit_mhi with 0 positions decreases all demand markups", async () => {
      const emaBefore = await t.program.account.emaState.fetch(t.emaState);
      const demandBefore = emaBefore.strikes.map((s: any) => s.demandMarkupBps);

      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 14_000);

      const emaAfter = await t.program.account.emaState.fetch(t.emaState);

      // 0 total volume → all shares = 0 → all below 10% threshold → all decrease
      for (let i = 0; i < NUM_STRIKES; i++) {
        const expected = Math.max(demandBefore[i] - 100, 0);
        expect(emaAfter.strikes[i].demandMarkupBps).to.equal(expected);
      }

      await settleBatch(t, cohort, []);
    });
  });
});
