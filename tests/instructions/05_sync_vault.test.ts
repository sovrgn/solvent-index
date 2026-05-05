import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import {
  setupProtocol,
  expectError,
  warpTime,
  SOL,
  TestCtx,
} from "./_setup";

describe("05 - sync_vault", () => {
  let t: TestCtx;

  before(async () => {
    t = await setupProtocol();
  });

  it("after direct SOL transfer, sync_vault recovers surplus", async () => {
    const vaultBefore = await t.program.account.vault.fetch(t.vault);
    const availBefore = vaultBefore.availableLamports.toNumber();

    const directAmount = 500_000_000; // 0.5 SOL

    // Send SOL directly to vault PDA (bypassing seed_vault)
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: t.authority.publicKey,
        toPubkey: t.vault,
        lamports: directAmount,
      }),
    );
    await t.provider.sendAndConfirm!(tx);

    // Warp to avoid duplicate tx detection
    await warpTime(t.context, 1);

    // available_lamports should not have changed yet
    const vaultMid = await t.program.account.vault.fetch(t.vault);
    expect(vaultMid.availableLamports.toNumber()).to.equal(availBefore);

    // Sync vault
    await t.program.methods
      .syncVault()
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
        vault: t.vault,
      } as any)
      .rpc();

    // Now available_lamports should include the surplus
    const vaultAfter = await t.program.account.vault.fetch(t.vault);
    expect(vaultAfter.availableLamports.toNumber()).to.equal(
      availBefore + directAmount,
    );
  });

  it("no surplus - no change", async () => {
    await warpTime(t.context, 1); // fresh blockhash (identical instruction as previous test)
    const vaultBefore = await t.program.account.vault.fetch(t.vault);
    const availBefore = vaultBefore.availableLamports.toNumber();

    await t.program.methods
      .syncVault()
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
        vault: t.vault,
      } as any)
      .rpc();

    const vaultAfter = await t.program.account.vault.fetch(t.vault);
    expect(vaultAfter.availableLamports.toNumber()).to.equal(availBefore);
  });

  it("non-authority → UnauthorizedAuthority", async () => {
    await expectError(
      () =>
        t.program.methods
          .syncVault()
          .accounts({
            authority: t.randomUser.publicKey,
            globalState: t.globalState,
            vault: t.vault,
          } as any)
          .signers([t.randomUser])
          .rpc(),
      "UnauthorizedAuthority",
    );
  });

  it("call after seed_vault - no surplus (already tracked)", async () => {
    await t.program.methods
      .seedVault(SOL(2))
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
        vault: t.vault,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const vaultAfterSeed = await t.program.account.vault.fetch(t.vault);
    const availAfterSeed = vaultAfterSeed.availableLamports.toNumber();

    // Sync should find no surplus since seed_vault already tracked it
    await t.program.methods
      .syncVault()
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
        vault: t.vault,
      } as any)
      .rpc();

    const vaultAfterSync = await t.program.account.vault.fetch(t.vault);
    expect(vaultAfterSync.availableLamports.toNumber()).to.equal(availAfterSeed);
  });
});
