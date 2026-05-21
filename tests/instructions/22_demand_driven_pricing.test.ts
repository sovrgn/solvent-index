// tests/instructions/22_demand_driven_pricing.test.ts
import { expect } from "chai";
import {
  setupProtocol, TestCtx,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, assertVaultConservation,
  voidCohort, SOL,
  currentLiveStrikes, currentAtmStrike,
  NUM_STRIKES,
} from "./_setup";

describe("22 - demand-driven pricing", () => {

  // NOTE: The intra-cohort `bonding_surge_bps` layer was deliberately removed
  // when aligning the on-chain pricing model with the keeper (per the
  // align-on-chain-with-keeper plan — keeper's active layers are only
  // cold-start + demand). Tests covering intra-cohort surge are therefore
  // gone; the demand-markup adjustment (between-cohort) is unchanged and
  // covered below.

  // ═══════════════════════════════════════════════════════════════════════
  // Strike volume tracking — populated by buy_call regardless of surge layer
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
      const live = await currentLiveStrikes(t);
      const targetIdx = 3;
      const targetStrike = live[targetIdx]!;
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
      const live = await currentLiveStrikes(t);
      const targetIdx = 2;
      const targetStrike = live[targetIdx]!;
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
  // Per-slot demand markup adjustment after settlement
  // ═══════════════════════════════════════════════════════════════════════

  describe("per-slot demand markup adjustment", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("demand_markup_bps starts at 500 (5%) for all slots", async () => {
      const ema = await t.program.account.emaState.fetch(t.emaState);

      for (let i = 0; i < NUM_STRIKES; i++) {
        expect((ema as any).slots[i].demandMarkupBps).to.equal(500);
      }
    });

    it("slot with >50% volume share gets markup increase after settlement", async () => {
      const emaBefore = await t.program.account.emaState.fetch(t.emaState);
      const beforeMarkups: number[] = (emaBefore as any).slots.map(
        (s: any) => s.demandMarkupBps,
      );

      const targetIdx = 2;

      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const pos = await buyCall(t, cohort, {
        strikeBps: live[targetIdx],
        size: SOL(0.5),
        nonce: 0,
      });

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));

      const emaAfter = await t.program.account.emaState.fetch(t.emaState);

      // Target slot: 100% share → markup +100 bps
      expect((emaAfter as any).slots[targetIdx].demandMarkupBps).to.equal(
        beforeMarkups[targetIdx]! + 100,
      );

      // Other slots: 0% share → markup -100 bps, floored at 0
      for (let i = 0; i < NUM_STRIKES; i++) {
        if (i !== targetIdx) {
          const expected = Math.max(beforeMarkups[i]! - 100, 0);
          expect((emaAfter as any).slots[i].demandMarkupBps).to.equal(expected);
        }
      }

      await settleBatch(t, cohort, [pos]);
      await claimPosition(t, cohort, pos, t.buyer);
    });

    it("demand markup floors at 0 after repeated low demand", async () => {
      const targetIdx = 5; // strike that's deep OTM most rounds

      // Run cohorts buying only at slot 0 → slot 5 always 0% share.
      for (let i = 0; i < 5; i++) {
        const cohort = await startCohort(t);
        const live = await currentLiveStrikes(t);
        const pos = await buyCall(t, cohort, {
          strikeBps: live[0],
          size: SOL(0.05),
          nonce: 0,
        });
        await warpPastObservation(t.context);
        await submitMhi(t, cohort, await currentAtmStrike(t));
        await settleBatch(t, cohort, [pos]);
        await claimPosition(t, cohort, pos, t.buyer);
      }

      const ema = await t.program.account.emaState.fetch(t.emaState);
      expect((ema as any).slots[targetIdx].demandMarkupBps).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Vault conservation holds throughout
  // ═══════════════════════════════════════════════════════════════════════

  describe("vault conservation with demand-driven pricing", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("conservation holds across full lifecycle with multi-buy", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const positions = [];

      for (let i = 0; i < 3; i++) {
        const pos = await buyCall(t, cohort, {
          strikeBps: live[2],
          size: SOL(0.02),
          nonce: i,
        });
        positions.push(pos);
        await assertVaultConservation(t);
      }

      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));
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
  // Empty cohort - all demand markups decrease
  // ═══════════════════════════════════════════════════════════════════════

  describe("empty cohort edge case", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("submit_mhi with 0 positions decreases all demand markups", async () => {
      const emaBefore = await t.program.account.emaState.fetch(t.emaState);
      const demandBefore: number[] = (emaBefore as any).slots.map(
        (s: any) => s.demandMarkupBps,
      );

      const cohort = await startCohort(t);
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, await currentAtmStrike(t));

      const emaAfter = await t.program.account.emaState.fetch(t.emaState);

      for (let i = 0; i < NUM_STRIKES; i++) {
        const expected = Math.max(demandBefore[i]! - 100, 0);
        expect((emaAfter as any).slots[i].demandMarkupBps).to.equal(expected);
      }

      await settleBatch(t, cohort, []);
    });
  });
});
