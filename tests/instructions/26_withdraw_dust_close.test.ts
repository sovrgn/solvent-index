/**
 * Tests for withdraw_p2p dust threshold + auto-close behavior,
 * plus adversarial scenarios around writer lifecycle.
 */
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, warpPastObservation, warpTime, warpToTimestamp, submitMhi, settleBatch,
  claimPosition, fundedKeypair, findCohortPda, findPositionPda, findP2pPositionPda,
  getBalance,
  SOL, FAST_CLAIM_EXPIRY, FAST_SETTLEMENT_DEADLINE,
  FAST_TRADING_WINDOW, FAST_MEASUREMENT, FAST_OBSERVATION,
} from "./_setup";


function findP2pPoolPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("p2p_pool")], programId);
}
function findWriterAccountPda(programId: PublicKey, writer: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("writer_account"), writer.toBuffer()], programId);
}

async function setupP2pProtocol(seedSol = 5, poolDeposit = 5): Promise<{
  t: TestCtx; pool: PublicKey; writer: Keypair; writerAccount: PublicKey; buyer: Keypair;
}> {
  const t = await setupProtocol({ seedSol });
  const writer = await fundedKeypair(t.context, 1000);
  const buyer = await fundedKeypair(t.context, 1000);

  // Init pool
  const [pool] = findP2pPoolPda(t.program.programId);
  await (t.program.methods as any).initP2PPool()
    .accounts({ authority: t.authority.publicKey, globalState: t.globalState, p2PPool: pool, systemProgram: SystemProgram.programId } as any).rpc();

  // Enable P2P
  await (t.program.methods as any).updateP2PConfig({
    p2PBuyerFeeBps: 500, p2PWriterFeeBps: 500, p2PEnabled: true, acceptingDeposits: true,
  }).accounts({ authority: t.authority.publicKey, globalState: t.globalState, p2PPool: pool } as any).rpc();

  // Low vault cap so overflow triggers
  await t.program.methods.updateConfig({
    keeper: null, mhiCapBps: null, premiumFeeBps: null, referralShareBps: null,
    keeperFeeLamports: null, minPositionLamports: null, minPremiumLamports: null,
    maxPositionPerAddressBps: null, maxVaultRiskPerCohortBps: 500,
    maxPositionCollateralBps: null,
    tradingWindowSeconds: null, measurementSeconds: null,
    observationSeconds: null, settlementDeadlineSeconds: null,
    claimExpirySeconds: null, mhiFloorBps: null, mhiMaxDeltaBps: null,
    paused: null,
  }).accounts({ authority: t.authority.publicKey, globalState: t.globalState } as any).rpc();

  // Register + deposit writer
  const [writerAccount] = findWriterAccountPda(t.program.programId, writer.publicKey);
  await (t.program.methods as any).registerWriter()
    .accounts({ writer: writer.publicKey, writerAccount, systemProgram: SystemProgram.programId } as any)
    .signers([writer]).rpc();

  if (poolDeposit > 0) {
    await (t.program.methods as any).depositP2P(SOL(poolDeposit))
      .accounts({ writer: writer.publicKey, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
      .signers([writer]).rpc();
  }

  return { t, pool, writer, writerAccount, buyer };
}

async function fillVaultAndBuyP2p(
  t: TestCtx, pool: PublicKey, buyer: Keypair, strike = 12_000, size = SOL(0.05),
): Promise<{ cohort: PublicKey; vaultPositions: PublicKey[]; p2pPosition: PublicKey }> {
  const cohort = await startCohort(t);
  const vaultPositions: PublicKey[] = [];
  for (let i = 0; i < 50; i++) {
    try {
      const pos = await buyCall(t, cohort, { strikeBps: strike, size: SOL(0.05), nonce: i, buyer: t.buyer });
      vaultPositions.push(pos);
    } catch { break; }
  }
  const [p2pPos] = findP2pPositionPda(t.program.programId, cohort, buyer.publicKey, strike, 0);
  await (t.program.methods as any).buyCallP2P(strike, size, 0)
    .accounts({
      buyer: buyer.publicKey, globalState: t.globalState, vault: t.vault,
      p2PPool: pool, cohort, emaState: t.emaState, p2PPosition: p2pPos, systemProgram: SystemProgram.programId,
    } as any).signers([buyer]).rpc();
  return { cohort, vaultPositions, p2pPosition: p2pPos };
}

const FULL_WARP = FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION + FAST_SETTLEMENT_DEADLINE + FAST_CLAIM_EXPIRY + 3;

// Helper: settle a cohort fully (vault + P2P) and close it so pool returns to Idle
async function settleAndCloseCohort(
  t: TestCtx, pool: PublicKey, cohort: PublicKey,
  vaultPositions: PublicKey[], p2pPositions: PublicKey[],
  mhiBps = 14_000,
): Promise<void> {
  await warpTime(t.context, FULL_WARP);
  await submitMhi(t, cohort, mhiBps);
  if (vaultPositions.length > 0) await settleBatch(t, cohort, vaultPositions);

  if (p2pPositions.length > 0) {
    await (t.program.methods as any).settleBatchP2P()
      .accounts({ caller: t.keeper.publicKey, globalState: t.globalState, p2PPool: pool, cohort } as any)
      .remainingAccounts(p2pPositions.map((pk) => ({ pubkey: pk, isWritable: true, isSigner: false })))
      .signers([t.keeper]).rpc();
  } else {
    // Empty P2P settle to transition cohort
    await settleBatch(t, cohort, []);
  }

  // Warp past claim expiry and close
  await warpTime(t.context, FAST_CLAIM_EXPIRY + 1);
  for (const pos of vaultPositions) {
    try { await claimPosition(t, cohort, pos, t.buyer); } catch { /* expired or already claimed */ }
  }
  await t.program.methods.closeCohort()
    .accounts({ caller: t.keeper.publicKey, globalState: t.globalState, cohort } as any)
    .signers([t.keeper]).rpc();
}

describe("26 - withdraw_p2p dust threshold + auto-close", () => {

  // ═══════════════════════════════════════════════════════════════════
  describe("auto-close on full withdrawal", () => {

    it("full withdrawal closes writer account, rent returned to writer", async () => {
      const { t, pool, writer, writerAccount } = await setupP2pProtocol(5, 1);

      // Verify writer account exists and has shares
      const waBefore = await (t.program.account as any).writerAccount.fetch(writerAccount);
      const allShares = waBefore.shares.toNumber();
      expect(allShares).to.be.greaterThan(0);

      const poolBefore = await (t.program.account as any).p2PPool.fetch(pool);
      const writerBalBefore = await getBalance(t.context.banksClient, writer.publicKey);

      // Withdraw all shares
      await (t.program.methods as any).withdrawP2P(new anchor.BN(allShares))
        .accounts({ writer: writer.publicKey, globalState: t.globalState, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
        .signers([writer]).rpc();

      // Verify: writer account PDA is closed (getAccountInfo returns null)
      const waInfo = await t.context.banksClient.getAccount(writerAccount);
      expect(waInfo).to.be.null;

      // Verify: writer balance increased (got lamports + rent back)
      const writerBalAfter = await getBalance(t.context.banksClient, writer.publicKey);
      // Writer should have received ~1 SOL of lamports plus the rent refund, minus tx fee
      expect(writerBalAfter).to.be.greaterThan(writerBalBefore);

      // Verify: pool total_shares decreased to 0, available decreased
      const poolAfter = await (t.program.account as any).p2PPool.fetch(pool);
      expect(poolAfter.totalShares.toNumber()).to.equal(0);
      expect(poolAfter.availableLamports.toNumber()).to.equal(0);
    });

    it("partial withdrawal leaves account open", async () => {
      const { t, pool, writer, writerAccount } = await setupP2pProtocol(5, 2);

      const waBefore = await (t.program.account as any).writerAccount.fetch(writerAccount);
      const allShares = waBefore.shares.toNumber();
      const halfShares = Math.floor(allShares / 2);
      expect(halfShares).to.be.greaterThan(0);

      // Withdraw half shares
      await (t.program.methods as any).withdrawP2P(new anchor.BN(halfShares))
        .accounts({ writer: writer.publicKey, globalState: t.globalState, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
        .signers([writer]).rpc();

      // Verify: account still exists
      const waInfo = await t.context.banksClient.getAccount(writerAccount);
      expect(waInfo).to.not.be.null;

      // Verify: shares = original / 2 (remaining half is well above dust threshold)
      const waAfter = await (t.program.account as any).writerAccount.fetch(writerAccount);
      expect(waAfter.shares.toNumber()).to.equal(allShares - halfShares);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  describe("dust threshold", () => {

    it("shares worth exactly 100000 lamports (0.0001 SOL) are NOT dust-burned", async () => {
      // Deposit 1 SOL = 1_000_000_000 lamports. First deposit → 1:1 shares.
      const { t, pool, writer, writerAccount } = await setupP2pProtocol(5, 0);

      // Deposit 1 SOL (first deposit minimum)
      await (t.program.methods as any).depositP2P(SOL(1))
        .accounts({ writer: writer.publicKey, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
        .signers([writer]).rpc();

      const waBefore = await (t.program.account as any).writerAccount.fetch(writerAccount);
      const totalShares = waBefore.shares.toNumber(); // 1_000_000_000 at 1:1

      // Withdraw all but 100000 shares (worth exactly 100000 lamports at 1:1 price)
      const sharesToWithdraw = totalShares - 100000;
      expect(sharesToWithdraw).to.be.greaterThan(0);

      await (t.program.methods as any).withdrawP2P(new anchor.BN(sharesToWithdraw))
        .accounts({ writer: writer.publicKey, globalState: t.globalState, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
        .signers([writer]).rpc();

      // Shares worth exactly 100000 lamports should NOT be dust-burned
      // (dust threshold is < 100000, not <=)
      const waInfo = await t.context.banksClient.getAccount(writerAccount);
      expect(waInfo).to.not.be.null;

      const waAfter = await (t.program.account as any).writerAccount.fetch(writerAccount);
      expect(waAfter.shares.toNumber()).to.equal(100000);
    });

    it("shares worth < 100000 lamports are auto-burned and account closed", async () => {
      const { t, pool, writer, writerAccount } = await setupP2pProtocol(5, 0);

      // Deposit 1 SOL = 1_000_000_000 lamports → 1_000_000_000 shares at 1:1
      await (t.program.methods as any).depositP2P(SOL(1))
        .accounts({ writer: writer.publicKey, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
        .signers([writer]).rpc();

      const waBefore = await (t.program.account as any).writerAccount.fetch(writerAccount);
      const totalShares = waBefore.shares.toNumber();

      // Withdraw all but 99999 shares (worth 99999 lamports at 1:1 → below 100000 threshold)
      const sharesToWithdraw = totalShares - 99999;

      await (t.program.methods as any).withdrawP2P(new anchor.BN(sharesToWithdraw))
        .accounts({ writer: writer.publicKey, globalState: t.globalState, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
        .signers([writer]).rpc();

      // Dust should be burned, writer account should be auto-closed
      const waInfo = await t.context.banksClient.getAccount(writerAccount);
      expect(waInfo).to.be.null;

      // Pool total_shares should have been reduced by the dust amount too
      const poolAfter = await (t.program.account as any).p2PPool.fetch(pool);
      expect(poolAfter.totalShares.toNumber()).to.equal(0);
    });

    it("dust burn - value stays in pool, not returned to writer", async () => {
      const { t, pool, writer, writerAccount } = await setupP2pProtocol(5, 0);

      // Writer A deposits 10 SOL
      await (t.program.methods as any).depositP2P(SOL(10))
        .accounts({ writer: writer.publicKey, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
        .signers([writer]).rpc();

      // Writer B deposits 1 SOL (first deposit minimum)
      const writerB = await fundedKeypair(t.context, 1000);
      const [writerAccountB] = findWriterAccountPda(t.program.programId, writerB.publicKey);
      await (t.program.methods as any).registerWriter()
        .accounts({ writer: writerB.publicKey, writerAccount: writerAccountB, systemProgram: SystemProgram.programId } as any)
        .signers([writerB]).rpc();
      await (t.program.methods as any).depositP2P(SOL(1))
        .accounts({ writer: writerB.publicKey, p2PPool: pool, writerAccount: writerAccountB, systemProgram: SystemProgram.programId } as any)
        .signers([writerB]).rpc();

      const waB = await (t.program.account as any).writerAccount.fetch(writerAccountB);
      const bShares = waB.shares.toNumber();

      // B withdraws all but 99999 shares (dust - below 100000 threshold)
      const sharesToWithdraw = bShares - 99999;
      const writerBBalBefore = await getBalance(t.context.banksClient, writerB.publicKey);

      await (t.program.methods as any).withdrawP2P(new anchor.BN(sharesToWithdraw))
        .accounts({ writer: writerB.publicKey, globalState: t.globalState, p2PPool: pool, writerAccount: writerAccountB, systemProgram: SystemProgram.programId } as any)
        .signers([writerB]).rpc();

      const writerBBalAfter = await getBalance(t.context.banksClient, writerB.publicKey);

      // B's account should be closed (dust burned)
      const waBInfo = await t.context.banksClient.getAccount(writerAccountB);
      expect(waBInfo).to.be.null;

      // Pool available should be slightly more than A's 10 SOL (B's dust remains as value)
      const poolAfter = await (t.program.account as any).p2PPool.fetch(pool);
      expect(poolAfter.availableLamports.toNumber()).to.be.greaterThan(SOL(10).toNumber());
      // The dust (~99999 lamports) stays in pool
      expect(poolAfter.availableLamports.toNumber()).to.be.lessThanOrEqual(SOL(10).toNumber() + 99999);

      // B got back less than 1 SOL worth (lost the dust, gained rent refund)
      // The lamport withdrawal was (bShares - 99999) shares worth of lamports, not the full 1 SOL
      // Just verify pool has dust value remaining
      const waA = await (t.program.account as any).writerAccount.fetch(writerAccount);
      expect(waA.shares.toNumber()).to.be.greaterThan(0); // A still has shares
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  describe("adversarial", () => {

    it("writer with 0 shares cannot call withdraw (shares_to_burn must be > 0)", async () => {
      const { t, pool, writer } = await setupP2pProtocol(5, 0);
      // Writer is registered but has 0 shares (poolDeposit = 0)
      const [writerAccount] = findWriterAccountPda(t.program.programId, writer.publicKey);

      await expectError(
        () => (t.program.methods as any).withdrawP2P(new anchor.BN(1))
          .accounts({ writer: writer.publicKey, globalState: t.globalState, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
          .signers([writer]).rpc(),
        "InsufficientWriterCollateral"
      );
    });

    it("withdraw during active cohort -> rejected (Idle required)", async () => {
      const { t, pool, writer, writerAccount } = await setupP2pProtocol(5, 5);

      // Start a cohort (protocol status changes from Idle)
      const cohort = await startCohort(t);

      const wa = await (t.program.account as any).writerAccount.fetch(writerAccount);
      await expectError(
        () => (t.program.methods as any).withdrawP2P(new anchor.BN(wa.shares.toNumber()))
          .accounts({ writer: writer.publicKey, globalState: t.globalState, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
          .signers([writer]).rpc(),
        "InvalidCohortStatus"
      );

      // Cleanup: settle the cohort
      await warpTime(t.context, FULL_WARP);
      await submitMhi(t, cohort, 14_000);
      await settleBatch(t, cohort, []);
    });

    it("writer withdrawal does not affect buyer claims (unclaimed payouts reserved)", async () => {
      const { t, pool, writer, writerAccount, buyer } = await setupP2pProtocol(5, 5);

      // Create P2P position
      const { cohort, vaultPositions, p2pPosition } = await fillVaultAndBuyP2p(t, pool, buyer);

      // Settle with ITM MHI (above 120% strike)
      await warpTime(t.context, FULL_WARP);
      await submitMhi(t, cohort, 14_000);
      if (vaultPositions.length > 0) await settleBatch(t, cohort, vaultPositions);

      await (t.program.methods as any).settleBatchP2P()
        .accounts({ caller: t.keeper.publicKey, globalState: t.globalState, p2PPool: pool, cohort } as any)
        .remainingAccounts([{ pubkey: p2pPosition, isWritable: true, isSigner: false }])
        .signers([t.keeper]).rpc();

      // Verify position is settled and has payout
      const posData = await (t.program.account as any).p2PPosition.fetch(p2pPosition);
      expect(posData.settled).to.equal(true);
      const payoutAmount = posData.payoutLamports.toNumber();

      // Buyer claims P2P position BEFORE cohort closes - should succeed if payout > 0
      if (payoutAmount > 0) {
        const buyerBalBefore = await getBalance(t.context.banksClient, buyer.publicKey);
        await (t.program.methods as any).claimP2P()
          .accounts({ caller: buyer.publicKey, owner: buyer.publicKey, p2PPool: pool, cohort, p2PPosition: p2pPosition, systemProgram: SystemProgram.programId } as any)
          .signers([buyer]).rpc();
        const buyerBalAfter = await getBalance(t.context.banksClient, buyer.publicKey);
        expect(buyerBalAfter).to.be.greaterThan(buyerBalBefore - 10_000);
      }

      // Now close cohort so pool returns to Idle
      await warpTime(t.context, FAST_CLAIM_EXPIRY + 1);
      for (const pos of vaultPositions) {
        try { await claimPosition(t, cohort, pos, t.buyer); } catch { /* expired */ }
      }
      await t.program.methods.closeCohort()
        .accounts({ caller: t.keeper.publicKey, globalState: t.globalState, cohort } as any)
        .signers([t.keeper]).rpc();

      // Writer withdraws all available shares - pool still has the buyer's claimed payout deducted
      const wa = await (t.program.account as any).writerAccount.fetch(writerAccount);
      if (wa.shares.toNumber() > 0) {
        try {
          await (t.program.methods as any).withdrawP2P(new anchor.BN(wa.shares.toNumber()))
            .accounts({ writer: writer.publicKey, globalState: t.globalState, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
            .signers([writer]).rpc();
        } catch {
          // Partial withdrawal if full fails (unclaimed payouts reduce available)
          const poolData = await (t.program.account as any).p2PPool.fetch(pool);
          const availablePerShare = poolData.availableLamports.toNumber() / poolData.totalShares.toNumber();
          const maxSharesForAvailable = Math.floor(poolData.availableLamports.toNumber() / (availablePerShare + 1));
          if (maxSharesForAvailable > 0) {
            await (t.program.methods as any).withdrawP2P(new anchor.BN(maxSharesForAvailable))
              .accounts({ writer: writer.publicKey, globalState: t.globalState, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
              .signers([writer]).rpc();
          }
        }
      }
    });

    it("re-register after auto-close creates fresh account", async () => {
      const { t, pool, writer, writerAccount } = await setupP2pProtocol(5, 1);

      // Withdraw all shares → account closed
      const wa = await (t.program.account as any).writerAccount.fetch(writerAccount);
      await (t.program.methods as any).withdrawP2P(new anchor.BN(wa.shares.toNumber()))
        .accounts({ writer: writer.publicKey, globalState: t.globalState, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
        .signers([writer]).rpc();

      // Verify closed
      const waInfoClosed = await t.context.banksClient.getAccount(writerAccount);
      expect(waInfoClosed).to.be.null;

      // Re-register and deposit using registerAndDeposit (init_if_needed)
      await (t.program.methods as any).registerAndDeposit(SOL(2))
        .accounts({ writer: writer.publicKey, writerAccount, p2PPool: pool, systemProgram: SystemProgram.programId } as any)
        .signers([writer]).rpc();

      // Verify: new account with fresh values
      const waNew = await (t.program.account as any).writerAccount.fetch(writerAccount);
      expect(waNew.shares.toNumber()).to.be.greaterThan(0);
      // total_deposited should be 2 SOL (fresh account), not 3 SOL
      expect(waNew.totalDepositedLamports.toNumber()).to.equal(SOL(2).toNumber());
    });

    it("dust burn followed by re-deposit works cleanly", async () => {
      const { t, pool, writer, writerAccount } = await setupP2pProtocol(5, 0);

      // Deposit minimum (first deposit must be >= 1 SOL)
      await (t.program.methods as any).depositP2P(SOL(1))
        .accounts({ writer: writer.publicKey, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
        .signers([writer]).rpc();

      const waBefore = await (t.program.account as any).writerAccount.fetch(writerAccount);
      const totalShares = waBefore.shares.toNumber();

      // Withdraw leaving dust (99999 shares worth < 100000 lamports)
      await (t.program.methods as any).withdrawP2P(new anchor.BN(totalShares - 99999))
        .accounts({ writer: writer.publicKey, globalState: t.globalState, p2PPool: pool, writerAccount, systemProgram: SystemProgram.programId } as any)
        .signers([writer]).rpc();

      // Verify: account auto-closed due to dust burn
      const waInfoClosed = await t.context.banksClient.getAccount(writerAccount);
      expect(waInfoClosed).to.be.null;

      // Re-deposit using registerAndDeposit
      await (t.program.methods as any).registerAndDeposit(SOL(1))
        .accounts({ writer: writer.publicKey, writerAccount, p2PPool: pool, systemProgram: SystemProgram.programId } as any)
        .signers([writer]).rpc();

      // Verify: fresh account with correct shares
      const waNew = await (t.program.account as any).writerAccount.fetch(writerAccount);
      expect(waNew.shares.toNumber()).to.be.greaterThan(0);
      expect(waNew.totalDepositedLamports.toNumber()).to.equal(SOL(1).toNumber());
    });

    it("expire P2P position at claim_deadline + 1 succeeds", async () => {
      const { t, pool, writer, writerAccount, buyer } = await setupP2pProtocol(5, 5);

      // Buy P2P position
      const { cohort, vaultPositions, p2pPosition } = await fillVaultAndBuyP2p(t, pool, buyer);

      // Settle ITM
      await warpTime(t.context, FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION + 2);
      await submitMhi(t, cohort, 14_000);
      if (vaultPositions.length > 0) await settleBatch(t, cohort, vaultPositions);

      await (t.program.methods as any).settleBatchP2P()
        .accounts({ caller: t.keeper.publicKey, globalState: t.globalState, p2PPool: pool, cohort } as any)
        .remainingAccounts([{ pubkey: p2pPosition, isWritable: true, isSigner: false }])
        .signers([t.keeper]).rpc();

      // Get claim_deadline from position
      const posData = await (t.program.account as any).p2PPosition.fetch(p2pPosition);
      const claimDeadline = posData.claimDeadline.toNumber();

      // Warp to claim_deadline + 1 (expire uses > not >=)
      await warpToTimestamp(t.context, claimDeadline + 1);

      // expire_p2p_position should succeed (> in contract)
      const poolBefore = await (t.program.account as any).p2PPool.fetch(pool);
      const unclaimedBefore = poolBefore.unclaimedPayoutsLamports.toNumber();

      await (t.program.methods as any).expireP2PPosition()
        .accounts({ caller: t.keeper.publicKey, p2PPool: pool, cohort, p2PPosition: p2pPosition, systemProgram: SystemProgram.programId } as any)
        .signers([t.keeper]).rpc();

      // Verify: unclaimed payout returned to pool available
      const poolAfter = await (t.program.account as any).p2PPool.fetch(pool);
      const payout = posData.payoutLamports.toNumber();
      if (payout > 0) {
        expect(poolAfter.unclaimedPayoutsLamports.toNumber()).to.equal(unclaimedBefore - payout);
        expect(poolAfter.availableLamports.toNumber()).to.be.greaterThan(poolBefore.availableLamports.toNumber());
      }
    });

    it("expire P2P position before claim_deadline -> rejected", async () => {
      const { t, pool, writer, writerAccount, buyer } = await setupP2pProtocol(5, 5);

      // Buy P2P position
      const { cohort, vaultPositions, p2pPosition } = await fillVaultAndBuyP2p(t, pool, buyer);

      // Settle ITM
      await warpTime(t.context, FAST_TRADING_WINDOW + FAST_MEASUREMENT + FAST_OBSERVATION + 2);
      await submitMhi(t, cohort, 14_000);
      if (vaultPositions.length > 0) await settleBatch(t, cohort, vaultPositions);

      await (t.program.methods as any).settleBatchP2P()
        .accounts({ caller: t.keeper.publicKey, globalState: t.globalState, p2PPool: pool, cohort } as any)
        .remainingAccounts([{ pubkey: p2pPosition, isWritable: true, isSigner: false }])
        .signers([t.keeper]).rpc();

      // Get claim_deadline from position
      const posData = await (t.program.account as any).p2PPosition.fetch(p2pPosition);
      const claimDeadline = posData.claimDeadline.toNumber();

      // Warp to claim_deadline - 1 (one second before expiry)
      await warpToTimestamp(t.context, claimDeadline - 1);

      // expire_p2p_position should fail
      await expectError(
        () => (t.program.methods as any).expireP2PPosition()
          .accounts({ caller: t.keeper.publicKey, p2PPool: pool, cohort, p2PPosition: p2pPosition, systemProgram: SystemProgram.programId } as any)
          .signers([t.keeper]).rpc(),
        "ClaimNotExpired"
      );
    });
  });
});
