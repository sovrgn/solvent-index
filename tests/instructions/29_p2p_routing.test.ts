/**
 * 80/20 vault/P2P routing tests.
 *
 * Rule under test (must match buy_call.rs and buy_call_p2p.rs):
 *   - Per-cohort risk cap (max_vault_risk_per_cohort_bps, default 2000 = 20%)
 *     applies identically to the vault and the P2P pool, each using its own
 *     (available + active_collateral) total as the base.
 *   - When P2P is enabled and the pool has room, the 4:1 vault:P2P ratio is
 *     enforced on-chain. The next P2P position is allowed iff
 *         vault_positions >= (p2p_positions + 1) * VAULT_TO_P2P_RATIO   (4)
 *     i.e., vault gets at least 4 before P2P gets 1.
 *   - buy_call rejects (RouteToP2p) when the ratio prefers P2P AND P2P can
 *     serve. buy_call_p2p rejects (VaultNotFull) when vault can serve AND the
 *     ratio prefers vault.
 *   - When one pool is full/empty, demand overflows to the other.
 */
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  setupProtocol, TestCtx, expectError,
  startCohort, buyCall, fundedKeypair,
  findP2pPositionPda, findP2pPoolPda,
  SOL, currentAtmStrike, currentLiveStrikes,
} from "./_setup";

const VAULT_TO_P2P_RATIO = 4;

async function enableP2p(t: TestCtx, poolPda: PublicKey) {
  await (t.program.methods as any).updateP2PConfig({
    p2PBuyerFeeBps: 500,
    p2PWriterFeeBps: 500,
    p2PEnabled: true,
    acceptingDeposits: true,
  })
    .accounts({ authority: t.authority.publicKey, globalState: t.globalState, p2PPool: poolPda } as any)
    .rpc();
}

async function depositP2p(
  t: TestCtx, poolPda: PublicKey, amountSol: number,
): Promise<{ writer: Keypair; writerAccount: PublicKey }> {
  const writer = await fundedKeypair(t.context, amountSol + 5);
  const [writerAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("writer_account"), writer.publicKey.toBuffer()], t.program.programId,
  );
  await (t.program.methods as any).registerWriter()
    .accounts({ writer: writer.publicKey, writerAccount, systemProgram: SystemProgram.programId } as any)
    .signers([writer]).rpc();
  await (t.program.methods as any).depositP2P(SOL(amountSol))
    .accounts({
      writer: writer.publicKey, p2PPool: poolPda, writerAccount,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([writer]).rpc();
  return { writer, writerAccount };
}

async function buyVault(
  t: TestCtx, cohort: PublicKey, buyer: Keypair, strike: number, size: anchor.BN, nonce: number,
) {
  const [posPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"), cohort.toBuffer(), buyer.publicKey.toBuffer(),
      (() => { const b = Buffer.alloc(4); b.writeUInt32LE(strike); return b; })(),
      Buffer.from([nonce]),
    ],
    t.program.programId,
  );
  return t.program.methods
    .buyCall(strike, size, nonce)
    .accounts({
      buyer: buyer.publicKey,
      globalState: t.globalState,
      vault: t.vault,
      p2pPool: t.p2pPool,
      cohort,
      emaState: t.emaState,
      position: posPda,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([buyer])
    .rpc();
}

async function buyP2p(
  t: TestCtx, cohort: PublicKey, buyer: Keypair, strike: number, size: anchor.BN, nonce: number,
) {
  const [p2pPos] = findP2pPositionPda(t.program.programId, cohort, buyer.publicKey, strike, nonce);
  return (t.program.methods as any)
    .buyCallP2P(strike, size, nonce)
    .accounts({
      buyer: buyer.publicKey,
      globalState: t.globalState,
      vault: t.vault,
      p2PPool: t.p2pPool,
      cohort,
      emaState: t.emaState,
      p2PPosition: p2pPos,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([buyer])
    .rpc();
}

describe("29 - 80/20 vault/P2P routing", () => {

  // ─────────────────────────────────────────────────────────────────
  // 1. Ratio enforcement: buy_call rejects when ratio prefers P2P
  // ─────────────────────────────────────────────────────────────────

  describe("ratio: buy_call rejects 5th position when P2P can serve", () => {
    let t: TestCtx;

    before(async () => {
      t = await setupProtocol({ seedSol: 50 });
      await enableP2p(t, t.p2pPool);
      await depositP2p(t, t.p2pPool, 20);
    });

    it("4 vault positions succeed, 5th is RouteToP2p", async () => {
      const cohort = await startCohort(t);
      const atm = await currentAtmStrike(t);
      // 4 vault buys
      for (let i = 0; i < 4; i++) {
        const buyer = await fundedKeypair(t.context, 5);
        await buyVault(t, cohort, buyer, atm, SOL(0.05), 0);
      }
      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.totalPositions).to.equal(4);
      expect((cohortData as any).p2PPositions).to.equal(0);

      // 5th vault buy must reject — ratio now prefers P2P (vault=4, p2p=0, threshold=4).
      const buyer5 = await fundedKeypair(t.context, 5);
      await expectError(
        () => buyVault(t, cohort, buyer5, atm, SOL(0.05), 0),
        "RouteToP2p",
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. Ratio enforcement: buy_call_p2p accepts when ratio prefers P2P
  //    (and vault still has room)
  // ─────────────────────────────────────────────────────────────────

  describe("ratio: buy_call_p2p accepts the 5th position even though vault has room", () => {
    let t: TestCtx;

    before(async () => {
      t = await setupProtocol({ seedSol: 50 });
      await enableP2p(t, t.p2pPool);
      await depositP2p(t, t.p2pPool, 20);
    });

    it("after 4 vault, 5th goes P2P; vault was not full", async () => {
      const cohort = await startCohort(t);
      const atm = await currentAtmStrike(t);
      for (let i = 0; i < 4; i++) {
        const buyer = await fundedKeypair(t.context, 5);
        await buyVault(t, cohort, buyer, atm, SOL(0.05), 0);
      }

      // 5th — vault still has plenty of room, but ratio says P2P.
      const buyer5 = await fundedKeypair(t.context, 5);
      await buyP2p(t, cohort, buyer5, atm, SOL(0.05), 0);

      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.totalPositions).to.equal(4);
      expect((cohortData as any).p2PPositions).to.equal(1);

      // Vault still has tons of capacity — confirms we accepted P2P without
      // requiring the vault to be full.
      const vault = await t.program.account.vault.fetch(t.vault);
      const vaultTotal = vault.availableLamports.toNumber() + vault.activeCollateralLamports.toNumber();
      const maxCohort = Math.floor(vaultTotal * 2000 / 10000);
      expect(cohortData.vaultCollateralLocked.toNumber()).to.be.lessThan(maxCohort);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. Long sequence: 80/20 ratio holds across 10 positions
  // ─────────────────────────────────────────────────────────────────

  describe("ratio: 80/20 holds across 10 positions", () => {
    let t: TestCtx;

    before(async () => {
      t = await setupProtocol({ seedSol: 50 });
      await enableP2p(t, t.p2pPool);
      await depositP2p(t, t.p2pPool, 20);
    });

    it("10 positions: 8 vault, 2 P2P (matches the user-facing ratio)", async () => {
      const cohort = await startCohort(t);
      const atm = await currentAtmStrike(t);
      let vaultCount = 0;
      let p2pCount = 0;

      // Off-chain router that mirrors the on-chain rule.
      for (let i = 0; i < 10; i++) {
        const buyer = await fundedKeypair(t.context, 5);
        const routeP2p = vaultCount >= (p2pCount + 1) * VAULT_TO_P2P_RATIO;
        if (routeP2p) {
          await buyP2p(t, cohort, buyer, atm, SOL(0.05), 0);
          p2pCount++;
        } else {
          await buyVault(t, cohort, buyer, atm, SOL(0.05), 0);
          vaultCount++;
        }
      }

      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.totalPositions).to.equal(8);
      expect((cohortData as any).p2PPositions).to.equal(2);
      expect(vaultCount).to.equal(8);
      expect(p2pCount).to.equal(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. Overflow vault → P2P when vault cap reached
  // ─────────────────────────────────────────────────────────────────

  describe("overflow: vault cap hit, demand flows to P2P", () => {
    let t: TestCtx;

    before(async () => {
      // 5 SOL seed → 20% cap = ~1 SOL of collateral per cohort.
      t = await setupProtocol({ seedSol: 5 });
      await enableP2p(t, t.p2pPool);
      await depositP2p(t, t.p2pPool, 50); // P2P has way more room
    });

    it("after vault fills, more buys land on P2P", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const lowest = live[0]!; // largest per-unit collateral

      // Fill the vault near its 20% cap.
      const buyer1 = await fundedKeypair(t.context, 5);
      await buyVault(t, cohort, buyer1, lowest, SOL(0.4), 0);

      // Next buy at the same strike should fit P2P, since vault is over cap.
      const buyer2 = await fundedKeypair(t.context, 5);
      await buyP2p(t, cohort, buyer2, lowest, SOL(0.2), 0);

      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.totalPositions).to.equal(1);
      expect((cohortData as any).p2PPositions).to.equal(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. P2P risk cap mirrors vault (20% of pool)
  // ─────────────────────────────────────────────────────────────────

  describe("P2P risk cap (same 20% bps, pool total as base)", () => {
    let t: TestCtx;

    before(async () => {
      // Big vault so vault path stays open; small P2P pool so its cap binds.
      t = await setupProtocol({ seedSol: 100 });
      await enableP2p(t, t.p2pPool);
      await depositP2p(t, t.p2pPool, 1); // pool total = 1 SOL → P2P cap = 0.2 SOL collateral
    });

    it("over-cap P2P buy rejects with P2pRiskCapExceeded", async () => {
      const cohort = await startCohort(t);
      const live = await currentLiveStrikes(t);
      const lowest = live[0]!;

      // Drive vault past the ratio so a P2P buy is admissible.
      for (let i = 0; i < 4; i++) {
        const buyer = await fundedKeypair(t.context, 5);
        await buyVault(t, cohort, buyer, lowest, SOL(0.05), 0);
      }

      // A P2P buy that locks > 20% of the small pool (collateral > 0.2 SOL)
      // should hit the P2P risk cap. SOL(0.2) at lowest strike locks ~0.42 SOL.
      const buyer5 = await fundedKeypair(t.context, 5);
      await expectError(
        () => buyP2p(t, cohort, buyer5, lowest, SOL(0.2), 0),
        "P2pRiskCapExceeded",
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 6. Empty P2P pool: ratio rule doesn't fire — vault keeps serving
  // ─────────────────────────────────────────────────────────────────

  describe("empty P2P pool: vault keeps serving past the ratio boundary", () => {
    let t: TestCtx;

    before(async () => {
      t = await setupProtocol({ seedSol: 50 });
      await enableP2p(t, t.p2pPool);
      // No deposits — pool stays empty.
    });

    it("5th vault buy succeeds because P2P cannot serve", async () => {
      const cohort = await startCohort(t);
      const atm = await currentAtmStrike(t);
      for (let i = 0; i < 5; i++) {
        const buyer = await fundedKeypair(t.context, 5);
        await buyVault(t, cohort, buyer, atm, SOL(0.05), 0);
      }
      const cohortData = await t.program.account.cohort.fetch(cohort);
      expect(cohortData.totalPositions).to.equal(5);
      expect((cohortData as any).p2PPositions).to.equal(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 7. Adversarial: buyer cannot bypass the ratio by going straight to P2P
  // ─────────────────────────────────────────────────────────────────

  describe("adversarial: cannot bypass ratio via buy_call_p2p", () => {
    let t: TestCtx;

    before(async () => {
      t = await setupProtocol({ seedSol: 50 });
      await enableP2p(t, t.p2pPool);
      await depositP2p(t, t.p2pPool, 20);
    });

    it("1st position cannot be sent to P2P (ratio prefers vault, vault has room)", async () => {
      const cohort = await startCohort(t);
      const atm = await currentAtmStrike(t);
      const buyer = await fundedKeypair(t.context, 5);
      await expectError(
        () => buyP2p(t, cohort, buyer, atm, SOL(0.05), 0),
        "VaultNotFull",
      );
    });

    it("with 3 vault positions, 4th cannot yet go P2P (still vault's turn)", async () => {
      const cohort = await startCohort(t);
      const atm = await currentAtmStrike(t);
      for (let i = 0; i < 3; i++) {
        const buyer = await fundedKeypair(t.context, 5);
        await buyVault(t, cohort, buyer, atm, SOL(0.05), 0);
      }
      const buyer4 = await fundedKeypair(t.context, 5);
      await expectError(
        () => buyP2p(t, cohort, buyer4, atm, SOL(0.05), 0),
        "VaultNotFull",
      );
    });
  });
});
