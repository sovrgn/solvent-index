import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import {
  setupProtocol,
  TestCtx,
  DEFAULT_STRIKES_BPS,
  STRIKE_ANCHOR_DEFAULT_BPS,
  STRIKE_ANCHOR_MIN_BPS,
  STRIKE_MULTIPLIERS_BPS,
  BPS_DENOMINATOR,
  MHI_CAP_BPS,
  NUM_STRIKES,
  deriveStrikes,
  findCohortPda,
  startCohort,
  buyCall,
  warpPastObservation,
  submitMhi,
  SOL,
} from "./_setup";

/**
 * Off-chain mirrors of math/ema.rs functions. Keeper / dashboard quoting
 * must produce the same numbers as the on-chain handlers, so these mirrors
 * also serve as the formal cross-language test vectors.
 */
function updateFastEma(prev: number, x: number): number {
  return Math.floor((1500 * x + 8500 * prev) / BPS_DENOMINATOR);
}
function updateSlowEma(prev: number, x: number): number {
  return Math.floor((350 * x + 9650 * prev) / BPS_DENOMINATOR);
}
function cappedPayoff(mhi: number, strike: number, cap: number): number {
  return Math.max(0, Math.min(mhi - strike, cap - strike));
}
function payoffFrac(payoff: number, anchor: number): number {
  return Math.floor((payoff * BPS_DENOMINATOR) / anchor);
}
function updateStrikeAnchor(prev: number, mhi: number, count: number): number {
  if (mhi === 0) return Math.max(prev, STRIKE_ANCHOR_MIN_BPS);
  const raw = count === 0
    ? mhi
    : Math.floor((3000 * mhi + 7000 * prev) / BPS_DENOMINATOR);
  return Math.max(raw, STRIKE_ANCHOR_MIN_BPS);
}

describe("Strike anchor & fractional EMA (per-cohort strikes)", function () {
  this.timeout(60_000);

  describe("initialize", () => {
    it("seeds the cold-start anchor and zero fractional EMAs", async () => {
      const t = await setupProtocol();
      const gs = await t.program.account.globalState.fetch(t.globalState);
      expect((gs as any).strikeAnchorBps).to.equal(STRIKE_ANCHOR_DEFAULT_BPS);
      expect(((gs as any).strikeAnchorSettlementCount as anchor.BN).toString()).to.equal("0");

      const ema = await t.program.account.emaState.fetch(t.emaState);
      expect((ema as any).slots).to.have.length(NUM_STRIKES);
      for (const slot of (ema as any).slots) {
        expect(slot.fastFracBps).to.equal(0);
        expect(slot.slowFracBps).to.equal(0);
        // demand markup seeded at STRIKE_DEMAND_DEFAULT_BPS = 500.
        expect(slot.demandMarkupBps).to.equal(500);
      }
    });
  });

  describe("start_cohort strike verification", () => {
    let t: TestCtx;
    beforeEach(async () => {
      t = await setupProtocol();
    });

    it("accepts strikes that match derive_strikes(current_anchor)", async () => {
      const cohort = await startCohort(t);
      const c = await t.program.account.cohort.fetch(cohort);
      expect(Array.from((c as any).strikes)).to.deep.equal(DEFAULT_STRIKES_BPS);
      expect((c as any).strikeAnchorBpsAtStart).to.equal(STRIKE_ANCHOR_DEFAULT_BPS);
    });

    it("derive_strikes(default_anchor) matches on-chain cold-start ladder", () => {
      // Cross-implementation parity: this is the test that catches a keeper
      // running with a stale/different multiplier constant.
      const expected = STRIKE_MULTIPLIERS_BPS.map(m =>
        Math.max(STRIKE_ANCHOR_MIN_BPS, Math.floor((STRIKE_ANCHOR_DEFAULT_BPS * m) / BPS_DENOMINATOR)),
      );
      expect(DEFAULT_STRIKES_BPS).to.deep.equal(expected);
    });

    it("rejects strikes off by 1 bps in any single slot", async () => {
      const gs = await t.program.account.globalState.fetch(t.globalState);
      const idx = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(t.program.programId, idx);
      const bad = [...DEFAULT_STRIKES_BPS];
      bad[3] = bad[3] + 1; // off by 1 in one slot
      let failed = false;
      try {
        await t.program.methods
          .startCohort(bad)
          .accounts({
            keeper: t.keeper.publicKey,
            globalState: t.globalState,
            vault: t.vault,
            cohort: cohortPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([t.keeper])
          .rpc();
      } catch (err: any) {
        failed = true;
        const hay = err.toString() + JSON.stringify(err.logs ?? []);
        expect(hay).to.include("StrikesDoNotMatchAnchor");
      }
      expect(failed, "start_cohort with mismatched strikes must revert").to.equal(true);
    });

    it("rejects strikes that mismatch (replay of previous-anchor ladder)", async () => {
      // Run one cohort to shift the anchor, then try to start cohort #2 with
      // the OLD anchor's strikes. This is the failure mode keeper would hit
      // if its local-anchor view diverges from the on-chain clamped value.
      const cohort = await startCohort(t);
      await buyCall(t, cohort, { strikeBps: DEFAULT_STRIKES_BPS[2], size: SOL(0.05) });
      await warpPastObservation(t.context);
      // Submit MHI that will move the anchor.
      await submitMhi(t, cohort, 9_800);

      const gsAfter = await t.program.account.globalState.fetch(t.globalState);
      const newAnchor = (gsAfter as any).strikeAnchorBps as number;
      expect(newAnchor).to.not.equal(STRIKE_ANCHOR_DEFAULT_BPS);

      const idx = gsAfter.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(t.program.programId, idx);
      // Try to start cohort #2 with the cold-start strikes (stale).
      let failed = false;
      try {
        await t.program.methods
          .startCohort(DEFAULT_STRIKES_BPS)
          .accounts({
            keeper: t.keeper.publicKey,
            globalState: t.globalState,
            vault: t.vault,
            cohort: cohortPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([t.keeper])
          .rpc();
      } catch (err: any) {
        failed = true;
        const hay = err.toString() + JSON.stringify(err.logs ?? []);
        expect(hay).to.include("StrikesDoNotMatchAnchor");
      }
      expect(failed).to.equal(true);

      // Now do it with the fresh strikes — must succeed.
      const fresh = deriveStrikes(newAnchor);
      await t.program.methods
        .startCohort(fresh)
        .accounts({
          keeper: t.keeper.publicKey,
          globalState: t.globalState,
          vault: t.vault,
          cohort: cohortPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([t.keeper])
        .rpc();
      const c2 = await t.program.account.cohort.fetch(cohortPda);
      expect(Array.from((c2 as any).strikes)).to.deep.equal(fresh);
      expect((c2 as any).strikeAnchorBpsAtStart).to.equal(newAnchor);
    });
  });

  describe("submit_mhi anchor + fractional EMA update", () => {
    let t: TestCtx;
    beforeEach(async () => {
      t = await setupProtocol();
    });

    it("first settlement initializes anchor to the (clamped) MHI", async () => {
      const cohort = await startCohort(t);
      await buyCall(t, cohort, { strikeBps: DEFAULT_STRIKES_BPS[2], size: SOL(0.05) });
      await warpPastObservation(t.context);
      // First cohort is unclamped (last_mhi_bps == 0), so effective = raw.
      await submitMhi(t, cohort, 14_200);
      const gs = await t.program.account.globalState.fetch(t.globalState);
      expect((gs as any).strikeAnchorBps).to.equal(14_200);
      expect(((gs as any).strikeAnchorSettlementCount as anchor.BN).toString()).to.equal("1");
      expect((gs as any).lastMhiBps).to.equal(14_200);
    });

    it("subsequent settlements EMA-blend (alpha 0.3) the anchor", async () => {
      // Cohort 1 → anchor = 14_200.
      let cohort = await startCohort(t);
      await buyCall(t, cohort, { strikeBps: DEFAULT_STRIKES_BPS[2], size: SOL(0.05) });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 14_200);

      // Cohort 2 with new strikes → settle and verify blend.
      const gs1 = await t.program.account.globalState.fetch(t.globalState);
      const anchor1 = (gs1 as any).strikeAnchorBps as number;
      cohort = await startCohort(t);
      await buyCall(t, cohort, { strikeBps: deriveStrikes(anchor1)[2], size: SOL(0.05) });
      await warpPastObservation(t.context);
      // Cohort 2's last_mhi_bps = 14_200; 33% clamp means [9_514, 18_886] are accepted.
      // 14_200 is within range, so effective = 14_200 (no clamp).
      await submitMhi(t, cohort, 14_200);
      const gs2 = await t.program.account.globalState.fetch(t.globalState);
      const expected = updateStrikeAnchor(anchor1, 14_200, 1);
      expect((gs2 as any).strikeAnchorBps).to.equal(expected);
    });

    it("EMA fractions update with payoff/anchor_at_start (not current global anchor)", async () => {
      const cohort = await startCohort(t);
      const atmStrike = DEFAULT_STRIKES_BPS[2];
      await buyCall(t, cohort, { strikeBps: atmStrike, size: SOL(0.05) });
      const cohortBefore = await t.program.account.cohort.fetch(cohort);
      const anchorAtStart = (cohortBefore as any).strikeAnchorBpsAtStart as number;

      await warpPastObservation(t.context);
      const mhi = 14_200;
      await submitMhi(t, cohort, mhi);

      const ema = await t.program.account.emaState.fetch(t.emaState);
      // Re-derive the per-slot fractions off-chain and compare exactly.
      for (let i = 0; i < NUM_STRIKES; i++) {
        const strike = DEFAULT_STRIKES_BPS[i];
        const payoff = cappedPayoff(mhi, strike, MHI_CAP_BPS);
        const frac = payoffFrac(payoff, anchorAtStart);
        const expFast = updateFastEma(0, frac);
        const expSlow = updateSlowEma(0, frac);
        const slot = (ema as any).slots[i];
        expect(slot.fastFracBps, `slot ${i} fast`).to.equal(expFast);
        expect(slot.slowFracBps, `slot ${i} slow`).to.equal(expSlow);
      }
    });

    it("clamps the MHI submission via delta clamp and stores the clamped value", async () => {
      // Get a non-zero last_mhi_bps anchor first.
      let cohort = await startCohort(t);
      await buyCall(t, cohort, { strikeBps: DEFAULT_STRIKES_BPS[2], size: SOL(0.05) });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, 12_000); // first: unclamped → last_mhi=12_000

      const gs1 = await t.program.account.globalState.fetch(t.globalState);
      const lastMhi = (gs1 as any).lastMhiBps as number;
      const deltaBps = (gs1 as any).mhiMaxDeltaBps as number;
      expect(deltaBps).to.equal(3300); // 33% default
      const maxMove = Math.floor((lastMhi * deltaBps) / BPS_DENOMINATOR);
      const upperBound = lastMhi + maxMove;

      // Start cohort 2 with fresh strikes derived from the (already-shifted) anchor.
      const anchor1 = (gs1 as any).strikeAnchorBps as number;
      cohort = await startCohort(t);
      await buyCall(t, cohort, { strikeBps: deriveStrikes(anchor1)[2], size: SOL(0.05) });
      await warpPastObservation(t.context);
      // Submit a wild MHI that should be clamped to upperBound.
      await submitMhi(t, cohort, 29_000);

      const c = await t.program.account.cohort.fetch(cohort);
      expect((c as any).mhiBps).to.equal(upperBound);
      // Anchor must use the CLAMPED value as input.
      const gs2 = await t.program.account.globalState.fetch(t.globalState);
      const expectedAnchor = updateStrikeAnchor(anchor1, upperBound, 1);
      expect((gs2 as any).strikeAnchorBps).to.equal(expectedAnchor);
    });
  });

  describe("derive_strikes parity sweep", () => {
    it("matches Rust derive_strikes for a sweep of anchor values", () => {
      // Hand-computed reference vectors (anchor, expected[7]).
      // Each verified by hand against floor(anchor * mult / 10_000), max-floored at 2_000.
      const cases: Array<[number, number[]]> = [
        [STRIKE_ANCHOR_MIN_BPS, [2_000, 2_000, 2_000, 2_100, 2_200, 2_400, 2_600]],
        [10_000, [9_000, 9_500, 10_000, 10_500, 11_000, 12_000, 13_000]],
        [12_500, [11_250, 11_875, 12_500, 13_125, 13_750, 15_000, 16_250]],
        [20_000, [18_000, 19_000, 20_000, 21_000, 22_000, 24_000, 26_000]],
        // Below-floor anchor would only happen if min were violated — skip.
      ];
      for (const [anchorBps, expected] of cases) {
        expect(deriveStrikes(anchorBps), `anchor=${anchorBps}`).to.deep.equal(expected);
      }
    });
  });
});
