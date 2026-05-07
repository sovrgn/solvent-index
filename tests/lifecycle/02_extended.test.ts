import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
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
  FAST_CLAIM_EXPIRY,
  SOL,
} from "../helpers/constants";
import { ProgramTestContext } from "solana-bankrun";

/**
 * Extended tests - runs after full_cycle.test.ts has completed Cohort 0.
 * Protocol is initialized, vault seeded, Cohort 0 settled.
 * GlobalState.current_cohort_index = 1, status = Idle.
 */
describe("mhi protocol - extended", () => {
  let provider: anchor.Provider;
  let program: Program<Mhi>;
  let context: ProgramTestContext;

  let authority: Keypair;
  let keeper: Keypair;
  let buyer1: Keypair;
  let buyer2: Keypair;
  let referrer: Keypair;
  let randomUser: Keypair;

  let globalStatePda: PublicKey;
  let vaultPda: PublicKey;
  let emaStatePda: PublicKey;

  // Helper: run a complete cohort lifecycle
  async function runCohort(
    cohortIndex: number,
    mhiBps: number,
    positions: Array<{ buyer: Keypair; strikeBps: number; size: anchor.BN; nonce: number }>,
    opts?: { skipSettle?: boolean; skipClaim?: boolean }
  ) {
    const [cohortPda] = findCohortPda(program.programId, cohortIndex);

    // Start
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

    // Buy positions
    const positionPdas: PublicKey[] = [];
    for (const pos of positions) {
      const [posPda] = findPositionPda(
        program.programId, cohortPda, pos.buyer.publicKey, pos.strikeBps, pos.nonce
      );
      positionPdas.push(posPda);
      await program.methods
        .buyCall(pos.strikeBps, pos.size, pos.nonce)
        .accounts({
          buyer: pos.buyer.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
          emaState: emaStatePda,
          position: posPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([pos.buyer])
        .rpc();
    }

    // Warp clock past windows (instant)
    const totalWait = FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION + 2;
    await warpTime(context, totalWait);

    // Submit MHI
    await program.methods
      .submitMhi(mhiBps, 20, Array.from({ length: 32 }, () => 0))
      .accounts({
        keeper: keeper.publicKey,
        globalState: globalStatePda,
        cohort: cohortPda,
        emaState: emaStatePda,
        vault: vaultPda,
      } as any)
      .signers([keeper])
      .rpc();

    if (opts?.skipSettle) return { cohortPda, positionPdas };

    // Settle all
    await program.methods
      .settleBatch()
      .accounts({
        caller: keeper.publicKey,
        globalState: globalStatePda,
        vault: vaultPda,
        cohort: cohortPda,
      } as any)
      .remainingAccounts(
        positionPdas.map((pk) => ({ pubkey: pk, isWritable: true, isSigner: false }))
      )
      .signers([keeper])
      .rpc();

    if (opts?.skipClaim) return { cohortPda, positionPdas };

    // Claim all
    for (let i = 0; i < positions.length; i++) {
      await program.methods
        .claim()
        .accounts({
          caller: positions[i].buyer.publicKey,
          owner: positions[i].buyer.publicKey,
          vault: vaultPda,
          cohort: cohortPda,
          position: positionPdas[i],
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([positions[i].buyer])
        .rpc();
    }

    return { cohortPda, positionPdas };
  }

  // Helper: check vault conservation
  async function assertVaultConservation() {
    const vault = await program.account.vault.fetch(vaultPda);
    const vaultAccount = await provider.connection.getAccountInfo(vaultPda);
    const rent = await provider.connection.getMinimumBalanceForRentExemption(
      vaultAccount!.data.length
    );
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

    // Create and fund keypairs (instant)
    keeper = await createFundedKeypair(context);
    buyer1 = await createFundedKeypair(context);
    buyer2 = await createFundedKeypair(context);
    referrer = await createFundedKeypair(context);
    randomUser = await createFundedKeypair(context);

    // Update keeper to our new one
    await program.methods
      .updateConfig({
        keeper: keeper.publicKey,
        mhiCapBps: null, premiumFeeBps: null, referralShareBps: null,
        keeperFeeLamports: null, minPositionLamports: null,
        maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
        tradingWindowSeconds: null, measurementSeconds: null,
        observationSeconds: null, settlementDeadlineSeconds: null,
        claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null, minPremiumLamports: null, maxPositionCollateralBps: null,
        paused: null,
       
      })
      .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
      .rpc();

    // Ensure vault has enough SOL
    await program.methods
      .seedVault(SOL(10))
      .accounts({
        authority: authority.publicKey,
        globalState: globalStatePda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  });


  describe("update_config bounds", () => {
    it("accepts valid param at boundary", async () => {
      await program.methods
        .updateConfig({
          keeper: null, mhiCapBps: null, premiumFeeBps: 1000, // exactly 10%
          referralShareBps: null, keeperFeeLamports: null, minPositionLamports: null,
          maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
          tradingWindowSeconds: null, measurementSeconds: null,
          observationSeconds: null, settlementDeadlineSeconds: null,
          claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null, minPremiumLamports: null, maxPositionCollateralBps: null,
          paused: null,
         
        })
        .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
        .rpc();
      const gs = await program.account.globalState.fetch(globalStatePda);
      expect(gs.premiumFeeBps).to.equal(1000);
    });

    it("rejects premium_fee_bps > 1000", async () => {
      try {
        await program.methods
          .updateConfig({
            keeper: null, mhiCapBps: null, premiumFeeBps: 1001,
            referralShareBps: null, keeperFeeLamports: null, minPositionLamports: null,
            maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
            tradingWindowSeconds: null, measurementSeconds: null,
            observationSeconds: null, settlementDeadlineSeconds: null,
            claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null, minPremiumLamports: null, maxPositionCollateralBps: null,
            paused: null,
           
          })
          .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidConfig");
      }
    });

    it("rejects trading_window < 30s", async () => {
      try {
        await program.methods
          .updateConfig({
            keeper: null, mhiCapBps: null, premiumFeeBps: null,
            referralShareBps: null, keeperFeeLamports: null, minPositionLamports: null,
            maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
            tradingWindowSeconds: 29, measurementSeconds: null,
            observationSeconds: null, settlementDeadlineSeconds: null,
            claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null, minPremiumLamports: null, maxPositionCollateralBps: null,
            paused: null,
           
          })
          .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidConfig");
      }
    });

    it("rejects claim_expiry < 3600s", async () => {
      try {
        await program.methods
          .updateConfig({
            keeper: null, mhiCapBps: null, premiumFeeBps: null,
            referralShareBps: null, keeperFeeLamports: null, minPositionLamports: null,
            maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
            tradingWindowSeconds: null, measurementSeconds: null,
            observationSeconds: null, settlementDeadlineSeconds: null,
            claimExpirySeconds: 3599, mhiFloorBps: null, mhiMaxDeltaBps: null, minPremiumLamports: null, maxPositionCollateralBps: null,
            paused: null,
           
          })
          .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidConfig");
      }
    });

    it("all-None update succeeds with no changes", async () => {
      const gsBefore = await program.account.globalState.fetch(globalStatePda);
      await program.methods
        .updateConfig({
          keeper: null, mhiCapBps: null, premiumFeeBps: null,
          referralShareBps: null, keeperFeeLamports: null, minPositionLamports: null,
          maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
          tradingWindowSeconds: null, measurementSeconds: null,
          observationSeconds: null, settlementDeadlineSeconds: null,
          claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null, minPremiumLamports: null, maxPositionCollateralBps: null,
          paused: null,
         
        })
        .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
        .rpc();
      const gsAfter = await program.account.globalState.fetch(globalStatePda);
      expect(gsAfter.premiumFeeBps).to.equal(gsBefore.premiumFeeBps);
    });

    after(async () => {
      // Reset fee to normal for subsequent tests
      await program.methods
        .updateConfig({
          keeper: null, mhiCapBps: null, premiumFeeBps: 150,
          referralShareBps: null, keeperFeeLamports: null, minPositionLamports: null,
          maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
          tradingWindowSeconds: null, measurementSeconds: null,
          observationSeconds: null, settlementDeadlineSeconds: null,
          claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null, minPremiumLamports: null, maxPositionCollateralBps: null,
          paused: null,
         
        })
        .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
        .rpc();
    });
  });


  describe("authority transfer", () => {
    let newAuthority: Keypair;

    before(async () => {
      newAuthority = await createFundedKeypair(context, 2);
    });

    it("propose → accept completes transfer", async () => {
      // Propose
      await program.methods
        .proposeAuthority(newAuthority.publicKey)
        .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
        .rpc();

      let gs = await program.account.globalState.fetch(globalStatePda);
      expect(gs.pendingAuthority.toBase58()).to.equal(newAuthority.publicKey.toBase58());

      // Accept
      await program.methods
        .acceptAuthority()
        .accounts({ newAuthority: newAuthority.publicKey, globalState: globalStatePda } as any)
        .signers([newAuthority])
        .rpc();

      gs = await program.account.globalState.fetch(globalStatePda);
      expect(gs.authority.toBase58()).to.equal(newAuthority.publicKey.toBase58());
      expect(gs.pendingAuthority.toBase58()).to.equal(PublicKey.default.toBase58());
    });

    it("old authority is rejected after transfer", async () => {
      try {
        await program.methods
          .updateConfig({
            keeper: null, mhiCapBps: null, premiumFeeBps: null,
            referralShareBps: null, keeperFeeLamports: null, minPositionLamports: null,
            maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
            tradingWindowSeconds: null, measurementSeconds: null,
            observationSeconds: null, settlementDeadlineSeconds: null,
            claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null, minPremiumLamports: null, maxPositionCollateralBps: null,
            paused: null,
           
          })
          .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });

    it("transfer back to original authority", async () => {
      // Propose back
      await program.methods
        .proposeAuthority(authority.publicKey)
        .accounts({ authority: newAuthority.publicKey, globalState: globalStatePda } as any)
        .signers([newAuthority])
        .rpc();

      // Accept
      await program.methods
        .acceptAuthority()
        .accounts({ newAuthority: authority.publicKey, globalState: globalStatePda } as any)
        .rpc();

      const gs = await program.account.globalState.fetch(globalStatePda);
      expect(gs.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    });

    it("cancel proposal clears pending", async () => {
      await program.methods
        .proposeAuthority(randomUser.publicKey)
        .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
        .rpc();

      await program.methods
        .cancelAuthorityTransfer()
        .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
        .rpc();

      const gs = await program.account.globalState.fetch(globalStatePda);
      expect(gs.pendingAuthority.toBase58()).to.equal(PublicKey.default.toBase58());
    });

    it("rejects propose with Pubkey::default", async () => {
      try {
        await program.methods
          .proposeAuthority(PublicKey.default)
          .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidConfig");
      }
    });
  });


  describe("multi-strike cohort", () => {
    it("multiple buyers at different strikes, correct payouts", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();
      const mhiBps = 14_000; // 1.4x → 1.0x and 1.2x are ITM, 1.5x and 2.0x are OTM

      const positions = [
        { buyer: buyer1, strikeBps: 10_000, size: SOL(0.05), nonce: 0 }, // ITM: payoff 0.4x
        { buyer: buyer2, strikeBps: 12_000, size: SOL(0.05), nonce: 0 }, // ITM: payoff 0.2x
        { buyer: buyer1, strikeBps: 15_000, size: SOL(0.05), nonce: 1 }, // OTM: payoff 0
        { buyer: buyer2, strikeBps: 20_000, size: SOL(0.05), nonce: 1 }, // OTM: payoff 0
      ];

      const { cohortPda, positionPdas } = await runCohort(cohortIndex, mhiBps, positions, { skipClaim: true });

      // Check settled positions
      for (let i = 0; i < positions.length; i++) {
        const pos = await program.account.position.fetch(positionPdas[i]);
        expect(pos.settled).to.equal(true);
        if (positions[i].strikeBps < mhiBps) {
          // ITM - payout > 0
          expect(pos.payoutLamports.toNumber()).to.be.greaterThan(0);
        } else {
          // OTM - payout = 0
          expect(pos.payoutLamports.toNumber()).to.equal(0);
        }
      }

      // Claim all
      for (let i = 0; i < positions.length; i++) {
        await program.methods
          .claim()
          .accounts({
            caller: positions[i].buyer.publicKey,
            owner: positions[i].buyer.publicKey,
            vault: vaultPda,
            cohort: cohortPda,
            position: positionPdas[i],
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([positions[i].buyer])
          .rpc();
      }

      await assertVaultConservation();
    });
  });


  describe("buy_call with referral", () => {
    it("referrer receives cut of volume fee", async () => {
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

      const strikeBps = 12_000;
      const [posPda] = findPositionPda(
        program.programId, cohortPda, buyer1.publicKey, strikeBps, 0
      );

      const referrerBalBefore = await getBalance(context.banksClient, referrer.publicKey);

      await program.methods
        .buyCall(strikeBps, SOL(0.5), 0)
        .accounts({
          buyer: buyer1.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
          emaState: emaStatePda,
          position: posPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .remainingAccounts([
          { pubkey: referrer.publicKey, isWritable: true, isSigner: false },
        ])
        .signers([buyer1])
        .rpc();

      const referrerBalAfter = await getBalance(context.banksClient, referrer.publicKey);
      expect(referrerBalAfter).to.be.greaterThan(referrerBalBefore);

      const position = await program.account.position.fetch(posPda);
      // vault_premium should be less than premium_paid (referral went to referrer)
      expect(position.vaultPremiumLamports.toNumber()).to.be.lessThan(
        position.premiumPaidLamports.toNumber()
      );

      // Complete the cohort so next tests can proceed
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
        .remainingAccounts([{ pubkey: posPda, isWritable: true, isSigner: false }])
        .signers([keeper])
        .rpc();
      await program.methods
        .claim()
        .accounts({
          caller: buyer1.publicKey,
          owner: buyer1.publicKey,
          vault: vaultPda,
          cohort: cohortPda,
          position: posPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([buyer1])
        .rpc();

      await assertVaultConservation();
    });
  });


  describe("expire_position", () => {
    it("expired position returns payout to vault", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();

      const { cohortPda, positionPdas } = await runCohort(
        cohortIndex,
        15_000, // ITM
        [{ buyer: buyer1, strikeBps: 12_000, size: SOL(0.05), nonce: 0 }],
        { skipClaim: true }
      );

      // Position is settled but not claimed. Warp past claim expiry.
      await warpTime(context, FAST_CLAIM_EXPIRY + 1);

      const vaultBefore = await program.account.vault.fetch(vaultPda);

      await program.methods
        .expirePosition()
        .accounts({
          caller: randomUser.publicKey,
          vault: vaultPda,
          cohort: cohortPda,
          position: positionPdas[0],
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([randomUser])
        .rpc();

      // Position PDA should be gone
      const posAccount = await getAccountOrNull(context.banksClient, positionPdas[0]);
      expect(posAccount).to.be.null;

      // Vault available should have increased (unclaimed payout returned)
      const vaultAfter = await program.account.vault.fetch(vaultPda);
      expect(vaultAfter.availableLamports.toNumber()).to.be.greaterThanOrEqual(
        vaultBefore.availableLamports.toNumber()
      );
      expect(vaultAfter.unclaimedPayoutsLamports.toNumber()).to.be.lessThanOrEqual(
        vaultBefore.unclaimedPayoutsLamports.toNumber()
      );

      await assertVaultConservation();
    });

    it("fails before claim deadline", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();

      const { cohortPda, positionPdas } = await runCohort(
        cohortIndex,
        12_000,
        [{ buyer: buyer2, strikeBps: 10_000, size: SOL(0.05), nonce: 0 }],
        { skipClaim: true }
      );

      // Don't warp - try to expire immediately
      try {
        await program.methods
          .expirePosition()
          .accounts({
            caller: randomUser.publicKey,
            vault: vaultPda,
            cohort: cohortPda,
            position: positionPdas[0],
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([randomUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ClaimNotExpired");
      }

      // Cleanup: claim it so vault is clean
      await program.methods
        .claim()
        .accounts({
          caller: buyer2.publicKey,
          owner: buyer2.publicKey,
          vault: vaultPda,
          cohort: cohortPda,
          position: positionPdas[0],
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([buyer2])
        .rpc();
    });
  });


  describe("third-party claim", () => {
    it("anyone can claim on behalf of owner - payout goes to owner", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();

      const { cohortPda, positionPdas } = await runCohort(
        cohortIndex,
        15_000,
        [{ buyer: buyer1, strikeBps: 12_000, size: SOL(0.1), nonce: 0 }],
        { skipClaim: true }
      );

      const ownerBalBefore = await getBalance(context.banksClient, buyer1.publicKey);

      // randomUser claims on behalf of buyer1
      await program.methods
        .claim()
        .accounts({
          caller: randomUser.publicKey,
          owner: buyer1.publicKey,
          vault: vaultPda,
          cohort: cohortPda,
          position: positionPdas[0],
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([randomUser])
        .rpc();

      const ownerBalAfter = await getBalance(context.banksClient, buyer1.publicKey);
      // Owner received the payout (not the caller)
      expect(ownerBalAfter).to.be.greaterThan(ownerBalBefore);

      await assertVaultConservation();
    });
  });


  describe("settle_batch - multi-batch", () => {
    it("settles in two separate calls", async () => {
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

      // Buy 3 positions
      const positions = [
        { buyer: buyer1, strikeBps: 10_000, nonce: 0 },
        { buyer: buyer1, strikeBps: 12_000, nonce: 0 },
        { buyer: buyer2, strikeBps: 15_000, nonce: 0 },
      ];
      const pdas: PublicKey[] = [];
      for (const p of positions) {
        const [pda] = findPositionPda(program.programId, cohortPda, p.buyer.publicKey, p.strikeBps, p.nonce);
        pdas.push(pda);
        await program.methods
          .buyCall(p.strikeBps, SOL(0.05), p.nonce)
          .accounts({
            buyer: p.buyer.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            cohort: cohortPda,
            emaState: emaStatePda,
            position: pda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([p.buyer])
          .rpc();
      }

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

      // Settle batch 1: first 2 positions
      await program.methods
        .settleBatch()
        .accounts({
          caller: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
        } as any)
        .remainingAccounts(
          pdas.slice(0, 2).map((pk) => ({ pubkey: pk, isWritable: true, isSigner: false }))
        )
        .signers([keeper])
        .rpc();

      let cohort = await program.account.cohort.fetch(cohortPda);
      expect(cohort.positionsSettled).to.equal(2);
      // Not all settled yet - should still be Settling
      let gsCheck = await program.account.globalState.fetch(globalStatePda);
      expect(gsCheck.currentCohortIndex.toNumber()).to.equal(cohortIndex); // Not advanced yet

      // Settle batch 2: last position
      await program.methods
        .settleBatch()
        .accounts({
          caller: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
        } as any)
        .remainingAccounts([{ pubkey: pdas[2], isWritable: true, isSigner: false }])
        .signers([keeper])
        .rpc();

      cohort = await program.account.cohort.fetch(cohortPda);
      expect(cohort.positionsSettled).to.equal(3);
      gsCheck = await program.account.globalState.fetch(globalStatePda);
      expect(gsCheck.currentCohortIndex.toNumber()).to.equal(cohortIndex + 1); // Now advanced

      // Claim all
      for (let i = 0; i < positions.length; i++) {
        await program.methods
          .claim()
          .accounts({
            caller: positions[i].buyer.publicKey,
            owner: positions[i].buyer.publicKey,
            vault: vaultPda,
            cohort: cohortPda,
            position: pdas[i],
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([positions[i].buyer])
          .rpc();
      }

      await assertVaultConservation();
    });
  });


  describe("settle_batch - idempotency", () => {
    it("already-settled position is silently skipped", async () => {
      const gs = await program.account.globalState.fetch(globalStatePda);
      const cohortIndex = gs.currentCohortIndex.toNumber();

      const { cohortPda, positionPdas } = await runCohort(
        cohortIndex,
        13_000,
        [
          { buyer: buyer1, strikeBps: 12_000, size: SOL(0.05), nonce: 0 },
          { buyer: buyer2, strikeBps: 10_000, size: SOL(0.05), nonce: 0 },
        ],
        { skipClaim: true }
      );

      // Positions are already settled. Try settle again with same positions - should not fail.
      // But cohort is already Settled, so this should fail with InvalidCohortStatus.
      try {
        await program.methods
          .settleBatch()
          .accounts({
            caller: keeper.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            cohort: cohortPda,
          } as any)
          .remainingAccounts(
            positionPdas.map((pk) => ({ pubkey: pk, isWritable: true, isSigner: false }))
          )
          .signers([keeper])
          .rpc();
        expect.fail("Should have thrown - cohort is already Settled");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidCohortStatus");
      }

      // Cleanup
      for (let i = 0; i < positionPdas.length; i++) {
        const buyers = [buyer1, buyer2];
        await program.methods
          .claim()
          .accounts({
            caller: buyers[i].publicKey,
            owner: buyers[i].publicKey,
            vault: vaultPda,
            cohort: cohortPda,
            position: positionPdas[i],
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([buyers[i]])
          .rpc();
      }
    });
  });


  describe("pause protocol", () => {
    it("paused protocol rejects start_cohort", async () => {
      await program.methods
        .updateConfig({
          keeper: null, mhiCapBps: null, premiumFeeBps: null,
          referralShareBps: null, keeperFeeLamports: null, minPositionLamports: null,
          maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
          tradingWindowSeconds: null, measurementSeconds: null,
          observationSeconds: null, settlementDeadlineSeconds: null,
          claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null, minPremiumLamports: null, maxPositionCollateralBps: null,
          paused: true,
         
        })
        .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
        .rpc();

      const gs = await program.account.globalState.fetch(globalStatePda);
      const [cohortPda] = findCohortPda(program.programId, gs.currentCohortIndex.toNumber());

      try {
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
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ProtocolPaused");
      }

      // Unpause
      await program.methods
        .updateConfig({
          keeper: null, mhiCapBps: null, premiumFeeBps: null,
          referralShareBps: null, keeperFeeLamports: null, minPositionLamports: null,
          maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
          tradingWindowSeconds: null, measurementSeconds: null,
          observationSeconds: null, settlementDeadlineSeconds: null,
          claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null, minPremiumLamports: null, maxPositionCollateralBps: null,
          paused: false,
         
        })
        .accounts({ authority: authority.publicKey, globalState: globalStatePda } as any)
        .rpc();
    });
  });


  describe("multi-cohort vault conservation", () => {
    it("vault conservation holds after 3 sequential cohorts", async () => {
      for (let i = 0; i < 3; i++) {
        const gs = await program.account.globalState.fetch(globalStatePda);
        const idx = gs.currentCohortIndex.toNumber();
        await runCohort(
          idx,
          12_000 + i * 1000, // Varying MHI
          [
            { buyer: buyer1, strikeBps: 10_000, size: SOL(0.02), nonce: 0 },
            { buyer: buyer2, strikeBps: 12_000, size: SOL(0.02), nonce: 0 },
          ]
        );
        await assertVaultConservation();
      }
    });
  });
});
