import * as anchor from "@coral-xyz/anchor";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

import {
  setupProtocol,
  expectError,
  startCohort,
  buyCall,
  voidCohort,
  warpTime,
  assertVaultConservation,
  getBalance,
  fundedKeypair,
  findCohortPda,
  findPositionPda,
  TestCtx,
  SOL,
  FAST_TRADING_WINDOW,
  DEFAULT_STRIKES_BPS,
  MHI_CAP_BPS,
} from "./_setup";

describe("07 - buy_call", () => {
  let t: TestCtx;

  before(async () => {
    t = await setupProtocol();
  });


  describe("happy path", () => {
    let cohort: anchor.web3.PublicKey;

    before(async () => {
      cohort = await startCohort(t);
    });

    after(async () => {
      // Clean up active cohort
      await voidCohort(t, cohort, []);
    });

    it("buy at valid strike - Position PDA created with correct fields", async () => {
      const strikeBps = DEFAULT_STRIKES_BPS[2];
      const size = SOL(0.05);
      const nonce = 0;

      const posPda = await buyCall(t, cohort, {
        strikeBps,
        size,
        nonce,
      });

      const position = await t.program.account.position.fetch(posPda);
      expect(position.owner.toBase58()).to.equal(t.buyer.publicKey.toBase58());
      expect(position.cohort.toBase58()).to.equal(cohort.toBase58());
      expect(position.strikeBps).to.equal(strikeBps);
      expect(position.sizeLamports.toNumber()).to.equal(size.toNumber());
      expect(position.nonce).to.equal(nonce);
      expect(position.settled).to.equal(false);
      expect(position.claimed).to.equal(false);
      expect(position.payoutLamports.toNumber()).to.equal(0);
    });

    it("premium non-zero, collateral locked, vault accounting correct", async () => {
      // Position from previous test - fetch it
      const strikeBps = DEFAULT_STRIKES_BPS[2];
      const [posPda] = findPositionPda(
        t.program.programId,
        cohort,
        t.buyer.publicKey,
        strikeBps,
        0,
      );
      const position = await t.program.account.position.fetch(posPda);

      // Premium must be non-zero
      expect(position.premiumPaidLamports.toNumber()).to.be.greaterThan(0);

      // Collateral = ceil((MHI_CAP - strike) * size / 10000)
      // = ceil((30000 - 12000) * 50_000_000 / 10000) = ceil(90_000_000) = 90_000_000
      const expectedCollateral = Math.ceil(
        ((MHI_CAP_BPS - strikeBps) * SOL(0.05).toNumber()) / 10_000,
      );

      const vault = await t.program.account.vault.fetch(t.vault);
      expect(vault.activeCollateralLamports.toNumber()).to.be.greaterThanOrEqual(
        expectedCollateral,
      );

      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.totalPositions).to.equal(1);
      expect(cohortData.totalCallVolumeLamports.toNumber()).to.equal(
        SOL(0.05).toNumber(),
      );
    });

    it("vault conservation holds after buy", async () => {
      await assertVaultConservation(t);
    });
  });


  describe("happy path - referral", () => {
    let cohort: anchor.web3.PublicKey;
    let referrer: Keypair;

    before(async () => {
      cohort = await startCohort(t);
      referrer = await fundedKeypair(t.context, 1);
    });

    after(async () => {
      const [pos] = findPositionPda(
        t.program.programId,
        cohort,
        t.buyer.publicKey,
        DEFAULT_STRIKES_BPS[2],
        0,
      );
      await voidCohort(t, cohort, [pos]);
    });

    it("buy with referrer in remaining_accounts - referrer balance increases", async () => {
      const referrerBalBefore = await getBalance(
        t.context.banksClient,
        referrer.publicKey,
      );

      const posPda = await buyCall(t, cohort, {
        strikeBps: DEFAULT_STRIKES_BPS[2],
        size: SOL(0.05),
        nonce: 0,
        referrer: referrer.publicKey,
      });

      const referrerBalAfter = await getBalance(
        t.context.banksClient,
        referrer.publicKey,
      );

      // Referrer should have received some lamports
      expect(referrerBalAfter).to.be.greaterThan(referrerBalBefore);

      // vault_premium < premium_paid when referral is active
      const position = await t.program.account.position.fetch(posPda);
      expect(position.vaultPremiumLamports.toNumber()).to.be.lessThan(
        position.premiumPaidLamports.toNumber(),
      );

      // Referral amount = premium_paid - vault_premium
      const referralAmount =
        position.premiumPaidLamports.toNumber() -
        position.vaultPremiumLamports.toNumber();
      expect(referrerBalAfter - referrerBalBefore).to.equal(referralAmount);
    });
  });


  describe("error paths", () => {
    it("protocol paused → ProtocolPaused", async () => {
      // Start a cohort first
      const cohort = await startCohort(t);

      // Pause protocol
      await t.program.methods
        .updateConfig({
          keeper: null,
          mhiCapBps: null,
          premiumFeeBps: null,
          referralShareBps: null,
          keeperFeeLamports: null,
          minPositionLamports: null,
          maxPositionPerAddressBps: null,
          maxVaultRiskPerCohortBps: null,
          tradingWindowSeconds: null,
          measurementSeconds: null,
          observationSeconds: null,
          settlementDeadlineSeconds: null,
          claimExpirySeconds: null,
          mhiFloorBps: null,
          mhiMaxDeltaBps: null,
          minPremiumLamports: null,
          maxPositionCollateralBps: null,
          paused: true,
         
        } as any)
        .accounts({
          authority: t.authority.publicKey,
          globalState: t.globalState,
        } as any)
        .rpc();

      const [posPda] = findPositionPda(
        t.program.programId,
        cohort,
        t.buyer.publicKey,
        DEFAULT_STRIKES_BPS[2],
        0,
      );

      await expectError(
        () =>
          t.program.methods
            .buyCall(DEFAULT_STRIKES_BPS[2], SOL(0.05), 0)
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
        "ProtocolPaused",
      );

      // Unpause and clean up
      await t.program.methods
        .updateConfig({
          keeper: null,
          mhiCapBps: null,
          premiumFeeBps: null,
          referralShareBps: null,
          keeperFeeLamports: null,
          minPositionLamports: null,
          maxPositionPerAddressBps: null,
          maxVaultRiskPerCohortBps: null,
          tradingWindowSeconds: null,
          measurementSeconds: null,
          observationSeconds: null,
          settlementDeadlineSeconds: null,
          claimExpirySeconds: null,
          mhiFloorBps: null,
          mhiMaxDeltaBps: null,
          minPremiumLamports: null,
          maxPositionCollateralBps: null,
          paused: false,
         
        } as any)
        .accounts({
          authority: t.authority.publicKey,
          globalState: t.globalState,
        } as any)
        .rpc();

      await voidCohort(t, cohort);
    });

    it("clock past trading_deadline → TradingWindowClosed", async () => {
      const cohort = await startCohort(t);

      // Warp past trading window
      await warpTime(t.context, FAST_TRADING_WINDOW + 1);

      const [posPda] = findPositionPda(
        t.program.programId,
        cohort,
        t.buyer.publicKey,
        DEFAULT_STRIKES_BPS[2],
        0,
      );

      await expectError(
        () =>
          t.program.methods
            .buyCall(DEFAULT_STRIKES_BPS[2], SOL(0.05), 0)
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

    it("size = 0 → PositionSizeZero", async () => {
      const cohort = await startCohort(t);

      const [posPda] = findPositionPda(
        t.program.programId,
        cohort,
        t.buyer.publicKey,
        DEFAULT_STRIKES_BPS[2],
        0,
      );

      await expectError(
        () =>
          t.program.methods
            .buyCall(DEFAULT_STRIKES_BPS[2], new anchor.BN(0), 0)
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
        "PositionSizeZero",
      );

      await voidCohort(t, cohort);
    });

    it("size < min_position → PositionTooSmall", async () => {
      const cohort = await startCohort(t);

      // min_position_lamports = 10_000_000 (0.01 SOL), so try 1 lamport
      const [posPda] = findPositionPda(
        t.program.programId,
        cohort,
        t.buyer.publicKey,
        DEFAULT_STRIKES_BPS[2],
        0,
      );

      await expectError(
        () =>
          t.program.methods
            .buyCall(DEFAULT_STRIKES_BPS[2], new anchor.BN(1), 0)
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
        "PositionTooSmall",
      );

      await voidCohort(t, cohort);
    });

    it("invalid strike → InvalidStrike", async () => {
      const cohort = await startCohort(t);

      const badStrike = 99_999;
      const [posPda] = findPositionPda(
        t.program.programId,
        cohort,
        t.buyer.publicKey,
        badStrike,
        0,
      );

      await expectError(
        () =>
          t.program.methods
            .buyCall(badStrike, SOL(0.05), 0)
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
        "InvalidStrike",
      );

      await voidCohort(t, cohort);
    });

    it("vault insufficient collateral → InsufficientVaultCollateral", async () => {
      const cohort = await startCohort(t);

      // SOL(100) at any valid strike exhausts the ~20-SOL test vault.
      const lowestStrike = DEFAULT_STRIKES_BPS[0];
      const excessiveSize = SOL(100);

      const [posPda] = findPositionPda(
        t.program.programId,
        cohort,
        t.buyer.publicKey,
        lowestStrike,
        0,
      );

      await expectError(
        () =>
          t.program.methods
            .buyCall(lowestStrike, excessiveSize, 0)
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
        "InsufficientVaultCollateral",
      );

      await voidCohort(t, cohort);
    });
  });


  describe("edge cases", () => {
    it("buy at minimum position size (0.01 SOL) - succeeds", async () => {
      const cohort = await startCohort(t);

      // min_position_lamports = 10_000_000 = 0.01 SOL
      const minSize = new anchor.BN(10_000_000);
      const posPda = await buyCall(t, cohort, {
        strikeBps: DEFAULT_STRIKES_BPS[2],
        size: minSize,
        nonce: 0,
      });

      const position = await t.program.account.position.fetch(posPda);
      expect(position.sizeLamports.toNumber()).to.equal(minSize.toNumber());

      await voidCohort(t, cohort, [posPda]);
    });

    it("buy at each of 7 strikes - all succeed", async () => {
      const cohort = await startCohort(t);
      const positions: anchor.web3.PublicKey[] = [];

      for (let i = 0; i < DEFAULT_STRIKES_BPS.length; i++) {
        const strikeBps = DEFAULT_STRIKES_BPS[i];
        const posPda = await buyCall(t, cohort, {
          strikeBps,
          size: SOL(0.02),
          nonce: 0,
        });
        positions.push(posPda);

        const position = await t.program.account.position.fetch(posPda);
        expect(position.strikeBps).to.equal(strikeBps);
      }

      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.totalPositions).to.equal(DEFAULT_STRIKES_BPS.length);

      await voidCohort(t, cohort, positions);
    });

    it("multiple positions same buyer, same strike, different nonces", async () => {
      const cohort = await startCohort(t);
      const positions: anchor.web3.PublicKey[] = [];

      for (let nonce = 0; nonce < 3; nonce++) {
        const posPda = await buyCall(t, cohort, {
          strikeBps: DEFAULT_STRIKES_BPS[2],
          size: SOL(0.02),
          nonce,
        });
        positions.push(posPda);
      }

      // All 3 positions exist
      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.totalPositions).to.equal(3);

      // Each position has different nonce
      for (let nonce = 0; nonce < 3; nonce++) {
        const pos = await t.program.account.position.fetch(positions[nonce]);
        expect(pos.nonce).to.equal(nonce);
        expect(pos.strikeBps).to.equal(DEFAULT_STRIKES_BPS[2]);
      }

      await voidCohort(t, cohort, positions);
    });

    it("multiple positions same buyer, different strikes", async () => {
      const cohort = await startCohort(t);
      const positions: anchor.web3.PublicKey[] = [];
      // Sample low / ATM / high from the anchor-derived ladder.
      const strikes = [DEFAULT_STRIKES_BPS[0], DEFAULT_STRIKES_BPS[2], DEFAULT_STRIKES_BPS[6]];

      for (const strikeBps of strikes) {
        const posPda = await buyCall(t, cohort, {
          strikeBps,
          size: SOL(0.02),
          nonce: 0,
        });
        positions.push(posPda);
      }

      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.totalPositions).to.equal(strikes.length);

      for (let i = 0; i < strikes.length; i++) {
        const pos = await t.program.account.position.fetch(positions[i]);
        expect(pos.strikeBps).to.equal(strikes[i]);
        expect(pos.owner.toBase58()).to.equal(t.buyer.publicKey.toBase58());
      }

      await voidCohort(t, cohort, positions);
    });
  });
});
