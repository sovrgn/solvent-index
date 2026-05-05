import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  setupProtocol,
  expectError,
  fundedKeypair,
  TestCtx,
} from "./_setup";

describe("03 - authority_transfer", () => {
  let t: TestCtx;

  before(async () => {
    t = await setupProtocol();
  });

  it("propose → accept completes transfer", async () => {
    const newAuth = await fundedKeypair(t.context);

    // Propose
    await t.program.methods
      .proposeAuthority(newAuth.publicKey)
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();

    // Verify pending is set
    let gs = await t.program.account.globalState.fetch(t.globalState);
    expect(gs.pendingAuthority.toBase58()).to.equal(newAuth.publicKey.toBase58());

    // Accept
    await t.program.methods
      .acceptAuthority()
      .accounts({
        newAuthority: newAuth.publicKey,
        globalState: t.globalState,
      } as any)
      .signers([newAuth])
      .rpc();

    // Verify authority changed and pending cleared
    gs = await t.program.account.globalState.fetch(t.globalState);
    expect(gs.authority.toBase58()).to.equal(newAuth.publicKey.toBase58());
    expect(gs.pendingAuthority.toBase58()).to.equal(PublicKey.default.toBase58());

    // Transfer back so remaining tests work with t.authority
    await t.program.methods
      .proposeAuthority(t.authority.publicKey)
      .accounts({
        authority: newAuth.publicKey,
        globalState: t.globalState,
      } as any)
      .signers([newAuth])
      .rpc();

    await t.program.methods
      .acceptAuthority()
      .accounts({
        newAuthority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();
  });

  it("cancel clears pending authority", async () => {
    const newAuth = await fundedKeypair(t.context);

    await t.program.methods
      .proposeAuthority(newAuth.publicKey)
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();

    let gs = await t.program.account.globalState.fetch(t.globalState);
    expect(gs.pendingAuthority.toBase58()).to.equal(newAuth.publicKey.toBase58());

    await t.program.methods
      .cancelAuthorityTransfer()
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();

    gs = await t.program.account.globalState.fetch(t.globalState);
    expect(gs.pendingAuthority.toBase58()).to.equal(PublicKey.default.toBase58());
  });

  it("non-authority cannot propose → UnauthorizedAuthority", async () => {
    await expectError(
      () =>
        t.program.methods
          .proposeAuthority(t.randomUser.publicKey)
          .accounts({
            authority: t.randomUser.publicKey,
            globalState: t.globalState,
          } as any)
          .signers([t.randomUser])
          .rpc(),
      "UnauthorizedAuthority",
    );
  });

  it("propose Pubkey::default() → InvalidConfig", async () => {
    await expectError(
      () =>
        t.program.methods
          .proposeAuthority(PublicKey.default)
          .accounts({
            authority: t.authority.publicKey,
            globalState: t.globalState,
          } as any)
          .rpc(),
      "InvalidConfig",
    );
  });

  it("wrong signer cannot accept → UnauthorizedAuthority", async () => {
    const newAuth = await fundedKeypair(t.context);

    await t.program.methods
      .proposeAuthority(newAuth.publicKey)
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();

    // Random user tries to accept
    await expectError(
      () =>
        t.program.methods
          .acceptAuthority()
          .accounts({
            newAuthority: t.randomUser.publicKey,
            globalState: t.globalState,
          } as any)
          .signers([t.randomUser])
          .rpc(),
      "UnauthorizedAuthority",
    );

    // Clean up
    await t.program.methods
      .cancelAuthorityTransfer()
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();
  });

  it("non-authority cannot cancel → UnauthorizedAuthority", async () => {
    const newAuth = await fundedKeypair(t.context);

    await t.program.methods
      .proposeAuthority(newAuth.publicKey)
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();

    await expectError(
      () =>
        t.program.methods
          .cancelAuthorityTransfer()
          .accounts({
            authority: t.randomUser.publicKey,
            globalState: t.globalState,
          } as any)
          .signers([t.randomUser])
          .rpc(),
      "UnauthorizedAuthority",
    );

    // Clean up
    await t.program.methods
      .cancelAuthorityTransfer()
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();
  });

  it("old authority fails after transfer → UnauthorizedAuthority", async () => {
    const newAuth = await fundedKeypair(t.context);

    // Transfer to newAuth
    await t.program.methods
      .proposeAuthority(newAuth.publicKey)
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();

    await t.program.methods
      .acceptAuthority()
      .accounts({
        newAuthority: newAuth.publicKey,
        globalState: t.globalState,
      } as any)
      .signers([newAuth])
      .rpc();

    // Old authority tries to propose - should fail
    await expectError(
      () =>
        t.program.methods
          .proposeAuthority(t.randomUser.publicKey)
          .accounts({
            authority: t.authority.publicKey,
            globalState: t.globalState,
          } as any)
          .rpc(),
      "UnauthorizedAuthority",
    );

    // Transfer back
    await t.program.methods
      .proposeAuthority(t.authority.publicKey)
      .accounts({
        authority: newAuth.publicKey,
        globalState: t.globalState,
      } as any)
      .signers([newAuth])
      .rpc();

    await t.program.methods
      .acceptAuthority()
      .accounts({
        newAuthority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();
  });

  it("propose, cancel, propose different, accept → final is second proposal", async () => {
    const first = await fundedKeypair(t.context);
    const second = await fundedKeypair(t.context);

    // Propose first
    await t.program.methods
      .proposeAuthority(first.publicKey)
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();

    // Cancel
    await t.program.methods
      .cancelAuthorityTransfer()
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();

    // Propose second
    await t.program.methods
      .proposeAuthority(second.publicKey)
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();

    // Accept - should be second
    await t.program.methods
      .acceptAuthority()
      .accounts({
        newAuthority: second.publicKey,
        globalState: t.globalState,
      } as any)
      .signers([second])
      .rpc();

    const gs = await t.program.account.globalState.fetch(t.globalState);
    expect(gs.authority.toBase58()).to.equal(second.publicKey.toBase58());

    // Transfer back
    await t.program.methods
      .proposeAuthority(t.authority.publicKey)
      .accounts({
        authority: second.publicKey,
        globalState: t.globalState,
      } as any)
      .signers([second])
      .rpc();

    await t.program.methods
      .acceptAuthority()
      .accounts({
        newAuthority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();
  });

  it("transfer back to original authority", async () => {
    const intermediate = await fundedKeypair(t.context);

    // Transfer away
    await t.program.methods
      .proposeAuthority(intermediate.publicKey)
      .accounts({
        authority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();

    await t.program.methods
      .acceptAuthority()
      .accounts({
        newAuthority: intermediate.publicKey,
        globalState: t.globalState,
      } as any)
      .signers([intermediate])
      .rpc();

    // Transfer back
    await t.program.methods
      .proposeAuthority(t.authority.publicKey)
      .accounts({
        authority: intermediate.publicKey,
        globalState: t.globalState,
      } as any)
      .signers([intermediate])
      .rpc();

    await t.program.methods
      .acceptAuthority()
      .accounts({
        newAuthority: t.authority.publicKey,
        globalState: t.globalState,
      } as any)
      .rpc();

    const gs = await t.program.account.globalState.fetch(t.globalState);
    expect(gs.authority.toBase58()).to.equal(t.authority.publicKey.toBase58());
  });
});
