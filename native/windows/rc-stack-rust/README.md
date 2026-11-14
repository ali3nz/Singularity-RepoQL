# RC-owned MemoryCore stack lifecycle and scoped probe in native Rust

Functional Rust port of `memory/rc_stack.py` covering configuration construction, running the existing supervisor, health checks, scoped test write/recall/delete, token reading and RC state teardown. This port does **not** replace the Tencent vendor Core, Kanzo, provider router or the Node supervisor. It does not read or change production state by itself.

Build and test on native Windows:

```powershell
cargo test --manifest-path native/windows/rc-stack-rust/Cargo.toml
cargo clippy --manifest-path native/windows/rc-stack-rust/Cargo.toml --all-targets -- -D warnings
cargo build --release --manifest-path native/windows/rc-stack-rust/Cargo.toml
```

CLI commands:

```text
singularity-rc-stack config ROOT NODE CORE_DIR PANEL_DIR OUTPUT [CORE_PORT PANEL_PORT]
singularity-rc-stack start NODE SUPERVISOR CONFIG
singularity-rc-stack status NODE SUPERVISOR CONFIG
singularity-rc-stack stop NODE SUPERVISOR CONFIG
singularity-rc-stack healthy STATUS_JSON_FILE
singularity-rc-stack probe BASE_URL CONFIG_JSON SESSION_ID TEXT USER AGENT
singularity-rc-stack cleanup RC_STATE_DIR
singularity-rc-stack defaults LOCALAPPDATA
```

The probe is opt-in, only targets loopback addresses, uses the RC-owned bearer token from its config path, and verifies deletion before reporting success. Do not point it at a production listener. `cleanup` requires an explicit absolute path whose final component is `state` and refuses a symlinked state directory.

Native runtime tests and parity checks are unrun in this authoring environment. Do not replace installed Python scripts until the onsite engineer validates the exact execution path.
