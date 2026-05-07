import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { Mhi } from "../../target/types/mhi";
import {
  findGlobalStatePda,
  findVaultPda,
  findEmaStatePda,
  findCohortPda,
  findPositionPda,
} from "../helpers/accounts";
import { getBankrunContext, warpTime, createFundedKeypair } from "../helpers/context";
import {
  FAST_TRADING_WINDOW,
  FAST_MEASUREMENT,
  FAST_OBSERVATION,
  FAST_SETTLEMENT_DEADLINE,
  FAST_CLAIM_EXPIRY,
  SOL,
} from "../helpers/constants";
import { ProgramTestContext } from "solana-bankrun";

/**
 * Edge case tests that fill gaps from the test audit.
 * Protocol is already initialized from prior test files.
 */
describe("mhi protocol - edge cases", () => {
  let provider: anchor.Provider;
  let program: Program<Mhi>;
  let context: ProgramTestContext;

  let authority: Keypair;
  let keeper: Keypair;
  let buyer: Keypair;
  let randomUser: Keypair;

  let globalStatePda: anchor.web3.PublicKey;
  let vaultPda: anchor.web3.PublicKey;
  let emaStatePda: anchor.web3.PublicKey;

  before(async () => {
    const bankrun = await getBankrunContext();
    context = bankrun.context;
    provider = bankrun.provider;
    program = bankrun.program;
    authority = (provider.wallet as anchor.Wallet).payer;

    [globalStatePda] = findGlobalStatePda(program.programId);
    [vaultPda] = findVaultPda(program.programId);
    [emaStatePda] = findEmaStatePda(program.programId);

    keeper = await createFundedKeypair(context);
    buyer = await createFundedKeypair(context);
    randomUser = await createFundedKeypair(context);

    await program.methods
      .updateConfig({
        keeper: keeper.publicKey,
        mhiCapBps: null, premiumFeeBps: null, referralShareBps: null,
        keeperFeeLamports: null, minPositionLamports: null,
        maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
        tradingWindowSeconds: null, measurementSeconds: null,
        observationSeconds: null, settlementDeadlineSeconds: null,
        claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null,
        minPremiumLamports: null, maxPositionCollateralBps: null, paused: null,
       
      } as any)
      .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
      .rpc();
  });


  describe("buy_call - PositionTooSmall", () => {
    it("rejects size > 0 but below minimum", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      await program.methods
        .startCohort()
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          emaState: emaStatePda,
          cohort: cohortPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([keeper])
        .rpc();

      // min_position_lamports = 10_000_000 (0.01 SOL). Try with 9_999_999.
      const strikeBps = 12_000;
      const [posPda] = findPositionPda(
        program.programId, cohortPda, buyer.publicKey, strikeBps, 0
      );

      try {
        await program.methods
          .buyCall(strikeBps, new anchor.BN(9_999_999), 0)
          .accounts({
            buyer: buyer.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            cohort: cohortPda,
            emaState: emaStatePda,
            position: posPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("PositionTooSmall");
      }

      // Clean up: void the cohort
      const wait = FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION
        + FAST_SETTLEMENT_DEADLINE + FAST_SETTLEMENT_DEADLINE + 3;
      await warpTime(context, wait);
      await (program.methods
        .voidCohort()
        .accounts({
          authority: authority.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
        } as any)
        .rpc());
    });
  });


  describe("claim - ClaimExpired", () => {
    it("rejects claim after deadline passes", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      // Run a cohort to settlement
      await program.methods
        .startCohort()
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          emaState: emaStatePda,
          cohort: cohortPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([keeper])
        .rpc();

      const strikeBps = 12_000;
      const [posPda] = findPositionPda(
        program.programId, cohortPda, buyer.publicKey, strikeBps, 0
      );

      await program.methods
        .buyCall(strikeBps, SOL(0.05), 0)
        .accounts({
          buyer: buyer.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
          emaState: emaStatePda,
          position: posPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([buyer])
        .rpc();

      await warpTime(context, FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION + 2);

      await program.methods
        .submitMhi(14_000, 20, Array.from({ length: 32 }, () => 0))
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          cohort: cohortPda,
          emaState: emaStatePda,
          vault: vaultPda,
        } as any)
        .signers([keeper])
        .rpc();

      await program.methods
        .settleBatch()
        .accounts({
          caller: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
        } as any)
        .remainingAccounts([{ pubkey: posPda, isWritable: true, isSigner: false }])
        .signers([keeper])
        .rpc();

      // Warp past claim expiry
      await warpTime(context, FAST_CLAIM_EXPIRY + 1);

      try {
        await program.methods
          .claim()
          .accounts({
            caller: buyer.publicKey,
            owner: buyer.publicKey,
            vault: vaultPda,
            cohort: cohortPda,
            position: posPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ClaimExpired");
      }

      // Clean up: expire the position
      await program.methods
        .expirePosition()
        .accounts({
          caller: randomUser.publicKey,
          vault: vaultPda,
          cohort: cohortPda,
          position: posPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([randomUser])
        .rpc();
    });
  });


  describe("submit_mhi - clamp", () => {
    it("extreme MHI is clamped to 33% of previous", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const lastMhi = gs.lastMhiBps;
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      // Start empty cohort
      await program.methods
        .startCohort()
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          emaState: emaStatePda,
          cohort: cohortPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([keeper])
        .rpc();

      await warpTime(context, FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION + 2);

      // Submit extreme MHI (1 BPS) - should be clamped upward
      await program.methods
        .submitMhi(1, 20, Array.from({ length: 32 }, () => 0))
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          cohort: cohortPda,
          emaState: emaStatePda,
          vault: vaultPda,
        } as any)
        .signers([keeper])
        .rpc();

      const cohort = await program.account.cohort.fetch(cohortPda);

      if (lastMhi > 0) {
        // Clamp: lower bound = lastMhi - lastMhi * 3300 / 10000
        const maxMove = Math.floor(lastMhi * 3300 / 10000);
        const expectedClamped = Math.max(lastMhi - maxMove, 1);
        expect(cohort.mhiBps).to.equal(expectedClamped);
        expect(cohort.mhiBps).to.be.greaterThan(1); // Was clamped, not raw value
      } else {
        // No history - unclamped
        expect(cohort.mhiBps).to.equal(1);
      }

      // Settle empty cohort
      await program.methods
        .settleBatch()
        .accounts({
          caller: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
        } as any)
        .signers([keeper])
        .rpc();
    });
  });


  describe("settle_batch - NoPositionsProvided", () => {
    it("rejects empty remaining_accounts when positions exist", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      await program.methods
        .startCohort()
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          emaState: emaStatePda,
          cohort: cohortPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([keeper])
        .rpc();

      // Buy a position
      const strikeBps = 10_000;
      const [posPda] = findPositionPda(
        program.programId, cohortPda, buyer.publicKey, strikeBps, 0
      );
      await program.methods
        .buyCall(strikeBps, SOL(0.05), 0)
        .accounts({
          buyer: buyer.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
          emaState: emaStatePda,
          position: posPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([buyer])
        .rpc();

      await warpTime(context, FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION + 2);

      await program.methods
        .submitMhi(13_000, 20, Array.from({ length: 32 }, () => 0))
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          cohort: cohortPda,
          emaState: emaStatePda,
          vault: vaultPda,
        } as any)
        .signers([keeper])
        .rpc();

      // Try settle with NO remaining accounts - should fail
      try {
        await program.methods
          .settleBatch()
          .accounts({
            caller: keeper.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            cohort: cohortPda,
          } as any)
          .signers([keeper])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("NoPositionsProvided");
      }

      // Actually settle so we can proceed
      await program.methods
        .settleBatch()
        .accounts({
          caller: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
        } as any)
        .remainingAccounts([{ pubkey: posPda, isWritable: true, isSigner: false }])
        .signers([keeper])
        .rpc();

      // Claim to clean up
      await program.methods
        .claim()
        .accounts({
          caller: buyer.publicKey,
          owner: buyer.publicKey,
          vault: vaultPda,
          cohort: cohortPda,
          position: posPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([buyer])
        .rpc();
    });
  });


  describe("sync_vault", () => {
    it("recovers directly-transferred SOL into available", async () => {
      const vaultBefore = await program.account.vault.fetch(vaultPda);
      const availBefore = vaultBefore.availableLamports.toNumber();

      // Send SOL directly to vault PDA (not through seed_vault)
      const transferIx = SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: vaultPda,
        lamports: 500_000_000, // 0.5 SOL
      });
      const tx = new anchor.web3.Transaction().add(transferIx);
      await provider.sendAndConfirm!(tx);

      // available_lamports should NOT have changed
      const vaultMid = await program.account.vault.fetch(vaultPda);
      expect(vaultMid.availableLamports.toNumber()).to.equal(availBefore);

      // Call sync_vault
      await program.methods
        .syncVault()
        .accounts({
          authority: authority.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
        } as any)
        .rpc();

      // Now available should have increased by 0.5 SOL
      const vaultAfter = await program.account.vault.fetch(vaultPda);
      expect(vaultAfter.availableLamports.toNumber()).to.equal(availBefore + 500_000_000);
    });

    it("no-op when no surplus exists", async () => {
      // Warp 1s to get a fresh blockhash (prevents duplicate tx detection)
      await warpTime(context, 1);
      const vaultBefore = await program.account.vault.fetch(vaultPda);

      await program.methods
        .syncVault()
        .accounts({
          authority: authority.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
        } as any)
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vaultPda);
      expect(vaultAfter.availableLamports.toNumber()).to.equal(
        vaultBefore.availableLamports.toNumber()
      );
    });

    it("fails for non-authority", async () => {
      try {
        await program.methods
          .syncVault()
          .accounts({
            authority: randomUser.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
          } as any)
          .signers([randomUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });
  });


  describe("buy_call - TradingWindowClosed", () => {
    it("rejects buy after trading window expires", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      await program.methods
        .startCohort()
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          emaState: emaStatePda,
          cohort: cohortPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([keeper])
        .rpc();

      // Warp past trading window only (but before measurement ends)
      await warpTime(context, FAST_TRADING_WINDOW + 1);

      const strikeBps = 12_000;
      const [posPda] = findPositionPda(
        program.programId, cohortPda, buyer.publicKey, strikeBps, 0
      );

      try {
        await program.methods
          .buyCall(strikeBps, SOL(0.05), 0)
          .accounts({
            buyer: buyer.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            cohort: cohortPda,
            emaState: emaStatePda,
            position: posPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TradingWindowClosed");
      }

      // Clean up: void after recovery
      const remainingWait = FAST_MEASUREMENT + FAST_OBSERVATION
        + FAST_SETTLEMENT_DEADLINE + FAST_SETTLEMENT_DEADLINE + 3;
      await warpTime(context, remainingWait);
      await program.methods
        .voidCohort()
        .accounts({
          authority: authority.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
        } as any)
        .rpc();
    });
  });


  describe("buy_call - ProtocolPaused", () => {
    it("rejects buy when protocol is paused", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      // Start cohort before pausing (start_cohort also checks paused)
      await program.methods
        .startCohort()
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          emaState: emaStatePda,
          cohort: cohortPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([keeper])
        .rpc();

      // Pause
      await program.methods
        .updateConfig({
          keeper: null, mhiCapBps: null, premiumFeeBps: null,
          referralShareBps: null, keeperFeeLamports: null, minPositionLamports: null,
          maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
          tradingWindowSeconds: null, measurementSeconds: null,
          observationSeconds: null, settlementDeadlineSeconds: null,
          claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null,
          minPremiumLamports: null, maxPositionCollateralBps: null, paused: true,
         
        })
        .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
        .rpc();

      const strikeBps = 12_000;
      const [posPda] = findPositionPda(
        program.programId, cohortPda, buyer.publicKey, strikeBps, 0
      );

      try {
        await program.methods
          .buyCall(strikeBps, SOL(0.05), 0)
          .accounts({
            buyer: buyer.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            cohort: cohortPda,
            emaState: emaStatePda,
            position: posPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ProtocolPaused");
      }

      // Unpause and clean up
      await program.methods
        .updateConfig({
          keeper: null, mhiCapBps: null, premiumFeeBps: null,
          referralShareBps: null, keeperFeeLamports: null, minPositionLamports: null,
          maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
          tradingWindowSeconds: null, measurementSeconds: null,
          observationSeconds: null, settlementDeadlineSeconds: null,
          claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null,
          minPremiumLamports: null, maxPositionCollateralBps: null, paused: false,
         
        })
        .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
        .rpc();

      const recoveryWait = FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION
        + FAST_SETTLEMENT_DEADLINE + FAST_SETTLEMENT_DEADLINE + 3;
      await warpTime(context, recoveryWait);
      await program.methods
        .voidCohort()
        .accounts({
          authority: authority.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
        } as any)
        .rpc();
    });
  });


  describe("submit_mhi - value bounds", () => {
    let cohortPda: anchor.web3.PublicKey;

    before(async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      [cohortPda] = findCohortPda(program.programId, cohortIndex);

      await program.methods
        .startCohort()
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          emaState: emaStatePda,
          cohort: cohortPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([keeper])
        .rpc();

      await warpTime(context, FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION + 2);
    });

    it("rejects mhi_bps = 0", async () => {
      try {
        await program.methods
          .submitMhi(0, 20, Array.from({ length: 32 }, () => 0))
          .accounts({
            keeper: keeper.publicKey,
            globalState: globalStatePda,
            cohort: cohortPda,
            emaState: emaStatePda,
            vault: vaultPda,
          } as any)
          .signers([keeper])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MhiZero");
      }
    });

    it("rejects mhi_bps > cap", async () => {
      try {
        await program.methods
          .submitMhi(30_001, 20, Array.from({ length: 32 }, () => 0))
          .accounts({
            keeper: keeper.publicKey,
            globalState: globalStatePda,
            cohort: cohortPda,
            emaState: emaStatePda,
            vault: vaultPda,
          } as any)
          .signers([keeper])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MhiExceedsCap");
      }
    });

    after(async () => {
      // Clean up: submit valid MHI and settle empty cohort
      await program.methods
        .submitMhi(12_000, 20, Array.from({ length: 32 }, () => 0))
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          cohort: cohortPda,
          emaState: emaStatePda,
          vault: vaultPda,
        } as any)
        .signers([keeper])
        .rpc();
      await program.methods
        .settleBatch()
        .accounts({
          caller: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
        } as any)
        .signers([keeper])
        .rpc();
    });
  });


  describe("settle_batch - SettlementDeadlineNotReached", () => {
    it("non-keeper cannot settle before deadline", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      await program.methods
        .startCohort()
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          emaState: emaStatePda,
          cohort: cohortPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([keeper])
        .rpc();

      // Buy a position
      const strikeBps = 12_000;
      const [posPda] = findPositionPda(
        program.programId, cohortPda, buyer.publicKey, strikeBps, 0
      );
      await program.methods
        .buyCall(strikeBps, SOL(0.05), 0)
        .accounts({
          buyer: buyer.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
          emaState: emaStatePda,
          position: posPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([buyer])
        .rpc();

      // Warp past trading+measurement+observation (MHI submittable) but NOT past settlement deadline
      await warpTime(context, FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION + 2);

      await program.methods
        .submitMhi(14_000, 20, Array.from({ length: 32 }, () => 0))
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          cohort: cohortPda,
          emaState: emaStatePda,
          vault: vaultPda,
        } as any)
        .signers([keeper])
        .rpc();

      // Non-keeper tries to settle BEFORE deadline - should fail
      try {
        await program.methods
          .settleBatch()
          .accounts({
            caller: randomUser.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            cohort: cohortPda,
          } as any)
          .remainingAccounts([{ pubkey: posPda, isWritable: true, isSigner: false }])
          .signers([randomUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("SettlementDeadlineNotReached");
      }

      // Keeper CAN settle before deadline
      await program.methods
        .settleBatch()
        .accounts({
          caller: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
        } as any)
        .remainingAccounts([{ pubkey: posPda, isWritable: true, isSigner: false }])
        .signers([keeper])
        .rpc();

      // Clean up: claim
      await program.methods
        .claim()
        .accounts({
          caller: buyer.publicKey,
          owner: buyer.publicKey,
          vault: vaultPda,
          cohort: cohortPda,
          position: posPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([buyer])
        .rpc();
    });
  });


  describe("buy_call - InsufficientVaultCollateral", () => {
    it("rejects buy when vault has insufficient collateral", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      await program.methods
        .startCohort()
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          emaState: emaStatePda,
          cohort: cohortPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([keeper])
        .rpc();

      // Read vault to determine how much collateral is available
      const vault = await program.account.vault.fetch(vaultPda);
      const available = vault.availableLamports.toNumber();

      // At strike 10_000 (1.0x), collateral = size * (30000-10000)/10000 = size * 2.0
      // To exceed vault, size must be > available / 1.5
      // Use a size that's definitely too large
      const excessiveSize = new anchor.BN(available).add(new anchor.BN(1_000_000_000));

      const strikeBps = 10_000;
      const [posPda] = findPositionPda(
        program.programId, cohortPda, buyer.publicKey, strikeBps, 0
      );

      try {
        await program.methods
          .buyCall(strikeBps, excessiveSize, 0)
          .accounts({
            buyer: buyer.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            cohort: cohortPda,
            emaState: emaStatePda,
            position: posPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InsufficientVaultCollateral");
      }

      // Clean up: void the cohort
      const wait = FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION
        + FAST_SETTLEMENT_DEADLINE + FAST_SETTLEMENT_DEADLINE + 3;
      await warpTime(context, wait);
      await program.methods
        .voidCohort()
        .accounts({
          authority: authority.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
        } as any)
        .rpc();
    });
  });
});
