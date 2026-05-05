import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import {
  setupProtocol,
  expectError,
  getBalance,
  startCohort,
  warpTime,
  SOL,
  TestCtx,
} from "./_setup";

describe("04 - seed_vault", () => {
  let t: TestCtx;

  before(async () => {
    t = await setupProtocol();
  });

  it("authority seeds vault - available and protocol_seed increase", async () => {
    const vaultBefore = await t.program.account.vault.fetch(t.vault);
    const availBefore = vaultBefore.availableLamports.toNumber();
    const seedBefore = vaultBefore.protocolSeedLamports.toNumber();

    const seedAmount = SOL(5);

    await t.program.methods
      .seedVault(seedAmount)
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
        vault: t.vault,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const vaultAfter = await t.program.account.vault.fetch(t.vault);
    expect(vaultAfter.availableLamports.toNumber()).to.equal(
      availBefore + seedAmount.toNumber(),
    );
    expect(vaultAfter.protocolSeedLamports.toNumber()).to.equal(
      seedBefore + seedAmount.toNumber(),
    );
  });

  it("vault lamport balance matches tracked total + rent", async () => {
    const vault = await t.program.account.vault.fetch(t.vault);
    const vaultAccount = await t.provider.connection.getAccountInfo(t.vault);
    const rent = await t.provider.connection.getMinimumBalanceForRentExemption(
      vaultAccount!.data.length,
    );

    const tracked =
      vault.availableLamports.toNumber() +
      vault.activeCollateralLamports.toNumber() +
      vault.unclaimedPayoutsLamports.toNumber();

    expect(vaultAccount!.lamports).to.equal(tracked + rent);
  });

  it("multiple seeds accumulate correctly", async () => {
    const vaultBefore = await t.program.account.vault.fetch(t.vault);
    const availBefore = vaultBefore.availableLamports.toNumber();
    const seedBefore = vaultBefore.protocolSeedLamports.toNumber();

    const first = SOL(2);
    const second = SOL(3);

    await t.program.methods
      .seedVault(first)
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
        vault: t.vault,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    await t.program.methods
      .seedVault(second)
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
        vault: t.vault,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const vaultAfter = await t.program.account.vault.fetch(t.vault);
    const totalAdded = first.toNumber() + second.toNumber();
    expect(vaultAfter.availableLamports.toNumber()).to.equal(
      availBefore + totalAdded,
    );
    expect(vaultAfter.protocolSeedLamports.toNumber()).to.equal(
      seedBefore + totalAdded,
    );
  });

  it("non-authority → UnauthorizedAuthority", async () => {
    await expectError(
      () =>
        t.program.methods
          .seedVault(SOL(1))
          .accounts({
            authority: t.randomUser.publicKey,
            globalState: t.globalState,
            vault: t.vault,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([t.randomUser])
          .rpc(),
      "UnauthorizedAuthority",
    );
  });

  it("amount = 0 → SeedAmountZero", async () => {
    await expectError(
      () =>
        t.program.methods
          .seedVault(new anchor.BN(0))
          .accounts({
            authority: t.authority.publicKey,
            globalState: t.globalState,
            vault: t.vault,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc(),
      "SeedAmountZero",
    );
  });

  it("seed very small amount (1 lamport) - succeeds", async () => {
    const vaultBefore = await t.program.account.vault.fetch(t.vault);
    const availBefore = vaultBefore.availableLamports.toNumber();

    await t.program.methods
      .seedVault(new anchor.BN(1))
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
        vault: t.vault,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const vaultAfter = await t.program.account.vault.fetch(t.vault);
    expect(vaultAfter.availableLamports.toNumber()).to.equal(availBefore + 1);
  });

  it("seed during active cohort - succeeds", async () => {
    const cohort = await startCohort(t);

    const vaultBefore = await t.program.account.vault.fetch(t.vault);
    const availBefore = vaultBefore.availableLamports.toNumber();

    const seedAmount = SOL(1);
    await t.program.methods
      .seedVault(seedAmount)
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
        vault: t.vault,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const vaultAfter = await t.program.account.vault.fetch(t.vault);
    expect(vaultAfter.availableLamports.toNumber()).to.equal(
      availBefore + seedAmount.toNumber(),
    );
  });
});
