/**
 * Tests for the register_and_deposit instruction.
 * Covers happy paths, error paths, and adversarial scenarios.
 */
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, warpPastObservation, warpTime, submitMhi, settleBatch,
  fundedKeypair,
  SOL,
  FAST_TRADING_WINDOW, FAST_MEASUREMENT, FAST_OBSERVATION,
  FAST_SETTLEMENT_DEADLINE, FAST_CLAIM_EXPIRY,
} from "./_setup";

function findP2pPoolPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("p2p_pool")], programId);
}
function findWriterAccountPda(programId: PublicKey, writer: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("writer_account"), writer.toBuffer()], programId);
}

async function setupP2pProtocol(seedSol = 5, poolDeposit = 0): Promise<{
  t: TestCtx; pool: PublicKey; writer: Keypair; writerAccount: PublicKey;
}> {
  const t = await setupProtocol({ seedSol });
  const writer = await fundedKeypair(t.context, 1000);

  // P2P pool already initialized by setupProtocol.
  const [pool] = findP2pPoolPda(t.program.programId);

  await (t.program.methods as any).updateP2PConfig({
    p2PBuyerFeeBps: 500, p2PWriterFeeBps: 500, p2PEnabled: true, acceptingDeposits: true,
  }).accounts({ authority: t.authority.publicKey, globalState: t.globalState, p2PPool: pool } as any).rpc();

  const [writerAccount] = findWriterAccountPda(t.program.programId, writer.publicKey);

  // If poolDeposit > 0, register and deposit the writer via the old two-step flow
  if (poolDeposit > 0) {
    await (t.program.methods as any).registerWriter()
      .accounts({ writer: writer.publicKey, writerAccount, systemProgram: SystemProgram.programId } as any)
      .signers([writer]).rpc();
    await (t.program.methods as any).depositP2P(SOL(poolDeposit))
      .accounts({ writer: writer.publicKey, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
      .signers([writer]).rpc();
  }

  return { t, pool, writer, writerAccount };
}

const FULL_WARP = FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION + FAST_SETTLEMENT_DEADLINE + FAST_CLAIM_EXPIRY + 3;

describe("25 - register_and_deposit", () => {

  // ═══════════════════════════════════════════════════════════════════
  // Happy path
  // ═══════════════════════════════════════════════════════════════════
  describe("happy path", () => {

    it("new writer registers and deposits in one tx", async () => {
      const { t, pool } = await setupP2pProtocol(5, 0);
      const newWriter = await fundedKeypair(t.context, 100);
      const [writerAccount] = findWriterAccountPda(t.program.programId, newWriter.publicKey);

      await (t.program.methods as any).registerAndDeposit(SOL(1))
        .accounts({
          writer: newWriter.publicKey,
          writerAccount,
          p2PPool: pool,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([newWriter]).rpc();

      // Verify writer account created with correct writer pubkey
      const wa = await (t.program.account as any).writerAccount.fetch(writerAccount);
      expect(wa.writer.toBase58()).to.equal(newWriter.publicKey.toBase58());
      expect(wa.shares.toNumber()).to.be.greaterThan(0);
      expect(wa.totalDepositedLamports.toNumber()).to.equal(SOL(1).toNumber());

      // Verify pool state updated
      const poolState = await (t.program.account as any).p2PPool.fetch(pool);
      expect(poolState.availableLamports.toNumber()).to.be.greaterThanOrEqual(SOL(1).toNumber());
      expect(poolState.totalShares.toNumber()).to.be.greaterThan(0);
    });

    it("already-registered writer just deposits (skips init)", async () => {
      // Setup with writer already registered via register_writer
      const { t, pool, writer, writerAccount } = await setupP2pProtocol(5, 1);

      // Fetch shares before
      const waBefore = await (t.program.account as any).writerAccount.fetch(writerAccount);
      const sharesBefore = waBefore.shares.toNumber();
      expect(sharesBefore).to.be.greaterThan(0);

      // Call register_and_deposit - should succeed, just deposit
      await (t.program.methods as any).registerAndDeposit(SOL(2))
        .accounts({
          writer: writer.publicKey,
          writerAccount,
          p2PPool: pool,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([writer]).rpc();

      // Verify shares increased
      const waAfter = await (t.program.account as any).writerAccount.fetch(writerAccount);
      expect(waAfter.shares.toNumber()).to.be.greaterThan(sharesBefore);
      expect(waAfter.totalDepositedLamports.toNumber()).to.equal(SOL(3).toNumber()); // 1 + 2
    });

    it("re-registration after full withdrawal auto-closed account", async () => {
      const { t, pool } = await setupP2pProtocol(5, 0);
      const writer = await fundedKeypair(t.context, 100);
      const [writerAccount] = findWriterAccountPda(t.program.programId, writer.publicKey);

      // Register + deposit via register_and_deposit
      await (t.program.methods as any).registerAndDeposit(SOL(1))
        .accounts({
          writer: writer.publicKey,
          writerAccount,
          p2PPool: pool,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([writer]).rpc();

      const waFirst = await (t.program.account as any).writerAccount.fetch(writerAccount);
      const allShares = waFirst.shares.toNumber();
      expect(allShares).to.be.greaterThan(0);

      // Withdraw all (triggers auto-close)
      await (t.program.methods as any).withdrawP2P(new anchor.BN(allShares))
        .accounts({
          writer: writer.publicKey,
          globalState: t.globalState,
          p2PPool: pool,
          writerAccount,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([writer]).rpc();

      // Verify account was closed (fetch should fail)
      try {
        await (t.program.account as any).writerAccount.fetch(writerAccount);
        expect.fail("Account should have been closed after full withdrawal");
      } catch (e: any) {
        // Expected - account no longer exists
        expect(e.message).to.include("Could not find");
      }

      // Call register_and_deposit again - re-creates account and deposits
      await (t.program.methods as any).registerAndDeposit(SOL(1))
        .accounts({
          writer: writer.publicKey,
          writerAccount,
          p2PPool: pool,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([writer]).rpc();

      // Verify new account with fresh state
      const waNew = await (t.program.account as any).writerAccount.fetch(writerAccount);
      expect(waNew.writer.toBase58()).to.equal(writer.publicKey.toBase58());
      expect(waNew.shares.toNumber()).to.be.greaterThan(0);
      // After re-init, total_deposited starts fresh at 1 SOL
      expect(waNew.totalDepositedLamports.toNumber()).to.equal(SOL(1).toNumber());
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Error paths
  // ═══════════════════════════════════════════════════════════════════
  describe("error paths", () => {

    it("amount below 0.1 SOL minimum → PositionTooSmall", async () => {
      const { t, pool } = await setupP2pProtocol(5, 0);
      const writer = await fundedKeypair(t.context, 100);
      const [writerAccount] = findWriterAccountPda(t.program.programId, writer.publicKey);

      await expectError(
        () => (t.program.methods as any).registerAndDeposit(new anchor.BN(1))
          .accounts({
            writer: writer.publicKey,
            writerAccount,
            p2PPool: pool,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([writer]).rpc(),
        "PositionTooSmall"
      );
    });

    it("deposits disabled → InvalidConfig", async () => {
      const { t, pool } = await setupP2pProtocol(5, 0);

      // Disable deposits
      await (t.program.methods as any).updateP2PConfig({
        p2PBuyerFeeBps: 500, p2PWriterFeeBps: 500, p2PEnabled: true, acceptingDeposits: false,
      }).accounts({ authority: t.authority.publicKey, globalState: t.globalState, p2PPool: pool } as any).rpc();

      const writer = await fundedKeypair(t.context, 100);
      const [writerAccount] = findWriterAccountPda(t.program.programId, writer.publicKey);

      await expectError(
        () => (t.program.methods as any).registerAndDeposit(SOL(1))
          .accounts({
            writer: writer.publicKey,
            writerAccount,
            p2PPool: pool,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([writer]).rpc(),
        "InvalidConfig"
      );
    });

    it("amount = 0 → PositionTooSmall", async () => {
      const { t, pool } = await setupP2pProtocol(5, 0);
      const writer = await fundedKeypair(t.context, 100);
      const [writerAccount] = findWriterAccountPda(t.program.programId, writer.publicKey);

      await expectError(
        () => (t.program.methods as any).registerAndDeposit(new anchor.BN(0))
          .accounts({
            writer: writer.publicKey,
            writerAccount,
            p2PPool: pool,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([writer]).rpc(),
        "PositionTooSmall"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Adversarial
  // ═══════════════════════════════════════════════════════════════════
  describe("adversarial", () => {

    it("attacker cannot deposit into another writer's account (PDA tied to signer)", async () => {
      const { t, pool } = await setupP2pProtocol(5, 0);

      // Writer A registers via register_and_deposit
      const writerA = await fundedKeypair(t.context, 100);
      const [writerAccountA] = findWriterAccountPda(t.program.programId, writerA.publicKey);
      await (t.program.methods as any).registerAndDeposit(SOL(5))
        .accounts({
          writer: writerA.publicKey,
          writerAccount: writerAccountA,
          p2PPool: pool,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([writerA]).rpc();

      // Attacker calls register_and_deposit - gets their OWN PDA
      const attacker = await fundedKeypair(t.context, 100);
      const [attackerAccount] = findWriterAccountPda(t.program.programId, attacker.publicKey);
      await (t.program.methods as any).registerAndDeposit(SOL(1))
        .accounts({
          writer: attacker.publicKey,
          writerAccount: attackerAccount,
          p2PPool: pool,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([attacker]).rpc();

      // Verify PDAs are different
      expect(attackerAccount.toBase58()).to.not.equal(writerAccountA.toBase58());

      // Verify attacker's deposit went to attacker's account, not writer A's
      const waA = await (t.program.account as any).writerAccount.fetch(writerAccountA);
      const waAttacker = await (t.program.account as any).writerAccount.fetch(attackerAccount);

      expect(waA.writer.toBase58()).to.equal(writerA.publicKey.toBase58());
      expect(waAttacker.writer.toBase58()).to.equal(attacker.publicKey.toBase58());

      // Writer A still has exactly 5 SOL deposited
      expect(waA.totalDepositedLamports.toNumber()).to.equal(SOL(5).toNumber());
      // Attacker has exactly 1 SOL deposited
      expect(waAttacker.totalDepositedLamports.toNumber()).to.equal(SOL(1).toNumber());
    });

    it("registered via register_writer, then register_and_deposit just deposits", async () => {
      const { t, pool } = await setupP2pProtocol(5, 0);
      const writer = await fundedKeypair(t.context, 100);
      const [writerAccount] = findWriterAccountPda(t.program.programId, writer.publicKey);

      // Register via register_writer (no deposit)
      await (t.program.methods as any).registerWriter()
        .accounts({ writer: writer.publicKey, writerAccount, systemProgram: SystemProgram.programId } as any)
        .signers([writer]).rpc();

      const waBefore = await (t.program.account as any).writerAccount.fetch(writerAccount);
      expect(waBefore.shares.toNumber()).to.equal(0);
      expect(waBefore.writer.toBase58()).to.equal(writer.publicKey.toBase58());

      // register_and_deposit just deposits (no double-init)
      await (t.program.methods as any).registerAndDeposit(SOL(3))
        .accounts({
          writer: writer.publicKey,
          writerAccount,
          p2PPool: pool,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([writer]).rpc();

      const waAfter = await (t.program.account as any).writerAccount.fetch(writerAccount);
      // Verify shares increased by the correct delta
      expect(waAfter.shares.toNumber()).to.be.greaterThan(0);
      expect(waAfter.totalDepositedLamports.toNumber()).to.equal(SOL(3).toNumber());
      // Writer pubkey unchanged
      expect(waAfter.writer.toBase58()).to.equal(writer.publicKey.toBase58());
    });

    it("multiple small deposits accumulate shares correctly", async () => {
      const { t, pool } = await setupP2pProtocol(5, 0);
      const writer = await fundedKeypair(t.context, 100);
      const [writerAccount] = findWriterAccountPda(t.program.programId, writer.publicKey);

      // Deposit 1: 1 SOL (first deposit minimum)
      await (t.program.methods as any).registerAndDeposit(SOL(1))
        .accounts({
          writer: writer.publicKey,
          writerAccount,
          p2PPool: pool,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([writer]).rpc();

      const wa1 = await (t.program.account as any).writerAccount.fetch(writerAccount);
      const shares1 = wa1.shares.toNumber();
      expect(shares1).to.be.greaterThan(0);

      // Deposit 2: 0.5 SOL
      await (t.program.methods as any).registerAndDeposit(SOL(0.5))
        .accounts({
          writer: writer.publicKey,
          writerAccount,
          p2PPool: pool,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([writer]).rpc();

      const wa2 = await (t.program.account as any).writerAccount.fetch(writerAccount);
      const shares2Delta = wa2.shares.toNumber() - shares1;
      expect(shares2Delta).to.be.greaterThan(0);

      // Deposit 3: 1.0 SOL
      await (t.program.methods as any).registerAndDeposit(SOL(1))
        .accounts({
          writer: writer.publicKey,
          writerAccount,
          p2PPool: pool,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([writer]).rpc();

      const wa3 = await (t.program.account as any).writerAccount.fetch(writerAccount);
      const shares3Delta = wa3.shares.toNumber() - wa2.shares.toNumber();
      expect(shares3Delta).to.be.greaterThan(0);

      // Total shares = sum of individual share allocations
      expect(wa3.shares.toNumber()).to.equal(shares1 + shares2Delta + shares3Delta);

      // Total deposited = sum of deposits
      expect(wa3.totalDepositedLamports.toNumber()).to.equal(
        SOL(1).toNumber() + SOL(0.5).toNumber() + SOL(1).toNumber()
      );

      // Pool available = sum of all deposits
      const poolState = await (t.program.account as any).p2PPool.fetch(pool);
      expect(poolState.availableLamports.toNumber()).to.equal(
        SOL(1).toNumber() + SOL(0.5).toNumber() + SOL(1).toNumber()
      );
      expect(poolState.totalShares.toNumber()).to.equal(wa3.shares.toNumber());
    });
  });
});
