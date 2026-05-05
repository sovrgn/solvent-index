import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

import {
  setupProtocol,
  TestCtx,
  expectError,
  warpTime,
  findGlobalStatePda,
  findVaultPda,
  findEmaStatePda,
  MHI_CAP_BPS,
  NUM_STRIKES,
  DEFAULT_STRIKES_BPS,
  FAST_TRADING_WINDOW,
  FAST_MEASUREMENT,
  FAST_OBSERVATION,
  FAST_SETTLEMENT_DEADLINE,
  FAST_CLAIM_EXPIRY,
} from "./_setup";

describe("initialize", () => {

  describe("happy path", () => {
    let t: TestCtx;

    before(async () => {
      t = await setupProtocol();
    });

    it("creates GlobalState with correct values", async () => {
      const gs = await t.program.account.globalState.fetch(t.globalState);

      expect(gs.authority.toBase58()).to.equal(t.authority.publicKey.toBase58());
      expect(gs.keeper.toBase58()).to.equal(t.keeper.publicKey.toBase58());
      expect(gs.mhiCapBps).to.equal(MHI_CAP_BPS);
      expect(gs.premiumFeeBps).to.equal(150);
      expect(gs.referralShareBps).to.equal(3000);
      expect(gs.minPositionLamports.toNumber()).to.equal(10_000_000);
      expect(gs.tradingWindowSeconds).to.equal(FAST_TRADING_WINDOW);
      expect(gs.measurementSeconds).to.equal(FAST_MEASUREMENT);
      expect(gs.observationSeconds).to.equal(FAST_OBSERVATION);
      expect(gs.settlementDeadlineSeconds).to.equal(FAST_SETTLEMENT_DEADLINE);
      expect(gs.claimExpirySeconds).to.equal(FAST_CLAIM_EXPIRY);
    });

    it("GlobalState status is Idle, cohort_index 0, paused false", async () => {
      const gs = await t.program.account.globalState.fetch(t.globalState);

      expect(JSON.stringify(gs.currentCohortStatus)).to.equal(
        JSON.stringify({ idle: {} }),
      );
      expect(gs.currentCohortIndex.toNumber()).to.equal(0);
      expect(gs.paused).to.equal(false);
    });

    it("pending_authority is Pubkey::default()", async () => {
      const gs = await t.program.account.globalState.fetch(t.globalState);
      expect(gs.pendingAuthority.toBase58()).to.equal(
        PublicKey.default.toBase58(),
      );
    });

    it("mhi_max_delta_bps is 3300, mhi_floor_bps is 2000", async () => {
      const gs = await t.program.account.globalState.fetch(t.globalState);
      expect(gs.mhiMaxDeltaBps).to.equal(3_300);
      expect(gs.mhiFloorBps).to.equal(2_000);
    });

    it("Vault has 0 available, 0 active_collateral, 0 unclaimed (pre-seed)", async () => {
      // setupProtocol seeds the vault, so we need a fresh uninit context
      // to test pre-seed vault state. Instead, we verify the vault struct
      // fields that are not affected by seedVault.
      const vault = await t.program.account.vault.fetch(t.vault);
      // After seedVault(20 SOL), available should be 20 SOL
      // But the spec asks about the initialize state. Let's verify via
      // a separate skipInit context below.
    });

    it("EMA strikes initialized with provided initial_ema_values", async () => {
      const ema = await t.program.account.emaState.fetch(t.emaState);
      const expectedEma = [3260, 2330, 1560, 1000, 450, 80, 30];

      for (let i = 0; i < NUM_STRIKES; i++) {
        expect(ema.strikes[i].strikeBps).to.equal(DEFAULT_STRIKES_BPS[i]);
        expect(ema.strikes[i].fastEmaBps).to.equal(expectedEma[i]);
        expect(ema.strikes[i].slowEmaBps).to.equal(expectedEma[i]);
      }
    });
  });

  describe("vault initial state (pre-seed)", () => {
    let t: TestCtx;

    before(async () => {
      t = await setupProtocol({ skipInit: true });
      // Manually initialize without seeding
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
          initialEmaValues: [3260, 2330, 1560, 1000, 450, 80, 30],
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
    });

    it("Vault has 0 available, 0 active_collateral, 0 unclaimed", async () => {
      const vault = await t.program.account.vault.fetch(t.vault);
      expect(vault.availableLamports.toNumber()).to.equal(0);
      expect(vault.activeCollateralLamports.toNumber()).to.equal(0);
      expect(vault.unclaimedPayoutsLamports.toNumber()).to.equal(0);
    });
  });


  describe("error: called twice", () => {
    it("fails if called twice (PDA already exists)", async () => {
      const t = await setupProtocol(); // already initialized + seeded
      await warpTime(t.context, 1); // fresh blockhash for duplicate instruction

      await expectError(
        () =>
          t.program.methods
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
              initialEmaValues: [3260, 2330, 1560, 1000, 450, 80, 30],
              minPremiumLamports: new anchor.BN(0),
            } as any)
            .accounts({
              authority: t.authority.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              emaState: t.emaState,
              systemProgram: SystemProgram.programId,
            } as any)
            .rpc(),
        "already in use",
      );
    });
  });

  describe("error: invalid params", () => {
    it("fails with trading_window_seconds = 0", async () => {
      const t = await setupProtocol({ skipInit: true });

      await expectError(
        () =>
          t.program.methods
            .initialize({
              keeper: t.keeper.publicKey,
              mhiCapBps: MHI_CAP_BPS,
              premiumFeeBps: 150,
              referralShareBps: 3000,
              minPositionLamports: new anchor.BN(10_000_000),
              tradingWindowSeconds: 0,
              measurementSeconds: FAST_MEASUREMENT,
              observationSeconds: FAST_OBSERVATION,
              settlementDeadlineSeconds: FAST_SETTLEMENT_DEADLINE,
              claimExpirySeconds: FAST_CLAIM_EXPIRY,
              initialEmaValues: [3260, 2330, 1560, 1000, 450, 80, 30],
              minPremiumLamports: new anchor.BN(0),
            } as any)
            .accounts({
              authority: t.authority.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              emaState: t.emaState,
              systemProgram: SystemProgram.programId,
            } as any)
            .rpc(),
        "InvalidConfig",
      );
    });

    it("fails with measurement_seconds = 0", async () => {
      const t = await setupProtocol({ skipInit: true });

      await expectError(
        () =>
          t.program.methods
            .initialize({
              keeper: t.keeper.publicKey,
              mhiCapBps: MHI_CAP_BPS,
              premiumFeeBps: 150,
              referralShareBps: 3000,
              minPositionLamports: new anchor.BN(10_000_000),
              tradingWindowSeconds: FAST_TRADING_WINDOW,
              measurementSeconds: 0,
              observationSeconds: FAST_OBSERVATION,
              settlementDeadlineSeconds: FAST_SETTLEMENT_DEADLINE,
              claimExpirySeconds: FAST_CLAIM_EXPIRY,
              initialEmaValues: [3260, 2330, 1560, 1000, 450, 80, 30],
              minPremiumLamports: new anchor.BN(0),
            } as any)
            .accounts({
              authority: t.authority.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              emaState: t.emaState,
              systemProgram: SystemProgram.programId,
            } as any)
            .rpc(),
        "InvalidConfig",
      );
    });

    it("fails with observation_seconds = 0", async () => {
      const t = await setupProtocol({ skipInit: true });

      await expectError(
        () =>
          t.program.methods
            .initialize({
              keeper: t.keeper.publicKey,
              mhiCapBps: MHI_CAP_BPS,
              premiumFeeBps: 150,
              referralShareBps: 3000,
              minPositionLamports: new anchor.BN(10_000_000),
              tradingWindowSeconds: FAST_TRADING_WINDOW,
              measurementSeconds: FAST_MEASUREMENT,
              observationSeconds: 0,
              settlementDeadlineSeconds: FAST_SETTLEMENT_DEADLINE,
              claimExpirySeconds: FAST_CLAIM_EXPIRY,
              initialEmaValues: [3260, 2330, 1560, 1000, 450, 80, 30],
              minPremiumLamports: new anchor.BN(0),
            } as any)
            .accounts({
              authority: t.authority.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              emaState: t.emaState,
              systemProgram: SystemProgram.programId,
            } as any)
            .rpc(),
        "InvalidConfig",
      );
    });

    it("fails with settlement_deadline_seconds = 0", async () => {
      const t = await setupProtocol({ skipInit: true });

      await expectError(
        () =>
          t.program.methods
            .initialize({
              keeper: t.keeper.publicKey,
              mhiCapBps: MHI_CAP_BPS,
              premiumFeeBps: 150,
              referralShareBps: 3000,
              minPositionLamports: new anchor.BN(10_000_000),
              tradingWindowSeconds: FAST_TRADING_WINDOW,
              measurementSeconds: FAST_MEASUREMENT,
              observationSeconds: FAST_OBSERVATION,
              settlementDeadlineSeconds: 0,
              claimExpirySeconds: FAST_CLAIM_EXPIRY,
              initialEmaValues: [3260, 2330, 1560, 1000, 450, 80, 30],
              minPremiumLamports: new anchor.BN(0),
            } as any)
            .accounts({
              authority: t.authority.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              emaState: t.emaState,
              systemProgram: SystemProgram.programId,
            } as any)
            .rpc(),
        "InvalidConfig",
      );
    });

    it("fails with claim_expiry_seconds = 0", async () => {
      const t = await setupProtocol({ skipInit: true });

      await expectError(
        () =>
          t.program.methods
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
              claimExpirySeconds: 0,
              initialEmaValues: [3260, 2330, 1560, 1000, 450, 80, 30],
              minPremiumLamports: new anchor.BN(0),
            } as any)
            .accounts({
              authority: t.authority.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              emaState: t.emaState,
              systemProgram: SystemProgram.programId,
            } as any)
            .rpc(),
        "InvalidConfig",
      );
    });

    it("fails with min_position_lamports = 0", async () => {
      const t = await setupProtocol({ skipInit: true });

      await expectError(
        () =>
          t.program.methods
            .initialize({
              keeper: t.keeper.publicKey,
              mhiCapBps: MHI_CAP_BPS,
              premiumFeeBps: 150,
              referralShareBps: 3000,
              minPositionLamports: new anchor.BN(0),
              tradingWindowSeconds: FAST_TRADING_WINDOW,
              measurementSeconds: FAST_MEASUREMENT,
              observationSeconds: FAST_OBSERVATION,
              settlementDeadlineSeconds: FAST_SETTLEMENT_DEADLINE,
              claimExpirySeconds: FAST_CLAIM_EXPIRY,
              initialEmaValues: [3260, 2330, 1560, 1000, 450, 80, 30],
              minPremiumLamports: new anchor.BN(0),
            } as any)
            .accounts({
              authority: t.authority.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              emaState: t.emaState,
              systemProgram: SystemProgram.programId,
            } as any)
            .rpc(),
        "InvalidConfig",
      );
    });

    it("fails with mhi_cap_bps = 0", async () => {
      const t = await setupProtocol({ skipInit: true });

      await expectError(
        () =>
          t.program.methods
            .initialize({
              keeper: t.keeper.publicKey,
              mhiCapBps: 0,
              premiumFeeBps: 150,
              referralShareBps: 3000,
              minPositionLamports: new anchor.BN(10_000_000),
              tradingWindowSeconds: FAST_TRADING_WINDOW,
              measurementSeconds: FAST_MEASUREMENT,
              observationSeconds: FAST_OBSERVATION,
              settlementDeadlineSeconds: FAST_SETTLEMENT_DEADLINE,
              claimExpirySeconds: FAST_CLAIM_EXPIRY,
              initialEmaValues: [3260, 2330, 1560, 1000, 450, 80, 30],
              minPremiumLamports: new anchor.BN(0),
            } as any)
            .accounts({
              authority: t.authority.publicKey,
              globalState: t.globalState,
              vault: t.vault,
              emaState: t.emaState,
              systemProgram: SystemProgram.programId,
            } as any)
            .rpc(),
        "InvalidConfig",
      );
    });
  });


  describe("edge: keeper set to authority's own address", () => {
    it("succeeds when keeper equals authority", async () => {
      const t = await setupProtocol({ skipInit: true });

      await t.program.methods
        .initialize({
          keeper: t.authority.publicKey, // same as authority
          mhiCapBps: MHI_CAP_BPS,
          premiumFeeBps: 150,
          referralShareBps: 3000,
          minPositionLamports: new anchor.BN(10_000_000),
          tradingWindowSeconds: FAST_TRADING_WINDOW,
          measurementSeconds: FAST_MEASUREMENT,
          observationSeconds: FAST_OBSERVATION,
          settlementDeadlineSeconds: FAST_SETTLEMENT_DEADLINE,
          claimExpirySeconds: FAST_CLAIM_EXPIRY,
          initialEmaValues: [3260, 2330, 1560, 1000, 450, 80, 30],
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

      const gs = await t.program.account.globalState.fetch(t.globalState);
      expect(gs.keeper.toBase58()).to.equal(t.authority.publicKey.toBase58());
    });
  });
});
