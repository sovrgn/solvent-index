# Solvent Index Program

Anchor workspace for the Solvent Index options protocol on-chain program.

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

## IDL

`anchor build` emits the IDL and TypeScript bindings as a side effect:

- `target/idl/mhi.json` - IDL consumed by clients and explorers
- `target/types/mhi.ts` — TypeScript types used by the test harness

To regenerate the IDL without a full program rebuild:

```sh
anchor idl build -o target/idl/mhi.json
```

To publish the IDL on-chain after deployment (so explorers and clients can
fetch it from the program account):

```sh
anchor idl init <PROGRAM_ID> --filepath target/idl/mhi.json
anchor idl upgrade <PROGRAM_ID> --filepath target/idl/mhi.json   # subsequent updates
```

To fetch the on-chain IDL of a deployed program:

```sh
anchor idl fetch <PROGRAM_ID> -o solvent_index.json
```
