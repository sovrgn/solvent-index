import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  setupProtocol,
  TestCtx,
  FAST_MEASUREMENT,
  FAST_OBSERVATION,
  warpTime,
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
  settleBatch,
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

/** Mirror of math/ema.rs::fair_payoff_bps. */
function fairPayoffBps(fastFrac: number, slowFrac: number, anchorBps: number): number {
  return Math.floor((Math.max(fastFrac, slowFrac) * anchorBps) / BPS_DENOMINATOR);
}

/**
 * Mirror of the whole buy_call premium ladder: fair → markup → clamp to
 * [MIN_PREMIUM_BPS_FLOOR, cap - strike] → ceil into lamports. `totalCohorts`
 * drives the cold-start amplification, so it has to be the value the chain
 * saw at buy time.
 */
const EMA_BASE_MARKUP_BPS = 2_000;
const MIN_PREMIUM_BPS_FLOOR = 50;
const COLD_START_COHORTS = 50;
const COLD_START_EXTRA_BPS = 5_000;

function coldStartMarkup(baseBps: number, settledCohorts: number): number {
  if (settledCohorts >= COLD_START_COHORTS) return baseBps;
  const extra = Math.floor((COLD_START_EXTRA_BPS * (COLD_START_COHORTS - settledCohorts)) / COLD_START_COHORTS);
  return Math.floor((baseBps * (BPS_DENOMINATOR + extra)) / BPS_DENOMINATOR);
}

function expectedPremiumLamports(args: {
  fastFrac: number;
  slowFrac: number;
  demandMarkupBps: number;
  anchorBps: number;
  strikeBps: number;
  capBps: number;
  totalCohorts: number;
  sizeLamports: number;
}): number {
  const fair = fairPayoffBps(args.fastFrac, args.slowFrac, args.anchorBps);
  const markup = coldStartMarkup(EMA_BASE_MARKUP_BPS, args.totalCohorts) + args.demandMarkupBps;
  const maxPayoff = args.capBps - args.strikeBps;
  let charged = Math.min(Math.floor((fair * (BPS_DENOMINATOR + markup)) / BPS_DENOMINATOR), maxPayoff);
  if (charged < MIN_PREMIUM_BPS_FLOOR) charged = Math.min(MIN_PREMIUM_BPS_FLOOR, maxPayoff);
  return Math.ceil((charged * args.sizeLamports) / BPS_DENOMINATOR);
}

/**
 * Shortest trading window `update_config` will accept. Cohorts opened after
 * the first `setTradingWindow` call run on this instead of the 3s
 * `initialize` value, so they need their own warp helper.
 */
const SHORT_TRADING_WINDOW = 30;

/** Set only `tradingWindowSeconds`; every other config field stays put. */
async function setTradingWindow(t: TestCtx, seconds: number): Promise<void> {
  await t.program.methods
    .updateConfig({
      keeper: null,
      mhiCapBps: null,
      premiumFeeBps: null,
      referralShareBps: null,
      keeperFeeLamports: null,
      minPositionLamports: null,
      minPremiumLamports: null,
      maxPositionPerAddressBps: null,
      maxVaultRiskPerCohortBps: null,
      maxPositionCollateralBps: null,
      tradingWindowSeconds: seconds,
      measurementSeconds: null,
      observationSeconds: null,
      settlementDeadlineSeconds: null,
      claimExpirySeconds: null,
      mhiFloorBps: null,
      mhiMaxDeltaBps: null,
      paused: null,
    } as any)
    .accounts({ authority: t.authority.publicKey, globalState: t.globalState } as any)
    .rpc();
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

  /**
   * `buy_call` scales the stored payoff fraction back into bps by an anchor.
   * That anchor must be the cohort's own `strike_anchor_bps_at_start`, since
   * the fraction was recorded against the anchor its strike ladder was built
   * from. Pricing off the live global anchor instead makes the charge depend
   * on when OTHER cohorts settled, which both misprices the ladder and puts
   * the chain out of step with the quote the buyer was shown.
   */
  describe("buy_call anchor source", () => {
    /**
     * One settled cohort: gives the fractional EMA a non-zero payoff. The
     * `settleBatch` matters as much as the `submitMhi` — only settling
     * releases the cohort's `active_cohorts` slot, and these tests need
     * two long-lived cohorts open at once against a cap of three.
     */
    async function warmEma(t: TestCtx, mhiBps: number): Promise<number> {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { size: SOL(0.05) });
      await warpPastObservation(t.context);
      await submitMhi(t, cohort, mhiBps);
      await settleBatch(t, cohort, [pos]);
      const gs = await t.program.account.globalState.fetch(t.globalState);
      return (gs as any).strikeAnchorBps as number;
    }

    /**
     * Start a cohort whose trading window outlives the settlement of a later
     * one, so a buy can land after the global anchor has already moved.
     */
    async function startLongCohort(t: TestCtx): Promise<PublicKey> {
      await setTradingWindow(t, 3_600);
      const cohort = await startCohort(t);
      await setTradingWindow(t, SHORT_TRADING_WINDOW);
      return cohort;
    }

    /**
     * Open a short cohort, settle it, and return the global anchor it left
     * behind. The warp clears that cohort's observation end while staying
     * far inside any long cohort's 1h window.
     */
    async function settleShortCohort(t: TestCtx, mhiBps: number): Promise<number> {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { size: SOL(0.05) });
      await warpTime(t.context, SHORT_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION + 2);
      await submitMhi(t, cohort, mhiBps);
      await settleBatch(t, cohort, [pos]);
      const gs = await t.program.account.globalState.fetch(t.globalState);
      return (gs as any).strikeAnchorBps as number;
    }

    /** Charge the chain actually took, read off the stored position. */
    async function premiumOf(t: TestCtx, position: PublicKey): Promise<number> {
      const p = await t.program.account.position.fetch(position);
      return ((p as any).premiumPaidLamports as anchor.BN).toNumber();
    }

    async function expectedFor(t: TestCtx, args: {
      cohort: PublicKey;
      slotIdx: number;
      anchorBps: number;
      sizeLamports: number;
    }): Promise<number> {
      const c = await t.program.account.cohort.fetch(args.cohort);
      const ema = await t.program.account.emaState.fetch(t.emaState);
      const gs = await t.program.account.globalState.fetch(t.globalState);
      const slot = (ema as any).slots[args.slotIdx];
      return expectedPremiumLamports({
        fastFrac: slot.fastFracBps,
        slowFrac: slot.slowFracBps,
        demandMarkupBps: slot.demandMarkupBps,
        anchorBps: args.anchorBps,
        strikeBps: ((c as any).strikes as number[])[args.slotIdx]!,
        capBps: (c as any).mhiCapBpsAtStart as number,
        totalCohorts: ((gs as any).totalCohorts as anchor.BN).toNumber(),
        sizeLamports: args.sizeLamports,
      });
    }

    it("charges off the cohort's anchor snapshot after the global anchor moves", async () => {
      const t = await setupProtocol();
      await warmEma(t, 14_200);

      // Cohort B opens at the current anchor and stays open.
      const cohortB = await startLongCohort(t);
      const bData = await t.program.account.cohort.fetch(cohortB);
      const anchorB = (bData as any).strikeAnchorBpsAtStart as number;

      // Cohort C settles underneath it and drags the global anchor away.
      const liveAnchor = await settleShortCohort(t, 18_800);
      expect(liveAnchor, "the settlement must actually move the global anchor")
        .to.not.equal(anchorB);

      const slotIdx = 2;
      const size = SOL(1);
      const strikes = (bData as any).strikes as number[];
      const pos = await buyCall(t, cohortB, {
        strikeBps: strikes[slotIdx]!,
        size,
      });

      const charged = await premiumOf(t, pos);
      const withCohortAnchor = await expectedFor(t, {
        cohort: cohortB,
        slotIdx,
        anchorBps: anchorB,
        sizeLamports: size.toNumber(),
      });
      const withLiveAnchor = await expectedFor(t, {
        cohort: cohortB,
        slotIdx,
        anchorBps: liveAnchor,
        sizeLamports: size.toNumber(),
      });

      expect(charged).to.equal(withCohortAnchor);
      // Guards the test itself: if the two formulas ever collapse to the same
      // number the assertion above stops proving anything.
      expect(withCohortAnchor).to.not.equal(withLiveAnchor);
      expect(charged).to.not.equal(withLiveAnchor);
    });

    it("prices two simultaneously-trading cohorts by their own ladders", async () => {
      const t = await setupProtocol();
      await warmEma(t, 14_200);

      const cohortB = await startLongCohort(t);

      // Move the anchor, then open a second long cohort at the new level, so
      // B and D are trading at once with different ladders.
      await settleShortCohort(t, 18_800);
      const cohortD = await startLongCohort(t);

      const bData = await t.program.account.cohort.fetch(cohortB);
      const dData = await t.program.account.cohort.fetch(cohortD);
      const anchorB = (bData as any).strikeAnchorBpsAtStart as number;
      const anchorD = (dData as any).strikeAnchorBpsAtStart as number;
      expect(anchorB).to.not.equal(anchorD);

      const slotIdx = 2;
      const size = SOL(1);
      const posB = await buyCall(t, cohortB, {
        strikeBps: ((bData as any).strikes as number[])[slotIdx]!,
        size,
      });
      const posD = await buyCall(t, cohortD, {
        strikeBps: ((dData as any).strikes as number[])[slotIdx]!,
        size,
      });

      const chargedB = await premiumOf(t, posB);
      const chargedD = await premiumOf(t, posD);

      expect(chargedB).to.equal(await expectedFor(t, {
        cohort: cohortB, slotIdx, anchorBps: anchorB, sizeLamports: size.toNumber(),
      }));
      expect(chargedD).to.equal(await expectedFor(t, {
        cohort: cohortD, slotIdx, anchorBps: anchorD, sizeLamports: size.toNumber(),
      }));
      // The defect this replaces charged both cohorts the same bps for slot 2
      // even though D's strike sits further from the index than B's.
      expect(chargedB).to.not.equal(chargedD);
    });

    it("does not let a buyer wait out a falling global anchor for a discount", async () => {
      const t = await setupProtocol();
      await warmEma(t, 16_000);

      const cohortB = await startLongCohort(t);
      const bData = await t.program.account.cohort.fetch(cohortB);
      const anchorB = (bData as any).strikeAnchorBpsAtStart as number;
      const strikes = (bData as any).strikes as number[];
      const size = SOL(0.5);

      // Buy before any other cohort settles.
      const early = await premiumOf(t, await buyCall(t, cohortB, {
        strikeBps: strikes[2]!, size, nonce: 0,
      }));

      // Drive the global anchor DOWN, then buy the identical slot again.
      const liveAnchor = await settleShortCohort(t, 11_000);
      expect(liveAnchor).to.be.lessThan(anchorB);

      const late = await premiumOf(t, await buyCall(t, cohortB, {
        strikeBps: strikes[2]!, size, nonce: 1,
      }));

      // The scale factor is pinned, so the only thing that may have moved the
      // charge is the fractional EMA the settlement updated — never the 31%
      // anchor drop. Both buys are checked against the cohort-anchor formula.
      expect(late).to.equal(await expectedFor(t, {
        cohort: cohortB, slotIdx: 2, anchorBps: anchorB, sizeLamports: size.toNumber(),
      }));
      const withLiveAnchor = await expectedFor(t, {
        cohort: cohortB,
        slotIdx: 2,
        anchorBps: liveAnchor,
        sizeLamports: size.toNumber(),
      });
      expect(late).to.be.greaterThan(withLiveAnchor);
      expect(early).to.be.greaterThan(0);
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
