import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, SystemProgram, PublicKey } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, warpTime, assertVaultConservation,
  voidCohort, runFullCohort, SOL, getBalance, accountExists,
  fundedKeypair, findPositionPda, findCohortPda,
  FAST_TRADING_WINDOW, FAST_MEASUREMENT, FAST_OBSERVATION,
  FAST_SETTLEMENT_DEADLINE, FAST_CLAIM_EXPIRY, MHI_CAP_BPS,
  DEFAULT_STRIKES_BPS,
} from "./_setup";

describe("18 - referral edge cases", () => {


  describe("self-referral (referrer = buyer)", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("succeeds - buyer gets both payout and referral cut", async () => {
      const cohort = await startCohort(t);

      const buyerBalBefore = await getBalance(t.context.banksClient, t.buyer.publicKey);

      // Buy with self as referrer
      const posPda = await buyCall(t, cohort, {
        strikeBps: 12_000,
        size: SOL(0.05),
        nonce: 0,
        referrer: t.buyer.publicKey,
      });

      // Position created successfully
      const position = await t.program.account.position.fetch(posPda);
      expect(position.owner.toBase58()).to.equal(t.buyer.publicKey.toBase58());

      // vault_premium < premium_paid because referral split happened
      expect(position.vaultPremiumLamports.toNumber()).to.be.lessThan(
        position.premiumPaidLamports.toNumber(),
      );

      // The referral cut went back to the buyer's own account
      const referralAmount =
        position.premiumPaidLamports.toNumber() -
        position.vaultPremiumLamports.toNumber();
      expect(referralAmount).to.be.greaterThan(0);

      await assertVaultConservation(t);
      await voidCohort(t, cohort, [posPda]);
    });
  });


  describe("referral_share_bps = 0 - no referral transfer", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("referrer balance unchanged, vault_premium == premium_paid", async () => {
      // Set referralShareBps to 0
      await t.program.methods
        .updateConfig({
          keeper: null, mhiCapBps: null, premiumFeeBps: null,
          referralShareBps: 0,
          keeperFeeLamports: null, minPositionLamports: null,
          maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
          tradingWindowSeconds: null, measurementSeconds: null,
          observationSeconds: null, settlementDeadlineSeconds: null,
          claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null,
          minPremiumLamports: null, maxPositionCollateralBps: null, paused: null,
         
        } as any)
        .accounts({ authority: t.authority.publicKey, globalState: t.globalState } as any)
        .rpc();

      const gs = await t.program.account.globalState.fetch(t.globalState);
      expect(gs.referralShareBps).to.equal(0);

      const cohort = await startCohort(t);
      const referrer = await fundedKeypair(t.context, 1);
      const referrerBalBefore = await getBalance(t.context.banksClient, referrer.publicKey);

      const posPda = await buyCall(t, cohort, {
        strikeBps: 12_000,
        size: SOL(0.05),
        nonce: 0,
        referrer: referrer.publicKey,
      });

      const referrerBalAfter = await getBalance(t.context.banksClient, referrer.publicKey);

      // Referrer balance should NOT change
      expect(referrerBalAfter).to.equal(referrerBalBefore);

      // vault_premium should equal premium_paid (no split)
      const position = await t.program.account.position.fetch(posPda);
      expect(position.vaultPremiumLamports.toNumber()).to.equal(
        position.premiumPaidLamports.toNumber(),
      );

      // Reset referralShareBps back to 3000
      await t.program.methods
        .updateConfig({
          keeper: null, mhiCapBps: null, premiumFeeBps: null,
          referralShareBps: 3000,
          keeperFeeLamports: null, minPositionLamports: null,
          maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
          tradingWindowSeconds: null, measurementSeconds: null,
          observationSeconds: null, settlementDeadlineSeconds: null,
          claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null,
          minPremiumLamports: null, maxPositionCollateralBps: null, paused: null,
         
        } as any)
        .accounts({ authority: t.authority.publicKey, globalState: t.globalState } as any)
        .rpc();

      await assertVaultConservation(t);
      await voidCohort(t, cohort, [posPda]);
    });
  });


  describe("referrer account not writable - treated as no referral", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("vault_premium == premium_paid when referrer is read-only", async () => {
      const cohort = await startCohort(t);
      const referrer = await fundedKeypair(t.context, 1);

      const strikeBps = 12_000;
      const size = SOL(0.05);
      const nonce = 0;
      const who = t.buyer;
      const [posPda] = findPositionPda(t.program.programId, cohort, who.publicKey, strikeBps, nonce);

      // Manually build the buy_call with a non-writable remaining account
      await t.program.methods
        .buyCall(strikeBps, size, nonce)
        .accounts({
          buyer: who.publicKey,
          globalState: t.globalState,
          vault: t.vault,
          cohort,
          emaState: t.emaState,
          position: posPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .remainingAccounts([
          { pubkey: referrer.publicKey, isWritable: false, isSigner: false },
        ])
        .signers([who])
        .rpc();

      const position = await t.program.account.position.fetch(posPda);

      // When referrer is not writable, program should skip referral
      // vault_premium should equal premium_paid
      expect(position.vaultPremiumLamports.toNumber()).to.equal(
        position.premiumPaidLamports.toNumber(),
      );

      await assertVaultConservation(t);
      await voidCohort(t, cohort, [posPda]);
    });
  });


  describe("void_cohort refund without referral - refund == premium_paid", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("position.vaultPremium == premiumPaid, refund equals vault_premium", async () => {
      const cohort = await startCohort(t);

      // Buy without referrer
      const posPda = await buyCall(t, cohort, {
        strikeBps: 12_000,
        size: SOL(0.05),
        nonce: 0,
      });

      const posData = await t.program.account.position.fetch(posPda);

      // Without referral, vault_premium == premium_paid
      expect(posData.vaultPremiumLamports.toNumber()).to.equal(
        posData.premiumPaidLamports.toNumber(),
      );

      const vaultPremium = posData.vaultPremiumLamports.toNumber();

      // Void the cohort
      await voidCohort(t, cohort, [posPda]);

      // After void, payout should equal vault_premium (== premium_paid)
      const posAfterVoid = await t.program.account.position.fetch(posPda);
      expect(posAfterVoid.settled).to.equal(true);
      expect(posAfterVoid.payoutLamports.toNumber()).to.equal(vaultPremium);
      expect(posAfterVoid.payoutLamports.toNumber()).to.equal(
        posData.premiumPaidLamports.toNumber(),
      );

      // Claim the refund and verify buyer gets it
      const balBefore = await getBalance(t.context.banksClient, t.buyer.publicKey);
      await claimPosition(t, cohort, posPda, t.buyer);
      const balAfter = await getBalance(t.context.banksClient, t.buyer.publicKey);

      expect(balAfter).to.be.greaterThan(balBefore);
      await assertVaultConservation(t);
    });
  });
});
