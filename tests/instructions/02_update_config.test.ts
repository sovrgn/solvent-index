import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";

import {
  setupProtocol,
  TestCtx,
  expectError,
  fundedKeypair,
  MHI_CAP_BPS,
  FAST_TRADING_WINDOW,
  FAST_MEASUREMENT,
  FAST_OBSERVATION,
  FAST_SETTLEMENT_DEADLINE,
  FAST_CLAIM_EXPIRY,
} from "./_setup";


type UpdateConfigArgs = {
  keeper: PublicKey | null;
  mhiCapBps: number | null;
  premiumFeeBps: number | null;
  referralShareBps: number | null;
  keeperFeeLamports: anchor.BN | null;
  minPositionLamports: anchor.BN | null;
  maxPositionPerAddressBps: number | null;
  maxVaultRiskPerCohortBps: number | null;
  tradingWindowSeconds: number | null;
  measurementSeconds: number | null;
  observationSeconds: number | null;
  settlementDeadlineSeconds: number | null;
  claimExpirySeconds: number | null;
  mhiFloorBps: number | null;
  mhiMaxDeltaBps: number | null;
  minPremiumLamports: anchor.BN | null;
  maxPositionCollateralBps: number | null;
  paused: boolean | null;
};

function nullConfig(overrides: Partial<UpdateConfigArgs> = {}): UpdateConfigArgs {
  // Order MUST match Rust UpdateConfigParams field order for Anchor serialization
  return {
    keeper: null,
    mhiCapBps: null,
    premiumFeeBps: null,
    referralShareBps: null,
    keeperFeeLamports: null,
    minPositionLamports: null,
    minPremiumLamports: null,
    maxPositionPerAddressBps: null,
    maxVaultRiskPerCohortBps: null,
    maxPositionCollateralBps: null,
    tradingWindowSeconds: null,
    measurementSeconds: null,
    observationSeconds: null,
    settlementDeadlineSeconds: null,
    claimExpirySeconds: null,
    mhiFloorBps: null,
    mhiMaxDeltaBps: null,
    paused: null,
    ...overrides,
  };
}

/** Call updateConfig with the given params using the authority. */
async function callUpdateConfig(
  t: TestCtx,
  params: UpdateConfigArgs,
  signer?: anchor.web3.Keypair,
) {
  const who = signer ?? t.authority;
  const builder = t.program.methods
    .updateConfig(params as any)
    .accounts({
      authority: who.publicKey,
      globalState: t.globalState,
    } as any);

  if (signer && signer !== t.authority) {
    builder.signers([signer]);
  }

  return builder.rpc();
}

describe("update_config", () => {

  describe("happy path", () => {
    let t: TestCtx;

    before(async () => {
      t = await setupProtocol();
    });

    it("authority can update keeper address", async () => {
      const newKeeper = await fundedKeypair(t.context);
      await callUpdateConfig(t, nullConfig({ keeper: newKeeper.publicKey }));

      const gs = await t.program.account.globalState.fetch(t.globalState);
      expect(gs.keeper.toBase58()).to.equal(newKeeper.publicKey.toBase58());
    });

    it("params set to None are not changed", async () => {
      const gsBefore = await t.program.account.globalState.fetch(t.globalState);

      // Update only premiumFeeBps
      await callUpdateConfig(t, nullConfig({ premiumFeeBps: 200 }));

      const gsAfter = await t.program.account.globalState.fetch(t.globalState);
      expect(gsAfter.premiumFeeBps).to.equal(200);
      // Other fields unchanged
      expect(gsAfter.mhiCapBps).to.equal(gsBefore.mhiCapBps);
      expect(gsAfter.tradingWindowSeconds).to.equal(gsBefore.tradingWindowSeconds);
      expect(gsAfter.measurementSeconds).to.equal(gsBefore.measurementSeconds);
      expect(gsAfter.minPositionLamports.toNumber()).to.equal(
        gsBefore.minPositionLamports.toNumber(),
      );
      expect(gsAfter.referralShareBps).to.equal(gsBefore.referralShareBps);
    });

    it("all params None - succeeds, nothing changes", async () => {
      const gsBefore = await t.program.account.globalState.fetch(t.globalState);

      await callUpdateConfig(t, nullConfig());

      const gsAfter = await t.program.account.globalState.fetch(t.globalState);
      expect(gsAfter.premiumFeeBps).to.equal(gsBefore.premiumFeeBps);
      expect(gsAfter.mhiCapBps).to.equal(gsBefore.mhiCapBps);
      expect(gsAfter.tradingWindowSeconds).to.equal(gsBefore.tradingWindowSeconds);
      expect(gsAfter.paused).to.equal(gsBefore.paused);
    });
  });


  describe("error: non-authority signer", () => {
    let t: TestCtx;

    before(async () => {
      t = await setupProtocol();
    });

    it("rejects non-authority signer with UnauthorizedAuthority", async () => {
      await expectError(
        () => callUpdateConfig(t, nullConfig({ paused: true }), t.randomUser),
        "UnauthorizedAuthority",
      );
    });
  });

  describe("error: validation bounds", () => {
    let t: TestCtx;

    beforeEach(async () => {
      t = await setupProtocol();
    });

    it("premium_fee_bps = 1001 → InvalidConfig", async () => {
      await expectError(
        () => callUpdateConfig(t, nullConfig({ premiumFeeBps: 1001 })),
        "InvalidConfig",
      );
    });

    it("referral_share_bps = 5001 → InvalidConfig", async () => {
      await expectError(
        () => callUpdateConfig(t, nullConfig({ referralShareBps: 5001 })),
        "InvalidConfig",
      );
    });

    it("keeper_fee_lamports = 1_000_000_001 → InvalidConfig", async () => {
      await expectError(
        () =>
          callUpdateConfig(
            t,
            nullConfig({ keeperFeeLamports: new anchor.BN(1_000_000_001) }),
          ),
        "InvalidConfig",
      );
    });

    it("min_position_lamports = 0 → InvalidConfig", async () => {
      await expectError(
        () =>
          callUpdateConfig(
            t,
            nullConfig({ minPositionLamports: new anchor.BN(0) }),
          ),
        "InvalidConfig",
      );
    });

    it("min_position_lamports = 1_000_000_001 → InvalidConfig", async () => {
      await expectError(
        () =>
          callUpdateConfig(
            t,
            nullConfig({ minPositionLamports: new anchor.BN(1_000_000_001) }),
          ),
        "InvalidConfig",
      );
    });

    it("max_vault_risk_per_cohort_bps = 5001 → InvalidConfig", async () => {
      await expectError(
        () =>
          callUpdateConfig(
            t,
            nullConfig({ maxVaultRiskPerCohortBps: 5001 }),
          ),
        "InvalidConfig",
      );
    });

    it("trading_window_seconds = 29 → InvalidConfig", async () => {
      await expectError(
        () => callUpdateConfig(t, nullConfig({ tradingWindowSeconds: 29 })),
        "InvalidConfig",
      );
    });

    it("trading_window_seconds = 3601 → InvalidConfig", async () => {
      await expectError(
        () => callUpdateConfig(t, nullConfig({ tradingWindowSeconds: 3601 })),
        "InvalidConfig",
      );
    });

    it("measurement_seconds = 59 → InvalidConfig", async () => {
      await expectError(
        () => callUpdateConfig(t, nullConfig({ measurementSeconds: 59 })),
        "InvalidConfig",
      );
    });

    it("measurement_seconds = 7201 → InvalidConfig", async () => {
      await expectError(
        () => callUpdateConfig(t, nullConfig({ measurementSeconds: 7201 })),
        "InvalidConfig",
      );
    });

    it("observation_seconds = 29 → InvalidConfig", async () => {
      await expectError(
        () => callUpdateConfig(t, nullConfig({ observationSeconds: 29 })),
        "InvalidConfig",
      );
    });

    it("observation_seconds = 3601 → InvalidConfig", async () => {
      await expectError(
        () => callUpdateConfig(t, nullConfig({ observationSeconds: 3601 })),
        "InvalidConfig",
      );
    });

    it("settlement_deadline_seconds = 59 → InvalidConfig", async () => {
      await expectError(
        () =>
          callUpdateConfig(t, nullConfig({ settlementDeadlineSeconds: 59 })),
        "InvalidConfig",
      );
    });

    it("settlement_deadline_seconds = 86401 → InvalidConfig", async () => {
      await expectError(
        () =>
          callUpdateConfig(
            t,
            nullConfig({ settlementDeadlineSeconds: 86401 }),
          ),
        "InvalidConfig",
      );
    });

    it("claim_expiry_seconds = 3599 → InvalidConfig", async () => {
      await expectError(
        () => callUpdateConfig(t, nullConfig({ claimExpirySeconds: 3599 })),
        "InvalidConfig",
      );
    });

    it("claim_expiry_seconds = 604801 → InvalidConfig", async () => {
      await expectError(
        () => callUpdateConfig(t, nullConfig({ claimExpirySeconds: 604801 })),
        "InvalidConfig",
      );
    });

    it("mhi_floor_bps = 10001 → InvalidConfig", async () => {
      await expectError(
        () => callUpdateConfig(t, nullConfig({ mhiFloorBps: 10001 })),
        "InvalidConfig",
      );
    });

    it("mhi_max_delta_bps = 999 → InvalidConfig", async () => {
      await expectError(
        () => callUpdateConfig(t, nullConfig({ mhiMaxDeltaBps: 999 })),
        "InvalidConfig",
      );
    });

    it("mhi_max_delta_bps = 10001 → InvalidConfig", async () => {
      await expectError(
        () => callUpdateConfig(t, nullConfig({ mhiMaxDeltaBps: 10001 })),
        "InvalidConfig",
      );
    });
  });
});
