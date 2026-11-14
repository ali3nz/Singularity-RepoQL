//! Native Claude Code capability-question gate (fleet#1307; contract fleet#1304).
//! Only per-session routing metadata is retained, never prompts, answers or credentials.
use serde_json::{json, Value};
use std::{collections::HashMap, fs, io::{self, Read, Seek, SeekFrom}, path::{Path, PathBuf}};
const NEUTRAL: &str = "Unverified: no access conclusion is established. Consult current HubDocs/RepoQL and the owning service documentation; the acting identity, operation, scope and owning-surface evidence have not been verified.";
const LIMIT: u64 = 8 * 1024 * 1024;
fn words(s: &str) -> String { s.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() {c} else {' '}).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ") }
fn has(t: &str, p: &str) -> bool { format!(" {t} ").contains(&format!(" {p} ")) }
fn any(t: &str, ps: &[&str]) -> bool { ps.iter().any(|p| has(t,p)) }
fn classify(s: &str) -> Option<String> {
 let t=words(s);
 if any(&t,&["you said","you claimed","you wrote","you answered","you told me","did you say","did you claim","did you write","did you answer","your previous answer","your earlier answer","your last reply","your prior claim","quoted","verbatim","the old answer","earlier answer","in review","as an example","hypothetically"])
 && (!any(&t,&["now","currently","today","still","right now","these days"]) || any(&t,&["why","was that","did that","explain","review","incident report","quote"])) {return None;}
 if !any(&t,&["do you","can you","could you","are you","have you","does the fleet","do the fleet","do agents","can agents","do we","is there","is it possible to","did you"]) {return None;}
 if !any(&t,&["access","reach","permission","scope","connect","login","log in","signin","sign in","quota"]) && !t.split_whitespace().any(|w| w.starts_with("auth")) {return None;}
 let l=s.to_lowercase();
 Some(["google drive","onedrive","one drive","google calendar","home assistant","baidu","alist","gdrive","drive","calendar","github","grafana","homelable","browser","camofox","catgpt","mail sink","ssh","wordpress","updraft","quota","credential","api key","mcp"].iter().find(|s| l.contains(**s)).unwrap_or(&"this resource").to_string())
}
fn provenance(s: &str) -> bool {
 let t=words(s);
 let identity=s.split_whitespace().any(|w| w.contains('@') && w.split('@').nth(1).is_some_and(|v| v.contains('.')))
 || any(&t,&["service account","broker token","user token","sa token","credential"])
 || t.split_whitespace().collect::<Vec<_>>().windows(2).any(|w| w[0]=="as" && w[1].len()>=2);
 identity && any(&t,&["verified","unverified","documented","unconfirmed","live checked","re checked","rechecked"])
 && any(&t,&["read","reads","list","lists","search","upload","write","writes","create","delete","remove","mkdir","rm","probe","test","get","put","access","reach"])
 && any(&t,&["scope","read only","write access","read or write","no read","permission","permissions","rights","quota","limit"])
 && any(&t,&["access surfaces","hub doc","hub documentation","skill file","google drive md","google calendar md","gdrive py","gcal py","rclone conf","mcp json","repoql","rql","concept","concepts","probed","tested against"])
}
fn safe(p: &Path) -> io::Result<()> {
 for part in p.ancestors() {
  let m=fs::symlink_metadata(part)?;
  if m.file_type().is_symlink() {return Err(io::Error::other("unsafe path"));}
  #[cfg(windows)] {use std::os::windows::fs::MetadataExt; if m.file_attributes() & 0x400 != 0 {return Err(io::Error::other("unsafe path"));}}
 }
 Ok(())
}
fn state_path(root: &Path, session: &str) -> Option<PathBuf> {
 if session.is_empty() || session.len()>128 || !session.bytes().all(|c| c.is_ascii_alphanumeric() || c==b'-' || c==b'_') {return None;}
 Some(root.join("state").join(format!("{session}.json")))
}
fn save(p: &Path, v: &Value) -> io::Result<()> {
 safe(p.parent().ok_or_else(|| io::Error::other("missing parent"))?)?;
 if p.exists() {safe(p)?;}
 let temp=p.with_extension(format!("{}.tmp",std::process::id()));
 let mut f=fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
 use std::io::Write;
 f.write_all(serde_json::to_string(v)?.as_bytes())?;f.sync_all()?;drop(f);
 let out=fs::rename(&temp,p);if out.is_err(){let _=fs::remove_file(&temp);}out
}
fn instruction(subject: &str, root: &Path) -> String {
 format!("Capability retrieval gate: this question concerns {subject}. Before answering, use rql explore/read or the documentation Read tool to open current HubDocs agent-guides/access-surfaces.md AND the owning skill/service .md. RepoQL concepts supplement, never replace, owning docs. A bundled dated access index is at {}; it documents fleet capabilities, NOT grants for this Windows user. Probe only the surface that owns the operation; local tool absence is not fleet-wide absence. State acting identity, operation, scope/permission limit, verification status (live-verified/documented/unverified) and checked source. Do not expose credentials. Stop checks successful documentation tool results, not just claimed lookup text. If current docs/probes cannot be obtained, reply exactly: {NEUTRAL} Claude Code cannot retract already-streamed answers: one failed check permits correction, a second stops with an explicit unverified warning.",root.join("policy/access-surfaces.md").display())
}
fn documentation_kind(tool: &Value) -> Option<bool> {
 let name=tool["name"].as_str()?.to_lowercase();let input=&tool["input"];
 let path=if name=="read" {input["file_path"].as_str()?.to_string()}
 else if name.contains("repoql") && name.contains("read") {serde_json::to_string(input).ok()?}
 else if name=="bash" {let cmd=input["command"].as_str()?.trim();if !cmd.starts_with("rql read "){return None;}cmd.to_string()}
 else {return None;};
 let path=path.to_lowercase();
 if path.contains("access-surfaces.md") {Some(true)}
 else if path.contains(".md") && ["documentation","/skills/","/services/","/agent-guides/","/policy/"].iter().any(|x| path.contains(x)) {Some(false)} else {None}
}
fn evidence(text: &str) -> (bool,bool,String) {
 let mut calls=HashMap::<String,bool>::new();let (mut index,mut owner)=(false,false);let mut answer=String::new();
 for line in text.lines() {
  let Ok(v)=serde_json::from_str::<Value>(line) else {continue;};
  let Some(content)=v["message"]["content"].as_array() else {continue;};
  if v["type"]=="assistant" {
   let spoken=content.iter().filter_map(|b| if b["type"]=="text" {b["text"].as_str()} else {None}).collect::<Vec<_>>().join("\n");
   if !spoken.is_empty(){answer=spoken;}
   for b in content {if b["type"]=="tool_use" {if let (Some(id),Some(kind))=(b["id"].as_str(),documentation_kind(b)){calls.insert(id.to_string(),kind);}}}
  } else if v["type"]=="user" {
   for b in content {if b["type"]!="tool_result" || b["is_error"]==true {continue;}
    if let Some(kind)=b["tool_use_id"].as_str().and_then(|id| calls.remove(id)) {
     let result=serde_json::to_string(&b["content"]).unwrap_or_default();
     if result.len()>40 && !result.contains("Error:") && !result.contains("Refusing to index") {if kind{index=true}else{owner=true}}
    }
   }
  }
 }
 (index,owner,answer)
}
fn tail(state: &Value, input: &Value) -> io::Result<String> {
 let path=Path::new(input["transcript_path"].as_str().ok_or_else(||io::Error::other("missing transcript"))?);
 safe(path)?;let real=fs::canonicalize(path)?;
 if real.to_string_lossy()!=state["transcript"].as_str().unwrap_or(""){return Err(io::Error::other("rotated transcript"));}
 let start=state["offset"].as_u64().ok_or_else(||io::Error::other("offset"))?;
 let mut f=fs::File::open(path)?;let n=f.metadata()?.len();if n<start || n-start>LIMIT {return Err(io::Error::other("transcript bounds"));}
 f.seek(SeekFrom::Start(start))?;let mut text=String::new();f.take(LIMIT+1).read_to_string(&mut text)?;Ok(text)
}
fn stop_decision(good: bool, retry: bool) -> Value {
 if good {json!({})} else if retry {json!({"continue":false,"stopReason":NEUTRAL,"systemMessage":NEUTRAL})}
 else {json!({"decision":"block","reason":format!("Capability answer is not verified: read access-surfaces.md and the owning skill/service doc using real successful documentation tools, then state identity, operation, scope, verification status and source. Correct once, or answer exactly: {NEUTRAL}")})}
}
fn run(mode: &str, root: &Path, input: &Value) -> Value {
 let Some(p)=state_path(root,input["session_id"].as_str().unwrap_or("")) else{return json!({});};
 if mode=="prompt" {
  let Some(subject)=classify(input["prompt"].as_str().unwrap_or("")) else {let _=fs::remove_file(&p);return json!({});};
  let prepared=(||->io::Result<Value>{safe(root)?;let tr=Path::new(input["transcript_path"].as_str().ok_or_else(||io::Error::other("missing transcript"))?);safe(tr)?;
   Ok(json!({"schema":"singularity-capability-gate/v1","subject":subject,"transcript":fs::canonicalize(tr)?.to_string_lossy(),"offset":fs::metadata(tr)?.len(),"retries":0}))})();
  let armed=prepared.and_then(|v|save(&p,&v)).is_ok();
  return json!({"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":instruction(&subject,root)},"systemMessage":if armed {"Capability documentation/provenance check armed."}else{"Capability guidance supplied; completion enforcement unavailable for this session (state/transcript unavailable)."}});
 }
 // Missing/corrupt/unwritable state is not evidence of a routed turn. Never
 // block an unrelated session or loop because a state file disappeared.
 if safe(&p).is_err(){return json!({});}
 let Some(mut state)=fs::read(&p).ok().and_then(|b|serde_json::from_slice::<Value>(&b).ok()) else{return json!({});};
 if state["schema"]!="singularity-capability-gate/v1" {return json!({});}
 let Ok(text)=tail(&state,input) else{return json!({});};
 let(index,owner,last)=evidence(&text);let answer=input["last_assistant_message"].as_str().unwrap_or(&last);
 let good=answer.trim()==NEUTRAL || (index && owner && provenance(answer));
 let retry=input["stop_hook_active"]==true || state["retries"].as_u64().unwrap_or(0)>0;
 if !good && !retry {state["retries"]=json!(1);if save(&p,&state).is_err(){return json!({});}}
 stop_decision(good,retry)
}
fn main() {
 let a=std::env::args().skip(1).collect::<Vec<_>>();
 if a.len()!=3 || !["prompt","stop"].contains(&a[0].as_str()) || a[1]!="--root" || !Path::new(&a[2]).is_absolute(){std::process::exit(2);}
 let mut bytes=Vec::new();if io::stdin().take(2*1024*1024+1).read_to_end(&mut bytes).is_err() || bytes.len()>2*1024*1024 {std::process::exit(2);}
 let input=match serde_json::from_slice::<Value>(&bytes){Ok(v)=>v,Err(_)=>{if a[0]=="stop" {println!("{{}}");return;}std::process::exit(2);}};
 println!("{}",run(&a[0],Path::new(&a[2]),&input));
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn routes_capability_only(){for s in ["Do you have full access to my Google Drive?","Can agents connect to GitHub?","Can you access an unknown resource?"]{assert!(classify(s).is_some());}for s in ["Tail the dockerhost nginx logs","Can you explain GitHub pull requests?","Why did you say no Drive access in your earlier answer?"]{assert!(classify(s).is_none());}}
 #[test] fn live_followup(){assert!(classify("You said no Drive access. Do you have access now?").is_some());}
 #[test] fn provenance_contract(){assert!(!provenance("Yes"));assert!(!provenance("I verified no account has access"));assert!(provenance("Documented in Hub documentation: as Ben, read access has scope limited to fleet folders; not live-verified."));}
 #[test] fn successful_tools_required(){let lines=[json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"1","name":"Read","input":{"file_path":"C:/policy/access-surfaces.md"}},{"type":"tool_use","id":"2","name":"Read","input":{"file_path":"C:/policy/skills/google-drive.md"}}]}}),json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"1","content":"a documented fleet capability index with identities and scope limits"},{"type":"tool_result","tool_use_id":"2","is_error":true,"content":"Error: file unavailable"}]}})];let text=lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");assert_eq!((evidence(&text).0,evidence(&text).1),(true,false));assert!(!evidence("I read access-surfaces.md and the owning doc").0);}
 #[test] fn correction_is_bounded(){assert_eq!(stop_decision(false,false)["decision"],"block");assert_eq!(stop_decision(false,true)["continue"],false);assert!(stop_decision(true,true).get("decision").is_none());}
 #[test] fn session_names_and_unknown_stop(){assert!(state_path(Path::new("C:/test"),"../other").is_none());assert_eq!(run("stop",Path::new("missing-root"),&json!({"session_id":"unknown","stop_hook_active":true})),json!({}));}
}
