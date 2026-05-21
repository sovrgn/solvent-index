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
import { getBankrunContext, warpTime, createFundedKeypair, getAccountOrNull, getBalance } from "../helpers/context";
import {
  FAST_TRADING_WINDOW,
  FAST_MEASUREMENT,
  FAST_OBSERVATION,
  FAST_SETTLEMENT_DEADLINE,
  FAST_CLAIM_EXPIRY,
  SOL,
  deriveStrikes,
} from "../helpers/constants";
import { ProgramTestContext } from "solana-bankrun";

/**
 * Tests for void_cohort and close_cohort.
 * Relies on protocol already initialized from 01_full_cycle.test.ts.
 */
describe.skip("mhi protocol - void & close", () => {
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

  async function assertVaultConservation() {
    const vault = await program.account.vault.fetch(vaultPda);
    const vaultAccount = await provider.connection.getAccountInfo(vaultPda);
    const rent = await provider.connection.getMinimumBalanceForRentExemption(vaultAccount!.data.length);
    const tracked =
      vault.availableLamports.toNumber() +
      vault.activeCollateralLamports.toNumber() +
      vault.unclaimedPayoutsLamports.toNumber();
    const actual = vaultAccount!.lamports - rent;
    expect(tracked).to.equal(actual, "Vault conservation violated");
  }

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

    // Set our keeper
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
       
      })
      .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
      .rpc();
  });


  describe("void_cohort", () => {
    it("voids cohort after recovery deadline - refunds buyer", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      // Start cohort
      await program.methods
        .startCohort(deriveStrikes((await program.account.globalState.fetch(globalStatePda) as any).strikeAnchorBps))
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
        .buyCall(strikeBps, SOL(0.1), 0)
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

      const positionBefore = await program.account.position.fetch(posPda);
      const vaultPremium = positionBefore.vaultPremiumLamports.toNumber();

      // Warp past recovery deadline
      // recovery = trading + measurement + observation + settlement_deadline + settlement_deadline
      const recoveryWait = FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION
        + FAST_SETTLEMENT_DEADLINE + FAST_SETTLEMENT_DEADLINE + 3;
      await warpTime(context, recoveryWait);

      const vaultBefore = await program.account.vault.fetch(vaultPda);

      // Void the cohort
      await program.methods
        .voidCohort()
        .accounts({
          authority: authority.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
        } as any)
        .remainingAccounts([
          { pubkey: posPda, isWritable: true, isSigner: false },
        ])
        .rpc();

      // Cohort should be voided
      const cohort = await program.account.cohort.fetch(cohortPda);
      // Check status field (Voided = 4)
      expect(JSON.stringify(cohort.status)).to.include("voided");

      // Position should be marked settled with refund = vault_premium
      const positionAfter = await program.account.position.fetch(posPda);
      expect(positionAfter.settled).to.equal(true);
      expect(positionAfter.payoutLamports.toNumber()).to.equal(vaultPremium);

      // Now claim the refund
      const buyerBalBefore = await getBalance(context.banksClient, buyer.publicKey);

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

      const buyerBalAfter = await getBalance(context.banksClient, buyer.publicKey);
      // Buyer should have received the vault premium back
      expect(buyerBalAfter).to.be.greaterThan(buyerBalBefore);

      await assertVaultConservation();
    });

    it("fails before recovery deadline", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      await program.methods
        .startCohort(deriveStrikes((await program.account.globalState.fetch(globalStatePda) as any).strikeAnchorBps))
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

      // Try to void immediately
      try {
        await program.methods
          .voidCohort()
          .accounts({
            authority: authority.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            cohort: cohortPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("RecoveryDeadlineNotReached");
      }

      // Clean up: warp and void properly
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

    it("fails if MHI already submitted", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      await program.methods
        .startCohort(deriveStrikes((await program.account.globalState.fetch(globalStatePda) as any).strikeAnchorBps))
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

      // Warp and submit MHI
      await warpTime(context, FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION + 2);

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

      // Warp past recovery
      await warpTime(context, FAST_SETTLEMENT_DEADLINE + FAST_SETTLEMENT_DEADLINE + 3);

      // Try to void - should fail because MHI is submitted
      try {
        await program.methods
          .voidCohort()
          .accounts({
            authority: authority.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            cohort: cohortPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MhiAlreadySubmitted");
      }

      // Clean up: settle empty batch (0 positions)
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

    it("fails for non-authority", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      await program.methods
        .startCohort(deriveStrikes((await program.account.globalState.fetch(globalStatePda) as any).strikeAnchorBps))
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

      await warpTime(context, FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION
        + FAST_SETTLEMENT_DEADLINE + FAST_SETTLEMENT_DEADLINE + 3);

      try {
        await program.methods
          .voidCohort()
          .accounts({
            authority: randomUser.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            cohort: cohortPda,
          } as any)
          .signers([randomUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }

      // Clean up
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


  describe("close_cohort", () => {
    it("closes a settled cohort after claim expiry", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      // Start and run an empty cohort to Settled
      await program.methods
        .startCohort(deriveStrikes((await program.account.globalState.fetch(globalStatePda) as any).strikeAnchorBps))
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

      // Warp past settlement_deadline + claim_expiry
      await warpTime(context, FAST_SETTLEMENT_DEADLINE + FAST_CLAIM_EXPIRY + 3);

      const callerBalBefore = await getBalance(context.banksClient, randomUser.publicKey);

      await program.methods
        .closeCohort()
        .accounts({
          caller: randomUser.publicKey,
          globalState: globalStatePda,
          cohort: cohortPda,
        } as any)
        .signers([randomUser])
        .rpc();

      // Cohort PDA should no longer exist
      const cohortAccount = await getAccountOrNull(context.banksClient, cohortPda);
      expect(cohortAccount).to.be.null;

      // Caller received rent refund
      const callerBalAfter = await getBalance(context.banksClient, randomUser.publicKey);
      expect(callerBalAfter).to.be.greaterThan(callerBalBefore);
    });

    it("fails before claim expiry passes", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      await program.methods
        .startCohort(deriveStrikes((await program.account.globalState.fetch(globalStatePda) as any).strikeAnchorBps))
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

      // Try to close immediately - should fail
      try {
        await program.methods
          .closeCohort()
          .accounts({
            caller: randomUser.publicKey,
            globalState: globalStatePda,
            cohort: cohortPda,
          } as any)
          .signers([randomUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ClaimNotExpired");
      }
    });

    it("fails on active cohort (not resolved)", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(program.programId, cohortIndex);

      await program.methods
        .startCohort(deriveStrikes((await program.account.globalState.fetch(globalStatePda) as any).strikeAnchorBps))
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

      try {
        await (program.methods
          .closeCohort()
          .accounts({
            caller: randomUser.publicKey,
            globalState: globalStatePda,
            cohort: cohortPda,
          } as any)
          .signers([randomUser])
          .rpc());
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidCohortStatus");
      }

      // Clean up: void it after recovery deadline
      const recoveryWait = FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION
        + FAST_SETTLEMENT_DEADLINE + FAST_SETTLEMENT_DEADLINE + 3;
      await warpTime(context, recoveryWait);
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
});
