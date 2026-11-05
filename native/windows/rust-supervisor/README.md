# Native Windows Rust supervisor (source review)

Separate component-owner process with OS-backed Windows Job Object, preventing
children from outliving the supervisor. Does not kill by PID, uses no shells,
and fails closed if child assignment or startup health verification fails.

`singularity-windows-supervisor check C:\path\private-stack.json` validates
JSON without starting processes. `run` starts the explicitly listed components
in order and stays foreground until a child exits. Intended for a dedicated
Windows per-user startup task *after* Windows acceptance, not an SCM service.

Config format: `singularity-rust-supervisor/v1`, numeric `variant` 1-4,
`repoqlVersion` exactly `1.7.18`, `components` entries with `id`, absolute
`executable`, `args` array, absolute `workingDir`, optional nonsecret `env`
object, and optional `health` containing `port`, `path`, `readyTimeoutMs`.
Health probes are loopback-only HTTP 200 checks with a bounded timeout.

**Known limitations and release blockers:** no auto-restart, authenticated
health proof, event log, cross-process stop protocol, signing, service lifetime
registration or rollback of service state. Any existing process on a health
port could falsely satisfy an HTTP-only check; the installer must independently
prove listener ownership on Windows. The per-user staging installer does not
install this executable or register startup tasks. A build and live kill/reboot
acceptance test are mandatory before shipping. No WSL.
