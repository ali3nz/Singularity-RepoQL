//! Restricted, fixed-operation test runner for Singularity maintenance stages.
//! Build as a debug component with rustc. This is not an installer.
#![cfg(windows)]

use std::ffi::{c_void, OsStr};
use std::fs::{self, File};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr::{null, null_mut};

type Handle = *mut c_void;
type Result<T> = std::result::Result<T, &'static str>;

#[repr(C)]
struct Guid { a: u32, b: u16, c: u16, d: [u8; 8] }
#[repr(C)]
struct SecurityCapabilities { sid: Handle, capabilities: Handle, count: u32, reserved: u32 }
#[repr(C)]
struct StartupInfo {
    cb: u32, reserved: *mut u16, desktop: *mut u16, title: *mut u16,
    x: u32, y: u32, width: u32, height: u32, chars_x: u32, chars_y: u32,
    fill: u32, flags: u32, show: u16, reserved_size: u16, reserved_data: *mut u8,
    stdin: Handle, stdout: Handle, stderr: Handle,
}
#[repr(C)]
struct StartupInfoEx { startup: StartupInfo, attributes: Handle }
#[repr(C)]
struct ProcessInfo { process: Handle, thread: Handle, pid: u32, tid: u32 }
#[repr(C)]
struct BasicLimits {
    process_time: i64, job_time: i64, flags: u32,
    minimum: usize, maximum: usize, processes: u32, affinity: usize,
    priority: u32, scheduling: u32,
}
#[repr(C)]
struct ExtendedLimits { basic: BasicLimits, io: [u64; 6], process_memory: usize,
    job_memory: usize, peak_process_memory: usize, peak_job_memory: usize }
#[repr(C)]
struct FileInfo { attributes: u32, created: [u32; 2], accessed: [u32; 2],
    written: [u32; 2], volume: u32, size_high: u32, size_low: u32,
    links: u32, index_high: u32, index_low: u32 }

#[link(name = "kernel32")]
unsafe extern "system" {
    fn InitializeProcThreadAttributeList(list: Handle, count: u32, flags: u32, size: *mut usize) -> i32;
    fn UpdateProcThreadAttribute(list: Handle, flags: u32, attribute: usize, value: Handle,
        size: usize, previous: Handle, returned: *mut usize) -> i32;
    fn DeleteProcThreadAttributeList(list: Handle);
    fn CreateProcessW(application: *const u16, command: *mut u16, process_security: Handle,
        thread_security: Handle, inherit: i32, flags: u32, environment: Handle,
        directory: *const u16, startup: *mut StartupInfoEx, process: *mut ProcessInfo) -> i32;
    fn CreateJobObjectW(security: Handle, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, kind: i32, information: Handle, length: u32) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn TerminateJobObject(job: Handle, code: u32) -> i32;
    fn TerminateProcess(process: Handle, code: u32) -> i32;
    fn ResumeThread(thread: Handle) -> u32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetStdHandle(which: u32) -> Handle;
    fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> i32;
    fn GetWindowsDirectoryW(path: *mut u16, length: u32) -> u32;
    fn GetFileInformationByHandle(file: Handle, information: *mut FileInfo) -> i32;
}
#[link(name = "userenv")]
unsafe extern "system" {
    fn CreateAppContainerProfile(name: *const u16, display: *const u16, description: *const u16,
        capabilities: Handle, count: u32, sid: *mut Handle) -> i32;
    fn DeriveAppContainerSidFromAppContainerName(name: *const u16, sid: *mut Handle) -> i32;
    fn DeleteAppContainerProfile(name: *const u16) -> i32;
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn ConvertSidToStringSidW(sid: Handle, text: *mut *mut u16) -> i32;
    fn FreeSid(sid: Handle) -> Handle;
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
    fn GetTokenInformation(token: Handle, kind: i32, information: Handle,
        length: u32, returned: *mut u32) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" { fn LocalFree(memory: Handle) -> Handle; }
#[link(name = "shell32")]
unsafe extern "system" {
    fn SHGetKnownFolderPath(id: *const Guid, flags: u32, token: Handle, path: *mut *mut u16) -> i32;
}
#[link(name = "ole32")]
unsafe extern "system" { fn CoTaskMemFree(memory: Handle); }

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
unsafe fn wide_string(value: *const u16) -> String {
    let mut length = 0;
    while *value.add(length) != 0 { length += 1; }
    String::from_utf16_lossy(std::slice::from_raw_parts(value, length))
}
fn local_app_data() -> Result<PathBuf> {
    let id = Guid { a: 0xf1b32785, b: 0x6fba, c: 0x4fcf,
        d: [0x9d, 0x55, 0x7b, 0x8e, 0x7f, 0x15, 0x70, 0x91] };
    let mut path = null_mut();
    unsafe {
        if SHGetKnownFolderPath(&id, 0, null_mut(), &mut path) != 0 { return Err("known-folder"); }
        let result = PathBuf::from(wide_string(path));
        CoTaskMemFree(path.cast());
        Ok(result)
    }
}
fn windows_directory() -> Result<PathBuf> {
    let mut buffer = vec![0u16; 32768];
    let length = unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() { return Err("windows-directory"); }
    Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..length])))
}
fn regular_path(path: &Path) -> Result<PathBuf> {
    let text = path.to_str().ok_or("path-encoding")?;
    if text.len() > 240 || !path.is_absolute() || text.get(2..).unwrap_or("").contains(':') {
        return Err("path-shape");
    }
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| "path-metadata")?;
        if metadata.file_attributes() & 0x400 != 0 { return Err("reparse-path"); }
    }
    let canonical = fs::canonicalize(path).map_err(|_| "path-canonical")?;
    let normalized = canonical.to_str().ok_or("path-encoding")?.strip_prefix(r"\\?\")
        .ok_or("path-prefix")?;
    Ok(PathBuf::from(normalized))
}
fn inspect_tree(path: &Path, entries: &mut usize) -> Result<()> {
    *entries += 1;
    if *entries > 10000 { return Err("stage-size"); }
    regular_path(path)?;
    let metadata = fs::metadata(path).map_err(|_| "stage-metadata")?;
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|_| "stage-directory")? {
            inspect_tree(&entry.map_err(|_| "stage-entry")?.path(), entries)?;
        }
    } else if metadata.is_file() {
        let file = File::open(path).map_err(|_| "stage-file")?;
        let mut information: FileInfo = unsafe { zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 || information.links != 1 {
            return Err("stage-file-alias");
        }
    } else { return Err("stage-file-type"); }
    Ok(())
}
fn acl(windows: &Path, path: &Path, sid: &str, permission: Option<&str>) -> Result<()> {
    let mut command = Command::new(windows.join("System32/icacls.exe"));
    command.arg(path);
    match permission {
        Some(value) => { command.args(["/grant", &format!("*{sid}:{value}")]); }
        None => { command.args(["/remove:g", &format!("*{sid}")]); }
    }
    if path.is_dir() { command.arg("/T"); }
    if !command.output().map_err(|_| "acl-launch")?.status.success() { return Err("acl-update"); }
    Ok(())
}
fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut backslashes = 0;
    for character in value.chars() {
        if character == '\\' { backslashes += 1; continue; }
        result.push_str(&"\\".repeat(if character == '"' { backslashes * 2 + 1 } else { backslashes }));
        result.push(character);
        backslashes = 0;
    }
    result.push_str(&"\\".repeat(backslashes * 2));
    result.push('"');
    result
}

struct Resources {
    name: String, sid: Handle, sid_text: String, windows: PathBuf,
    grants: Vec<PathBuf>, job: Handle, process: Handle, cleaned: bool,
}
impl Resources {
    fn cleanup(&mut self) -> Result<()> {
        unsafe {
            if !self.job.is_null() { TerminateJobObject(self.job, 1); }
            if !self.process.is_null() {
                // Covers a setup failure before job assignment as well.
                TerminateProcess(self.process, 1);
                WaitForSingleObject(self.process, 5000);
                CloseHandle(self.process);
                self.process = null_mut();
            }
            if !self.job.is_null() { CloseHandle(self.job); self.job = null_mut(); }
        }
        for path in self.grants.iter().rev() { acl(&self.windows, path, &self.sid_text, None)?; }
        self.grants.clear();
        if unsafe { DeleteAppContainerProfile(wide(&self.name).as_ptr()) } != 0 {
            return Err("profile-cleanup");
        }
        unsafe { FreeSid(self.sid); }
        self.sid = null_mut();
        self.cleaned = true;
        Ok(())
    }
}
impl Drop for Resources {
    fn drop(&mut self) { if !self.cleaned && self.cleanup().is_err() { eprintln!("SANDBOX_CLEANUP_PENDING"); } }
}

fn child_arguments(operation: &str, root: &Path, stage: &Path, node: &Path) -> Result<Vec<String>> {
    let path = |value: &Path| value.to_string_lossy().into_owned();
    match operation {
        "fixture" => Ok(vec!["--test".into(), "acceptance.test.mjs".into()]),
        "maintainer" => Ok(vec!["--test".into(),
            "native/windows/openmausbot/maintenance_audit.test.mjs".into(),
            "native/windows/openmausbot/maintenance_repair.test.mjs".into(),
            "native/windows/openmausbot/provision_maintainer.test.mjs".into(),
            "native/windows/openmausbot/omb_chat.test.mjs".into()]),
        "boundary" => {
            let code = r#"const fs=require('node:fs'),net=require('node:net');
const r={};for(const [label,p] of Object.entries({stageWrite:process.argv[1]+'/allowed.txt',activeWrite:process.argv[2]+'/current/source/.maintainer-boundary-test',outsideWrite:process.argv[2]+'/maintenance/acceptance/outside.txt',protectedWrite:process.argv[2]+'/maintenance/acceptance/protected/credential-shaped.txt'})){try{fs.writeFileSync(p,'boundary-fixture');r[label]=true}catch(e){r[label]=false;r[label+'Error']=e.code}}
try{fs.readFileSync(process.argv[2]+'/maintenance/acceptance/protected/credential-shaped.txt');r.protectedRead=true}catch(e){r.protectedRead=false;r.protectedReadError=e.code}
function connect(label,host,port){return new Promise(resolve=>{const s=net.connect({host,port});s.on('connect',()=>{r[label]=true;s.destroy();resolve()});s.on('error',e=>{r[label]=false;r[label+'Error']=e.code;resolve()});s.setTimeout(3000,()=>{r[label]='timeout';s.destroy();resolve()})})}
Promise.all([connect('loopback','127.0.0.1',18211),connect('external','1.1.1.1',443)]).then(()=>console.log(JSON.stringify(r)));"#;
            Ok(vec!["-e".into(), code.into(), path(stage), path(root)])
        }
        "boundary-timeout" => Ok(vec!["-e".into(),
            "const fs=require('node:fs'),cp=require('node:child_process');const p=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('descendant.pid',String(p.pid));setInterval(()=>{},1000)".into()]),
        "fail-setup" | "cleanup" => Ok(vec![]),
        _ => Err("operation-not-allowed"),
    }.map(|mut arguments| { arguments.insert(0, path(node)); arguments })
}

fn execute() -> Result<u32> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.len() != 2 { return Err("usage"); }
    let operation = &arguments[0];
    let local = regular_path(&local_app_data()?)?;
    let root = regular_path(&local.join("Singularity/WindowsNative"))?;
    let stages = regular_path(&root.join("maintenance/stages"))?;
    let stage = regular_path(Path::new(&arguments[1]))?;
    let job_id = stage.parent().and_then(Path::file_name).and_then(OsStr::to_str).ok_or("stage-id")?;
    if stage.file_name() != Some(OsStr::new("content")) || job_id.len() != 32 ||
        !job_id.bytes().all(|value| value.is_ascii_hexdigit()) || stage.parent().and_then(Path::parent) != Some(stages.as_path()) {
        return Err("stage-scope");
    }
    inspect_tree(&stage, &mut 0)?;
    let node = regular_path(&local.join("Singularity/Runtime/node/node.exe"))?;
    let child = child_arguments(operation, &root, &stage, &node)?;
    let windows = windows_directory()?;
    let name = format!("SingularityMaintainer_{job_id}");
    let mut sid = null_mut();
    unsafe {
        if operation == "cleanup" {
            if DeriveAppContainerSidFromAppContainerName(wide(&name).as_ptr(), &mut sid) != 0 { return Err("profile-derive"); }
        } else if CreateAppContainerProfile(wide(&name).as_ptr(), wide(&name).as_ptr(),
            wide("Singularity isolated maintenance test").as_ptr(), null_mut(), 0, &mut sid) != 0 {
            return Err("profile-create");
        }
    }
    let mut sid_text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut sid_text) } == 0 {
        unsafe { DeleteAppContainerProfile(wide(&name).as_ptr()); FreeSid(sid); }
        return Err("profile-sid");
    }
    let mut resources = Resources { name, sid, sid_text: unsafe { wide_string(sid_text) },
        windows, grants: vec![], job: null_mut(), process: null_mut(), cleaned: false };
    unsafe { LocalFree(sid_text.cast()); }
    if operation == "cleanup" {
        resources.grants = vec![node, stage];
        resources.cleanup()?;
        eprintln!("{\"sandboxCleanup\":true}");
        return Ok(0);
    }
    for (path, permission) in [(&node, "(RX)"), (&stage, "(OI)(CI)(M)")] {
        // Record first so a partial ACL update is removed on the failure path.
        resources.grants.push(path.clone());
        acl(&resources.windows, path, &resources.sid_text, Some(permission))?;
    }
    if operation == "fail-setup" { return Err("injected-setup-failure"); }
    inspect_tree(&stage, &mut 0)?;
    fs::create_dir_all(stage.join(".tmp")).map_err(|_| "temporary-directory")?;
    fs::create_dir_all(stage.join(".home")).map_err(|_| "home-directory")?;
    let environment = format!("SystemRoot={}\0WINDIR={}\0PATH={}\0TEMP={}\0TMP={}\0USERPROFILE={}\0LOCALAPPDATA={}\0APPDATA={}\0SINGULARITY_SANDBOX_TEST=1\0\0",
        resources.windows.display(), resources.windows.display(), resources.windows.join("System32").display(),
        stage.join(".tmp").display(), stage.join(".tmp").display(), stage.join(".home").display(),
        stage.join(".home").display(), stage.join(".home").display());
    let mut environment: Vec<u16> = environment.encode_utf16().collect();
    let mut command = wide(child.iter().map(|value| quote(value)).collect::<Vec<_>>().join(" "));
    unsafe {
        let mut size = 0;
        InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size);
        let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
        let attributes = storage.as_mut_ptr().cast();
        if InitializeProcThreadAttributeList(attributes, 2, 0, &mut size) == 0 { return Err("attributes-create"); }
        let mut capabilities = SecurityCapabilities { sid, capabilities: null_mut(), count: 0, reserved: 0 };
        let updated = UpdateProcThreadAttribute(attributes, 0, 0x20009, (&mut capabilities as *mut SecurityCapabilities).cast(),
            size_of::<SecurityCapabilities>(), null_mut(), null_mut());
        if updated == 0 { DeleteProcThreadAttributeList(attributes); return Err("capabilities-create"); }
        let mut startup: StartupInfoEx = zeroed();
        startup.startup.cb = size_of::<StartupInfoEx>() as u32;
        startup.startup.flags = 0x100;
        startup.startup.stdin = GetStdHandle(-10i32 as u32);
        startup.startup.stdout = GetStdHandle(-11i32 as u32);
        startup.startup.stderr = GetStdHandle(-12i32 as u32);
        let mut inherited = [startup.startup.stdin, startup.startup.stdout, startup.startup.stderr];
        if inherited.iter().any(|handle| handle.is_null() || *handle as isize == -1 || SetHandleInformation(*handle, 1, 1) == 0) ||
            UpdateProcThreadAttribute(attributes, 0, 0x20002, inherited.as_mut_ptr().cast(),
                size_of::<Handle>() * inherited.len(), null_mut(), null_mut()) == 0 {
            DeleteProcThreadAttributeList(attributes); return Err("stdio-inheritance");
        }
        startup.attributes = attributes;
        let mut process: ProcessInfo = zeroed();
        let created = CreateProcessW(wide(&node).as_ptr(), command.as_mut_ptr(), null_mut(), null_mut(), 1,
            0x80000 | 0x400 | 0x4 | 0x08000000, environment.as_mut_ptr().cast(), wide(&stage).as_ptr(), &mut startup, &mut process);
        DeleteProcThreadAttributeList(attributes);
        if created == 0 { return Err("restricted-process-create"); }
        resources.process = process.process;
        let mut token = null_mut();
        let mut app_container = 0u32;
        let mut returned = 0;
        let mut token_capabilities = vec![0u32; 1024];
        let token_ok = OpenProcessToken(process.process, 8, &mut token) != 0 &&
            GetTokenInformation(token, 29, (&mut app_container as *mut u32).cast(), 4, &mut returned) != 0 &&
            GetTokenInformation(token, 30, token_capabilities.as_mut_ptr().cast(), 4096, &mut returned) != 0;
        if !token.is_null() { CloseHandle(token); }
        if !token_ok || app_container != 1 || token_capabilities[0] != 0 {
            CloseHandle(process.thread); return Err("restricted-token-verification");
        }
        resources.job = CreateJobObjectW(null_mut(), null());
        let mut limits: ExtendedLimits = zeroed();
        limits.basic.flags = 0x2000 | 0x8 | 0x100 | 0x200;
        limits.basic.processes = 16;
        limits.process_memory = 512 * 1024 * 1024;
        limits.job_memory = 1024 * 1024 * 1024;
        if resources.job.is_null() || SetInformationJobObject(resources.job, 9,
            (&mut limits as *mut ExtendedLimits).cast(), size_of::<ExtendedLimits>() as u32) == 0 ||
            AssignProcessToJobObject(resources.job, process.process) == 0 {
            CloseHandle(process.thread); return Err("restricted-job-assignment");
        }
        if ResumeThread(process.thread) == u32::MAX { CloseHandle(process.thread); return Err("restricted-process-resume"); }
        CloseHandle(process.thread);
        let waited = WaitForSingleObject(process.process, if operation == "boundary-timeout" { 1000 } else { 60000 });
        let mut code = 125;
        if waited == 258 { code = 124; }
        else if waited != 0 || GetExitCodeProcess(process.process, &mut code) == 0 { return Err("restricted-process-wait"); }
        resources.cleanup()?;
        eprintln!("{\"appContainer\":true,\"capabilities\":0,\"sandboxCleanup\":true}");
        Ok(code)
    }
}

fn main() {
    match execute() {
        Ok(code) => std::process::exit(code as i32),
        Err(reason) => { eprintln!("SINGULARITY_SANDBOX_REFUSED:{reason}"); std::process::exit(125); }
    }
}
