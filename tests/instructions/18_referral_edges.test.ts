import { expect } from "chai";
import { SystemProgram } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, assertVaultConservation,
  voidCohort, SOL, getBalance, claimPosition,
  fundedKeypair, findPositionPda, currentAtmStrike,
} from "./_setup";

describe("18 - referral edge cases", () => {


  describe("self-referral (referrer = buyer) → SelfReferral", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("buy_call with self as referrer is rejected", async () => {
      const cohort = await startCohort(t);
      const atm = await currentAtmStrike(t);

      const [posPda] = findPositionPda(
        t.program.programId, cohort, t.buyer.publicKey, atm, 0,
      );

      await expectError(
        () =>
          t.program.methods
            .buyCall(atm, SOL(0.05), 0)
            .accounts({
              buyer: t.buyer.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              cohort,
              emaState: t.emaState,
              position: posPda,
              systemProgram: SystemProgram.programId,
            } as any)
            .remainingAccounts([
              { pubkey: t.buyer.publicKey, isWritable: true, isSigner: false },
            ])
            .signers([t.buyer])
            .rpc(),
        "SelfReferral",
      );

      await voidCohort(t, cohort);
    });
  });


  describe("referral_share_bps = 0 - no referral transfer", () => {
    let t: TestCtx;

    before(async () => { t = await setupProtocol(); });

    it("referrer balance unchanged, vault_premium == premium_paid", async () => {
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
        size: SOL(0.05),
        nonce: 0,
        referrer: referrer.publicKey,
      });

      const referrerBalAfter = await getBalance(t.context.banksClient, referrer.publicKey);

      expect(referrerBalAfter).to.equal(referrerBalBefore);

      const position = await t.program.account.position.fetch(posPda);
      expect(position.vaultPremiumLamports.toNumber()).to.equal(
        position.premiumPaidLamports.toNumber(),
      );

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

      const atm = await currentAtmStrike(t);
      const size = SOL(0.05);
      const nonce = 0;
      const who = t.buyer;
      const [posPda] = findPositionPda(t.program.programId, cohort, who.publicKey, atm, nonce);

      await t.program.methods
        .buyCall(atm, size, nonce)
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

    it("position.vaultPremium == premiumPaid, refund equals premium_paid", async () => {
      const cohort = await startCohort(t);

      const posPda = await buyCall(t, cohort, {
        size: SOL(0.05),
        nonce: 0,
      });

      const posData = await t.program.account.position.fetch(posPda);

      expect(posData.vaultPremiumLamports.toNumber()).to.equal(
        posData.premiumPaidLamports.toNumber(),
      );

      const vaultPremium = posData.vaultPremiumLamports.toNumber();

      await voidCohort(t, cohort, [posPda]);

      const posAfterVoid = await t.program.account.position.fetch(posPda);
      expect(posAfterVoid.settled).to.equal(true);
      expect(posAfterVoid.payoutLamports.toNumber()).to.equal(vaultPremium);
      expect(posAfterVoid.payoutLamports.toNumber()).to.equal(
        posData.premiumPaidLamports.toNumber(),
      );

      const balBefore = await getBalance(t.context.banksClient, t.buyer.publicKey);
      await claimPosition(t, cohort, posPda, t.buyer);
      const balAfter = await getBalance(t.context.banksClient, t.buyer.publicKey);

      expect(balAfter).to.be.greaterThan(balBefore);
      await assertVaultConservation(t);
    });
  });
});
