import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, SystemProgram, PublicKey } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, warpTime, assertVaultConservation,
  voidCohort, SOL, accountExists,
  currentAtmStrike,
  FAST_TRADING_WINDOW, FAST_MEASUREMENT, FAST_OBSERVATION,
  FAST_SETTLEMENT_DEADLINE, FAST_CLAIM_EXPIRY, MHI_CAP_BPS,
} from "./_setup";

describe("19 - remaining edge cases", () => {


  describe("initialize - initial_ema_values all 0", () => {
    let t: TestCtx;

    before(async () => {
      t = await setupProtocol({ skipInit: true });

      // Initialize with all-zero EMA values
      await t.program.methods
        .initialize({
          keeper: t.keeper.publicKey,
          mhiCapBps: MHI_CAP_BPS,
          premiumFeeBps: 150,
          referralShareBps: 3000,
          minPositionLamports: new anchor.BN(10_000_000),
          tradingWindowSeconds: FAST_TRADING_WINDOW,
          measurementSeconds: FAST_MEASUREMENT,
          observationSeconds: FAST_OBSERVATION,
          settlementDeadlineSeconds: FAST_SETTLEMENT_DEADLINE,
          claimExpirySeconds: FAST_CLAIM_EXPIRY,
          
          minPremiumLamports: new anchor.BN(0),
        } as any)
        .accounts({
          authority: t.authority.publicKey,
          globalState: t.globalState,
          vault: t.vault,
          emaState: t.emaState,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Seed the vault so start_cohort passes
      await t.program.methods
        .seedVault(SOL(20))
        .accounts({
          authority: t.authority.publicKey,
          globalState: t.globalState,
          vault: t.vault,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // P2P pool init is normally done in setupProtocol; this test uses
      // skipInit so we need to do it manually for buy_call to find the PDA.
      await (t.program.methods as any).initP2PPool()
        .accounts({
          authority: t.authority.publicKey,
          globalState: t.globalState,
          p2PPool: t.p2pPool,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("initialize with empty EMA + MIN_PREMIUM_BPS_FLOOR keeps buy_call solvent at cold start", async () => {
      // Sanity: EMA slots are all zero on fresh init.
      const ema = await t.program.account.emaState.fetch(t.emaState);
      for (let i = 0; i < 7; i++) {
        expect((ema as any).slots[i].fastFracBps).to.equal(0);
        expect((ema as any).slots[i].slowFracBps).to.equal(0);
      }

      // Old design required pre-seeded EMA values and rejected start_cohort
      // when they were all zero. The new design removes that gate — cold-start
      // markup amplification + MIN_PREMIUM_BPS_FLOOR in buy_call together
      // ensure the cold-start exploit is impossible without needing a seed.
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort);
      const posData = await t.program.account.position.fetch(pos);
      // Premium ≥ MIN_PREMIUM_BPS_FLOOR (50 bps) × size, so non-trivially > 0.
      expect(posData.premiumPaidLamports.toNumber()).to.be.greaterThanOrEqual(1);

      await voidCohort(t, cohort, [pos]);
    });
  });

  //
  // NOTE: This scenario is unreachable in production. The update_config
  // instruction enforces mhi_max_delta_bps in [1000, 10000], and
  // initialize sets it to 3300 as default. There is no path to set
  // mhi_max_delta_bps = 0. This test documents that constraint.

  describe("submit_mhi - clamp disabled (mhi_max_delta_bps = 0) is unreachable", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("update_config rejects mhi_max_delta_bps = 0 (min is 1000)", async () => {
      await expectError(
        () =>
          t.program.methods
            .updateConfig({
              keeper: null, mhiCapBps: null, premiumFeeBps: null,
              referralShareBps: null, keeperFeeLamports: null,
              minPositionLamports: null, maxPositionPerAddressBps: null,
              maxVaultRiskPerCohortBps: null, tradingWindowSeconds: null,
              measurementSeconds: null, observationSeconds: null,
              settlementDeadlineSeconds: null, claimExpirySeconds: null,
              mhiFloorBps: null, mhiMaxDeltaBps: 0, minPremiumLamports: null, maxPositionCollateralBps: null, paused: null,
             
            } as any)
            .accounts({ authority: t.authority.publicKey, globalState: t.globalState } as any)
            .rpc(),
        "InvalidConfig",
      );
    });

    it("update_config also rejects mhi_max_delta_bps = 999 (below min)", async () => {
      await expectError(
        () =>
          t.program.methods
            .updateConfig({
              keeper: null, mhiCapBps: null, premiumFeeBps: null,
              referralShareBps: null, keeperFeeLamports: null,
              minPositionLamports: null, maxPositionPerAddressBps: null,
              maxVaultRiskPerCohortBps: null, tradingWindowSeconds: null,
              measurementSeconds: null, observationSeconds: null,
              settlementDeadlineSeconds: null, claimExpirySeconds: null,
              mhiFloorBps: null, mhiMaxDeltaBps: 999, minPremiumLamports: null, maxPositionCollateralBps: null, paused: null,
             
            } as any)
            .accounts({ authority: t.authority.publicKey, globalState: t.globalState } as any)
            .rpc(),
        "InvalidConfig",
      );
    });
  });


  describe("cold-start markup - premium is higher in early cohorts", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("cohort 0 premium is non-trivially large (includes cold-start extra)", async () => {
      // Cohort 0 has maximum cold-start extra: COLD_START_EXTRA_BPS (5000) * 50/50 = 50%
      // on top of the base markup. This makes the premium significantly higher than
      // what the raw EMA alone would produce.
      //
      // We can't easily compare between cohorts because EMA updates from the first
      // cohort's MHI change the base premium, potentially dominating the cold-start
      // decay. Instead, verify:
      // 1. Premium is non-zero (cold-start markup prevents PremiumBelowFloor)
      // 2. The EMA state's markup_bps starts at the default (2000 = 20%)
      const cohort0 = await startCohort(t);

      // Check the EMA markup before first cohort - should be at default
      const ema = await t.program.account.emaState.fetch(t.emaState);
      expect(ema.markupBps).to.equal(2000); // MARKUP_DEFAULT_BPS

      const pos0 = await buyCall(t, cohort0, {
        strikeBps: await currentAtmStrike(t),
        size: SOL(0.05),
        nonce: 0,
      });
      const posData0 = await t.program.account.position.fetch(pos0);
      const premium0 = posData0.premiumPaidLamports.toNumber();

      // Premium must be non-zero - cold-start extra ensures this even with
      // moderate EMA values (our initial EMAs are [3260, 2330, 1560, 1000, 450, 80, 30])
      expect(premium0).to.be.greaterThan(0);

      // The total_cohorts is 1 (first cohort), which means cold-start factor
      // is at maximum: extra = 5000 * (50 - 0) / 50 = 5000 BPS = 50%
      // Verify this implicitly by checking premium is significantly larger
      // than zero for a 0.05 SOL position at 1.2x strike
      expect(premium0).to.be.greaterThan(100_000); // > 0.0001 SOL

      await voidCohort(t, cohort0, [pos0]);
      await claimPosition(t, cohort0, pos0, t.buyer);
    });
  });


  describe("update_config while cohort is active", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("config change succeeds during active cohort", async () => {
      const cohort = await startCohort(t);

      // Buy a position so the cohort is definitely in use
      const pos = await buyCall(t, cohort, { strikeBps: await currentAtmStrike(t) });

      const gsBefore = await t.program.account.globalState.fetch(t.globalState);
      const oldFeeBps = gsBefore.premiumFeeBps;

      // Change premiumFeeBps while cohort is active
      const newFeeBps = oldFeeBps === 200 ? 300 : 200;
      await t.program.methods
        .updateConfig({
          keeper: null, mhiCapBps: null, premiumFeeBps: newFeeBps,
          referralShareBps: null, keeperFeeLamports: null,
          minPositionLamports: null, maxPositionPerAddressBps: null,
          maxVaultRiskPerCohortBps: null, tradingWindowSeconds: null,
          measurementSeconds: null, observationSeconds: null,
          settlementDeadlineSeconds: null, claimExpirySeconds: null,
          mhiFloorBps: null, mhiMaxDeltaBps: null, minPremiumLamports: null, maxPositionCollateralBps: null, paused: null,
         
        } as any)
        .accounts({ authority: t.authority.publicKey, globalState: t.globalState } as any)
        .rpc();

      const gsAfter = await t.program.account.globalState.fetch(t.globalState);
      expect(gsAfter.premiumFeeBps).to.equal(newFeeBps);
      expect(gsAfter.premiumFeeBps).to.not.equal(oldFeeBps);

      await voidCohort(t, cohort, [pos]);
    });
  });


  describe("vault conservation after claim (isolated)", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("vault conservation holds immediately after claim", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { strikeBps: await currentAtmStrike(t), size: SOL(0.1) });

      await warpPastObservation(t.context);
      // ITM submission: 5_000 bps above the ATM live strike.
      await submitMhi(t, cohort, (await currentAtmStrike(t)) + 5_000);
      await settleBatch(t, cohort, [pos]);

      const posData = await t.program.account.position.fetch(pos);
      expect(posData.payoutLamports.toNumber()).to.be.greaterThan(0);

      // Claim and immediately check conservation
      await claimPosition(t, cohort, pos, t.buyer);
      await assertVaultConservation(t);

      // Position PDA should be closed after claim
      expect(await accountExists(t.context.banksClient, pos)).to.be.false;
    });
  });


  describe("vault conservation after expire_position (isolated)", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("vault conservation holds immediately after expire", async () => {
      const cohort = await startCohort(t);
      const pos = await buyCall(t, cohort, { strikeBps: await currentAtmStrike(t), size: SOL(0.1) });

      await warpPastObservation(t.context);
      // ITM submission: 5_000 bps above the ATM live strike.
      await submitMhi(t, cohort, (await currentAtmStrike(t)) + 5_000);
      await settleBatch(t, cohort, [pos]);

      const posData = await t.program.account.position.fetch(pos);
      const payout = posData.payoutLamports.toNumber();
      expect(payout).to.be.greaterThan(0);

      // Warp past claim expiry
      await warpTime(t.context, FAST_CLAIM_EXPIRY + 1);

      // Expire the position
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

      // Immediately check conservation
      await assertVaultConservation(t);

      // Payout should have moved from unclaimed back to available
      const vaultAfter = await t.program.account.vault.fetch(t.vault);
      expect(vaultAfter.availableLamports.toNumber()).to.equal(
        vaultBefore.availableLamports.toNumber() + payout,
      );
      expect(vaultAfter.unclaimedPayoutsLamports.toNumber()).to.equal(
        vaultBefore.unclaimedPayoutsLamports.toNumber() - payout,
      );

      // Position PDA should be closed
      expect(await accountExists(t.context.banksClient, pos)).to.be.false;
    });
  });
});
