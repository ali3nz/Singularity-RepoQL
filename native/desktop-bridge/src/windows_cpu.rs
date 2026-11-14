//! Native Windows CPU measurement. No WSL, Powershell, /proc or shell parsing.
//! Uses GetSystemTimes and GetProcessTimes over an actual sample interval.
//! Process CPU is normalized to the entire machine (not one logical core).
use serde_json::{json, Value};
#[cfg(windows)]
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(any(windows, test))]
fn percentage(busy: u64, total: u64) -> Option<f64> {
    if total == 0 {
        return None;
    }
    Some(((busy as f64 * 100.0 / total as f64).clamp(0.0, 100.0) * 100.0).round() / 100.0)
}

fn options(args: &[String]) -> Result<(Option<u32>, u64), &'static str> {
    let mut pid = None;
    let mut sample_ms = 250;
    let mut n = 0;
    while n < args.len() {
        match args[n].as_str() {
            "--pid" if pid.is_none() => {
                let value = args.get(n + 1).ok_or("missing --pid value")?;
                let parsed = value.parse::<u32>().map_err(|_| "invalid --pid value")?;
                if parsed == 0 {
                    return Err("invalid --pid value");
                }
                pid = Some(parsed);
            }
            "--sample-ms" => {
                let value = args.get(n + 1).ok_or("missing --sample-ms value")?;
                sample_ms = value
                    .parse::<u64>()
                    .map_err(|_| "invalid sample interval")?;
                if !(100..=1000).contains(&sample_ms) {
                    return Err("invalid sample interval");
                }
            }
            _ => return Err("unsupported CPU probe argument"),
        }
        n += 2;
    }
    Ok((pid, sample_ms))
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use std::thread;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    impl FileTime {
        fn ticks(self) -> u64 {
            ((self.high as u64) << 32) | self.low as u64
        }
    }
    type Handle = *mut c_void;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemTimes(idle: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn GetProcessTimes(
            process: Handle,
            created: *mut FileTime,
            exited: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    struct OwnedHandle(Handle);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn system_times() -> Option<(u64, u64)> {
        let (mut idle, mut kernel, mut user) = (
            FileTime::default(),
            FileTime::default(),
            FileTime::default(),
        );
        if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
            return None;
        }
        Some((idle.ticks(), kernel.ticks().saturating_add(user.ticks())))
    }
    fn process_ticks(handle: Handle) -> Option<(u64, u64)> {
        let (mut created, mut exited, mut kernel, mut user) = (
            FileTime::default(),
            FileTime::default(),
            FileTime::default(),
            FileTime::default(),
        );
        if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
            == 0
        {
            return None;
        }
        Some((kernel.ticks().saturating_add(user.ticks()), created.ticks()))
    }
    pub(super) fn measure(pid: Option<u32>, duration_ms: u64) -> Value {
        let handle = pid.and_then(|id| {
            let ptr = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, id) };
            if ptr.is_null() {
                None
            } else {
                Some(OwnedHandle(ptr))
            }
        });
        let a = system_times();
        let proc_a = handle.as_ref().and_then(|h| process_ticks(h.0));
        thread::sleep(Duration::from_millis(duration_ms));
        let b = system_times();
        let proc_b = handle.as_ref().and_then(|h| process_ticks(h.0));
        let sampled_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if let (Some((idle_a, all_a)), Some((idle_b, all_b))) = (a, b) {
            let total = all_b.saturating_sub(all_a);
            let idle = idle_b.saturating_sub(idle_a);
            let system = percentage(total.saturating_sub(idle), total);
            let process_identity =
                proc_a
                    .zip(proc_b)
                    .and_then(|((_, created_a), (_, created_b))| {
                        if created_a != 0 && created_a == created_b {
                            Some(created_a)
                        } else {
                            None
                        }
                    });
            let process = proc_a
                .zip(proc_b)
                .and_then(|((x, created_a), (y, created_b))| {
                    if created_a != 0 && created_a == created_b {
                        percentage(y.saturating_sub(x), total)
                    } else {
                        None
                    }
                });
            let cores = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1);
            let per_core = process.map(|v| (v * cores as f64 * 100.0).round() / 100.0);
            json!({"available":system.is_some(), "source":"win32-system-process-times", "system_cpu_pct":system,
                   "process_cpu_pct":process, "process_per_core_pct":per_core,"logical_cores":cores,
                   "pid":pid,"process_created_filetime":process_identity,"sampled_at_unix":sampled_at,"sample_ms":duration_ms,
                   "process_scale":"percent-of-host-capacity"})
        } else {
            json!({"available":false,"reason":"win32_cpu_sampling_failed","pid":pid})
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    pub(super) fn measure(pid: Option<u32>, _duration_ms: u64) -> Value {
        json!({"available":false,"reason":"native_windows_required","pid":pid})
    }
}

pub fn run(args: &[String]) -> i32 {
    match options(args) {
        Ok((pid, sample_ms)) => {
            println!("{}", platform::measure(pid, sample_ms));
            0
        }
        Err(_) => {
            // No variable CLI value is reflected in the output or logs.
            println!(
                "{}",
                json!({"available":false,"reason":"invalid_cpu_probe_arguments"})
            );
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn percent_is_bounded_and_handles_zero_samples() {
        assert_eq!(percentage(0, 100), Some(0.0));
        assert_eq!(percentage(150, 100), Some(100.0));
        assert_eq!(percentage(1, 0), None);
        assert_eq!(percentage(1, 4), Some(25.0));
    }
    #[test]
    fn cpu_cli_rejects_injection_and_invalid_pids() {
        assert_eq!(
            options(&["--pid".into(), "123".into()]).unwrap(),
            (Some(123), 250)
        );
        assert!(options(&["--pid".into(), "1;rm".into()]).is_err());
        assert!(options(&["--pid".into(), "0".into()]).is_err());
        assert!(options(&["--sample-ms".into(), "5".into()]).is_err());
        assert!(options(&["--sample-ms".into(), "300".into()]).is_ok());
    }
}
