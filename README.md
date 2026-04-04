# MHI Program

Anchor workspace for the Memecoin Health Index (MHI) options protocol on-chain program.

## Layout

- `programs/mhi/` — Rust program source
- `tests/` — TypeScript integration tests (mocha + anchor-bankrun)
- `Anchor.toml` — Anchor workspace config
- `Cargo.toml` / `Cargo.lock` — Rust workspace
- `package.json` / `tsconfig.json` — test harness deps

## Build & test

```sh
npm install
anchor build
anchor test            # full validator
npm test               # bankrun-only suite
```

The program ID is declared in `Anchor.toml` (`[programs.localnet]`) and in
`programs/mhi/src/lib.rs` (`declare_id!`). Update both if you redeploy under a
new keypair.
