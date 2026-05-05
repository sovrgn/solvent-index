/**
 * Event emission tests.
 *
 * Verify that all events are defined in the IDL and that event log entries
 * appear in transaction logs when instructions execute.
 *
 * Anchor 0.32 IDL stores events as { name: "PascalCase", discriminator: [...] }.
 * Event field definitions are in the `types` section of the IDL.
 */
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import {
  setupProtocol, TestCtx,
  startCohort, buyCall, warpPastObservation, submitMhi, settleBatch,
  claimPosition, warpTime, voidCohort,
  SOL, FAST_CLAIM_EXPIRY, findCohortPda,
} from "./_setup";

function hasEventLog(logs: string[]): boolean {
  return logs.some((l) => l.includes("Program data:"));
}

describe("event emissions", () => {
  let t: TestCtx;

  before(async () => { t = await setupProtocol(); });


  // Load raw IDL from JSON (Anchor Program may transform names)
  const rawIdl = require("../../target/idl/mhi.json");

  const expectedEvents = [
    "ProtocolInitialized",
    "ConfigUpdated",
    "VaultSeeded",
    "AuthorityTransferred",
    "CohortStarted",
    "CallPurchased",
    "MhiSubmitted",
    "PositionSettled",
    "PayoutClaimed",
    "PositionExpired",
    "CohortVoided",
  ];

  for (const eventName of expectedEvents) {
    it(`IDL contains ${eventName} event`, () => {
      const events = rawIdl.events ?? [];
      const found = events.some((e: any) => e.name === eventName);
      expect(found).to.equal(true, `Event ${eventName} not found in IDL`);
    });
  }


  it("CallPurchased type has buyer, strikeBps, premiumPaid fields", () => {
    const types = rawIdl.types ?? [];
    const eventType = types.find((t: any) => t.name === "CallPurchased");
    expect(eventType).to.not.be.undefined;
    const fieldNames = eventType.type.fields.map((f: any) => f.name);
    // JSON IDL uses snake_case field names
    expect(fieldNames).to.include("buyer");
    expect(fieldNames).to.include("strike_bps");
    expect(fieldNames).to.include("premium_paid");
    expect(fieldNames).to.include("referrer");
    expect(fieldNames).to.include("referral_payout");
  });


  describe("runtime log verification", () => {
    it("start_cohort produces Program data log entry", async () => {
      const gs = await t.program.account.globalState.fetch(t.globalState);
      const idx = gs.currentCohortIndex.toNumber();
      const [cohortPda] = findCohortPda(t.program.programId, idx);

      const tx = await t.program.methods
        .startCohort()
        .accounts({
          keeper: t.keeper.publicKey,
          globalState: t.globalState,
          vault: t.vault,
          emaState: t.emaState,
          cohort: cohortPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([t.keeper])
        .transaction();
      tx.feePayer = (t.provider.wallet as anchor.Wallet).payer.publicKey;
      tx.recentBlockhash = (await t.context.banksClient.getLatestBlockhash())![0];
      tx.partialSign(t.keeper);
      tx.partialSign((t.provider.wallet as anchor.Wallet).payer);
      const result = await t.context.banksClient.tryProcessTransaction(tx);
      expect(result.result).to.be.null;
      const logs = result.meta?.logMessages ?? [];
      expect(hasEventLog(logs)).to.equal(true, "CohortStarted event expected in logs");

      await voidCohort(t, cohortPda);
    });
  });
});
