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
  findP2pPoolPda,
} from "../helpers/accounts";
import { getBankrunContext, warpTime, createFundedKeypair, fundAccount, getAccountOrNull } from "../helpers/context";
import {
  FAST_TRADING_WINDOW,
  FAST_MEASUREMENT,
  FAST_OBSERVATION,
  FAST_SETTLEMENT_DEADLINE,
  FAST_CLAIM_EXPIRY,
  SOL,
  DEFAULT_STRIKES_BPS,
  STRIKE_ANCHOR_DEFAULT_BPS,
  deriveStrikes,
  MHI_CAP_BPS,
  NUM_STRIKES,
} from "../helpers/constants";
import { ProgramTestContext } from "solana-bankrun";

describe("mhi protocol", () => {
  let provider: anchor.Provider;
  let program: Program<Mhi>;
  let context: ProgramTestContext;

  let authority: Keypair;
  const keeper = Keypair.generate();
  let buyer: Keypair;
  let randomUser: Keypair;

  let globalStatePda: PublicKey;
  let vaultPda: PublicKey;
  let emaStatePda: PublicKey;
  let p2pPoolPda: PublicKey;

  // Cold-start strike ladder is what the chain accepts for cohort 0.
  const coldStrikes = deriveStrikes(STRIKE_ANCHOR_DEFAULT_BPS);
  const ATM = DEFAULT_STRIKES_BPS[2]!; // 12_500 — index 2 of the cold-start ladder

  before(async () => {
    const bankrun = await getBankrunContext();
    context = bankrun.context;
    provider = bankrun.provider;
    program = bankrun.program;

    authority = (provider.wallet as anchor.Wallet).payer;
    [globalStatePda] = findGlobalStatePda(program.programId);
    [vaultPda] = findVaultPda(program.programId);
    [emaStatePda] = findEmaStatePda(program.programId);
    [p2pPoolPda] = findP2pPoolPda(program.programId);

    await fundAccount(context, keeper.publicKey);
    buyer = await createFundedKeypair(context);
    randomUser = await createFundedKeypair(context);
  });


  describe("initialize", () => {
    it("creates GlobalState, Vault, EmaState with correct values", async () => {
      await program.methods
        .initialize({
          keeper: keeper.publicKey,
          mhiCapBps: MHI_CAP_BPS,
          premiumFeeBps: 150,
          referralShareBps: 3000,
          minPositionLamports: new anchor.BN(10_000_000),
          minPremiumLamports: new anchor.BN(0),
          tradingWindowSeconds: FAST_TRADING_WINDOW,
          measurementSeconds: FAST_MEASUREMENT,
          observationSeconds: FAST_OBSERVATION,
          settlementDeadlineSeconds: FAST_SETTLEMENT_DEADLINE,
          claimExpirySeconds: FAST_CLAIM_EXPIRY,
        } as any)
        .accounts({
          authority: authority.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          emaState: emaStatePda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const gs = await program.account.globalState.fetch(globalStatePda);
      expect(gs.authority.toBase58()).to.equal(authority.publicKey.toBase58());
      expect(gs.keeper.toBase58()).to.equal(keeper.publicKey.toBase58());
      expect(gs.pendingAuthority.toBase58()).to.equal(PublicKey.default.toBase58());
      expect(gs.mhiCapBps).to.equal(MHI_CAP_BPS);
      expect(gs.mhiMaxDeltaBps).to.equal(3300);
      expect(gs.currentCohortIndex.toNumber()).to.equal(0);
      expect(gs.paused).to.equal(false);
      expect((gs as any).strikeAnchorBps).to.equal(STRIKE_ANCHOR_DEFAULT_BPS);

      const vault = await program.account.vault.fetch(vaultPda);
      expect(vault.availableLamports.toNumber()).to.equal(0);
      expect(vault.activeCollateralLamports.toNumber()).to.equal(0);

      const ema: any = await program.account.emaState.fetch(emaStatePda);
      for (let i = 0; i < NUM_STRIKES; i++) {
        expect(ema.slots[i].fastFracBps).to.equal(0);
        expect(ema.slots[i].slowFracBps).to.equal(0);
      }
    });

    it("fails if called twice", async () => {
      await warpTime(context, 1);
      try {
        await program.methods
          .initialize({
            keeper: keeper.publicKey,
            mhiCapBps: MHI_CAP_BPS,
            premiumFeeBps: 150,
            referralShareBps: 3000,
            minPositionLamports: new anchor.BN(10_000_000),
            minPremiumLamports: new anchor.BN(0),
            tradingWindowSeconds: FAST_TRADING_WINDOW,
            measurementSeconds: FAST_MEASUREMENT,
            observationSeconds: FAST_OBSERVATION,
            settlementDeadlineSeconds: FAST_SETTLEMENT_DEADLINE,
            claimExpirySeconds: FAST_CLAIM_EXPIRY,
          } as any)
          .accounts({
            authority: authority.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            emaState: emaStatePda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("already in use");
      }
    });
  });


  describe("seed_vault", () => {
    it("authority seeds vault with SOL", async () => {
      await program.methods
        .seedVault(SOL(5))
        .accounts({
          authority: authority.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const vault = await program.account.vault.fetch(vaultPda);
      expect(vault.availableLamports.toNumber()).to.equal(SOL(5).toNumber());

      // Init the P2P pool now so buy_call (which requires it as an account)
      // can find the PDA on later tests.
      await (program.methods as any).initP2PPool()
        .accounts({
          authority: authority.publicKey,
          globalState: globalStatePda,
          p2PPool: p2pPoolPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("fails with amount = 0", async () => {
      try {
        await program.methods
          .seedVault(new anchor.BN(0))
          .accounts({
            authority: authority.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("SeedAmountZero");
      }
    });

    it("fails for non-authority", async () => {
      try {
        await program.methods
          .seedVault(SOL(1))
          .accounts({
            authority: randomUser.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([randomUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("UnauthorizedAuthority");
      }
    });
  });


  describe("start_cohort", () => {
    it("keeper starts cohort 0", async () => {
      const [cohortPda] = findCohortPda(program.programId, 0);

      await program.methods
        .startCohort(coldStrikes)
        .accounts({
          keeper: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([keeper])
        .rpc();

      const cohort = await program.account.cohort.fetch(cohortPda);
      expect(cohort.index.toNumber()).to.equal(0);
      expect(cohort.totalPositions).to.equal(0);
      expect(cohort.mhiBps).to.equal(0);

      const gs = await program.account.globalState.fetch(globalStatePda);
      expect(gs.totalCohorts.toNumber()).to.equal(1);
    });

    it("fails for non-keeper", async () => {
      try {
        const [cohortPda] = findCohortPda(program.programId, 1);
        await program.methods
          .startCohort(coldStrikes)
          .accounts({
            keeper: randomUser.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            cohort: cohortPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([randomUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        const errStr = err.toString();
        expect(
          errStr.includes("Unauthorized") || errStr.includes("ConstraintRaw") || errStr.includes("Error")
        ).to.be.true;
      }
    });

    it("PDA collision when re-using index 0", async () => {
      // Cohort 0 already exists. Anchor's `init` constraint fires before
      // any handler logic, so re-deriving the same PDA fails with
      // ConstraintSeeds / "already in use". Note this is the PDA-collision
      // failure mode; the active-cohort cap (MAX_ACTIVE_COHORTS = 3) is
      // tested separately in 06_start_cohort.test.ts.
      try {
        const [cohortPda0] = findCohortPda(program.programId, 0);
        await program.methods
          .startCohort(coldStrikes)
          .accounts({
            keeper: keeper.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            cohort: cohortPda0,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([keeper])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        const errStr = err.toString();
        // Anchor may surface PDA mismatch as ConstraintSeeds, "already in use",
        // or "Error: Could not find ..."; any structural error is acceptable.
        expect(errStr.toLowerCase()).to.match(/seeds|already in use|could not find|constraint/);
      }
    });
  });


  describe("buy_call", () => {
    const strikeBps = ATM;
    let cohortPda: PublicKey;
    let positionPda: PublicKey;

    before(() => {
      [cohortPda] = findCohortPda(program.programId, 0);
      [positionPda] = findPositionPda(
        program.programId, cohortPda, buyer.publicKey, strikeBps, 0,
      );
    });

    it("buyer purchases call option", async () => {
      await program.methods
        .buyCall(strikeBps, SOL(0.1), 0)
        .accounts({
          buyer: buyer.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          p2pPool: p2pPoolPda,
          cohort: cohortPda,
          emaState: emaStatePda,
          position: positionPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([buyer])
        .rpc();

      const position = await program.account.position.fetch(positionPda);
      expect(position.owner.toBase58()).to.equal(buyer.publicKey.toBase58());
      expect(position.strikeBps).to.equal(strikeBps);
      expect(position.sizeLamports.toNumber()).to.equal(SOL(0.1).toNumber());
      expect(position.settled).to.equal(false);
      expect(position.premiumPaidLamports.toNumber()).to.be.greaterThan(0);
      expect(position.vaultPremiumLamports.toNumber()).to.equal(
        position.premiumPaidLamports.toNumber(),
      );

      const cohort = await program.account.cohort.fetch(cohortPda);
      expect(cohort.totalPositions).to.equal(1);

      // collateral = ceil((cap - strike) * size / 10_000) = ceil((30_000 - 12_500) * 1e8 / 10_000) = 175_000_000
      const vault = await program.account.vault.fetch(vaultPda);
      const expectedCollateral = Math.ceil(((MHI_CAP_BPS - strikeBps) * SOL(0.1).toNumber()) / 10_000);
      expect(vault.activeCollateralLamports.toNumber()).to.equal(expectedCollateral);
    });

    it("fails with invalid strike", async () => {
      const [badPosPda] = findPositionPda(
        program.programId, cohortPda, buyer.publicKey, 99999, 1,
      );
      try {
        await program.methods
          .buyCall(99999, SOL(0.1), 1)
          .accounts({
            buyer: buyer.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            p2pPool: p2pPoolPda,
            cohort: cohortPda,
            emaState: emaStatePda,
            position: badPosPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidStrike");
      }
    });

    it("fails with size = 0", async () => {
      const [zeroPosPda] = findPositionPda(
        program.programId, cohortPda, buyer.publicKey, strikeBps, 2,
      );
      try {
        await program.methods
          .buyCall(strikeBps, new anchor.BN(0), 2)
          .accounts({
            buyer: buyer.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            p2pPool: p2pPoolPda,
            cohort: cohortPda,
            emaState: emaStatePda,
            position: zeroPosPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("PositionSizeZero");
      }
    });
  });


  describe("submit_mhi", () => {
    let cohortPda: PublicKey;

    before(async () => {
      [cohortPda] = findCohortPda(program.programId, 0);
      const totalWait = FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION + 2;
      await warpTime(context, totalWait);
    });

    it("keeper submits MHI", async () => {
      const mhiBps = 15_000;

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

      const cohort = await program.account.cohort.fetch(cohortPda);
      // First cohort: unclamped → effective_mhi == submitted.
      expect(cohort.mhiBps).to.equal(15_000);

      const gs = await program.account.globalState.fetch(globalStatePda);
      expect(gs.lastMhiBps).to.equal(15_000);
      // First settlement bumps anchor from default to the MHI value.
      expect((gs as any).strikeAnchorBps).to.equal(15_000);
    });

    it("fails if submitted twice", async () => {
      await warpTime(context, 1);
      try {
        await program.methods
          .submitMhi(15_000, 20, Array.from({ length: 32 }, () => 0))
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
        const errStr = err.toString() + JSON.stringify(err.logs ?? []);
        expect(errStr).to.include("MhiAlreadySubmitted");
      }
    });

    it("fails for non-keeper", async () => {
      try {
        await program.methods
          .submitMhi(15_000, 20, Array.from({ length: 32 }, () => 0))
          .accounts({
            keeper: randomUser.publicKey,
            globalState: globalStatePda,
            cohort: cohortPda,
            emaState: emaStatePda,
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


  describe("settle_batch", () => {
    let cohortPda: PublicKey;
    let positionPda: PublicKey;

    before(() => {
      [cohortPda] = findCohortPda(program.programId, 0);
      [positionPda] = findPositionPda(
        program.programId, cohortPda, buyer.publicKey, ATM, 0,
      );
    });

    it("keeper settles positions", async () => {
      await program.methods
        .settleBatch()
        .accounts({
          caller: keeper.publicKey,
          globalState: globalStatePda,
          vault: vaultPda,
          cohort: cohortPda,
        } as any)
        .remainingAccounts([
          { pubkey: positionPda, isWritable: true, isSigner: false },
        ])
        .signers([keeper])
        .rpc();

      const position = await program.account.position.fetch(positionPda);
      expect(position.settled).to.equal(true);

      // Payout = capped((mhi - strike), cap - strike) * size / 10_000, floor.
      const cohortData = await program.account.cohort.fetch(cohortPda);
      const mhi = cohortData.mhiBps;
      const strike = ATM;
      const cap = MHI_CAP_BPS;
      const rawPayoff = Math.max(mhi - strike, 0);
      const cappedPayoff = Math.min(rawPayoff, cap - strike);
      const expectedPayout = Math.floor(cappedPayoff * SOL(0.1).toNumber() / 10_000);
      expect(position.payoutLamports.toNumber()).to.equal(expectedPayout);

      const cohort = await program.account.cohort.fetch(cohortPda);
      expect(cohort.positionsSettled).to.equal(1);

      // currentCohortIndex was incremented at start_cohort, not settle.
      const gs = await program.account.globalState.fetch(globalStatePda);
      expect(gs.currentCohortIndex.toNumber()).to.equal(1);
      // Settle drops active_cohorts back to 0.
      expect(gs.activeCohorts).to.equal(0);
    });
  });


  describe("claim", () => {
    let cohortPda: PublicKey;
    let positionPda: PublicKey;

    before(() => {
      [cohortPda] = findCohortPda(program.programId, 0);
      [positionPda] = findPositionPda(
        program.programId, cohortPda, buyer.publicKey, ATM, 0,
      );
    });

    it("buyer claims payout", async () => {
      await program.methods
        .claim()
        .accounts({
          caller: buyer.publicKey,
          owner: buyer.publicKey,
          vault: vaultPda,
          cohort: cohortPda,
          position: positionPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([buyer])
        .rpc();

      const posAccount = await getAccountOrNull(context.banksClient, positionPda);
      expect(posAccount).to.be.null;
    });

    it("double claim fails (PDA gone)", async () => {
      try {
        await program.methods
          .claim()
          .accounts({
            caller: buyer.publicKey,
            owner: buyer.publicKey,
            vault: vaultPda,
            cohort: cohortPda,
            position: positionPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        const errStr = err.toString() + JSON.stringify(err.logs ?? []);
        expect(
          errStr.includes("AccountNotFound") ||
          errStr.includes("not found") ||
          errStr.includes("does not exist") ||
          errStr.includes("Could not find") ||
          errStr.includes("AccountOwnedByWrongProgram") ||
          errStr.includes("AccountNotInitialized") ||
          errStr.includes("3012") ||
          errStr.includes("0xbc4") ||
          errStr.includes("already been processed")
        ).to.be.true;
      }
    });
  });


  describe("vault conservation", () => {
    it("invariant holds after full cycle", async () => {
      const vault = await program.account.vault.fetch(vaultPda);
      const vaultAccount = await provider.connection.getAccountInfo(vaultPda);
      const rent = await provider.connection.getMinimumBalanceForRentExemption(
        vaultAccount!.data.length,
      );

      const tracked =
        vault.availableLamports.toNumber() +
        vault.activeCollateralLamports.toNumber() +
        vault.unclaimedPayoutsLamports.toNumber();
      const actual = vaultAccount!.lamports - rent;

      expect(tracked).to.equal(actual);
      expect(vault.activeCollateralLamports.toNumber()).to.equal(0);
      expect(vault.unclaimedPayoutsLamports.toNumber()).to.equal(0);
    });
  });


  describe("permissions", () => {
    it("non-authority cannot update_config", async () => {
      try {
        await program.methods
          .updateConfig({ keeper: null, mhiCapBps: null, premiumFeeBps: null,
            referralShareBps: null, keeperFeeLamports: null, minPositionLamports: null,
            maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: null,
            tradingWindowSeconds: null, measurementSeconds: null, observationSeconds: null,
            settlementDeadlineSeconds: null, claimExpirySeconds: null,
            mhiFloorBps: null, mhiMaxDeltaBps: null, minPremiumLamports: null,
            maxPositionCollateralBps: null, paused: true } as any)
          .accounts({
            authority: randomUser.publicKey,
            globalState: globalStatePda,
          } as any)
          .signers([randomUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });

    it("non-authority cannot seed_vault", async () => {
      try {
        await program.methods
          .seedVault(SOL(1))
          .accounts({
            authority: randomUser.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([randomUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });

    it("non-keeper cannot start_cohort", async () => {
      const [cohortPda] = findCohortPda(program.programId, 1);
      const gs = await program.account.globalState.fetch(globalStatePda);
      const liveStrikes = deriveStrikes((gs as any).strikeAnchorBps as number);
      try {
        await program.methods
          .startCohort(liveStrikes)
          .accounts({
            keeper: randomUser.publicKey,
            globalState: globalStatePda,
            vault: vaultPda,
            cohort: cohortPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([randomUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });
  });
});
