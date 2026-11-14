use serde_json::{json, Value};
use std::path::{Path, PathBuf};
mod archive;
mod classifier;
mod staged_tree;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let err=match args.get(1).map(String::as_str){
        Some("partition")=>{
            if args.len()!=3 {Some("usage: source-packager partition REPO_ROOT".to_string())}
            else {match classifier::walk_shipped_files(Path::new(&args[2])){
                Ok(files)=>{println!("{}",classifier::partition_json(&files));None},Err(e)=>Some(e)} }
        },
        Some("scan")=>{
            if args.len()<3 {Some("usage: source-packager scan ZIP [ZIP ...]".into())}
            else {let paths=args[2..].iter().map(PathBuf::from).collect::<Vec<_>>();
                let (results,ok)=archive::scan_many(&paths);
                println!("{}",serde_json::to_string_pretty(&results).unwrap_or_default());
                if ok{None}else{Some("one or more source archives failed validation".into())}}
        },
        Some("build")=>{
            if args.len()<4 || args.len()>5 {Some("usage: source-packager build REPO_ROOT OUTPUT_DIR [FULL_PROFILE_2]".into())}
            else {let variant=args.get(4).map(|s|s.parse::<u8>()).transpose();
                match variant {Err(_)=>Some("invalid variant".into()),Ok(only)=>{
                    match archive::build_all(Path::new(&args[2]),Path::new(&args[3]),only){
                        Ok(v)=>{println!("{}",serde_json::to_string_pretty(&v).unwrap_or_default());None},
                        Err(e)=>Some(e)}
                }} }
        },
        Some("classify")=>{
            if args.len()!=3 {Some("usage: source-packager classify RELATIVE_PATH".into())}
            else {let c=classifier::classify(&args[2]);
                println!("{}",json!({"path":args[2],"component":c,"windowsRetired":classifier::windows_retired_source(&args[2]),
                "windowsOffice":classifier::windows_office_source(&args[2]),"linuxAsset":classifier::linux_deployment_asset(&args[2])}));
                if c.is_some(){None}else{Some("unclassified source path".into())}}
        },
        Some("promote-pending")=>{
            if args.len()!=4 || !cfg!(windows) {Some("promote-pending requires native Windows, install root and pending name".into())}
            else {
                match staged_tree::promote_pending(Path::new(&args[2]), &args[3]) {
                    Ok(())=>{println!("STAGING_PROMOTED");None},
                    Err(code)=>{println!("{code}");Some("Windows staging promotion refused".into())}
                }
            }
        },
        Some("verify-snapshot")=>{
            if args.len()!=3 {Some("usage: source-packager verify-snapshot STAGING_ROOT".into())}
            else {let (result,ok)=staged_tree::verify_snapshot(Path::new(&args[2]));
                println!("{result}");
                if ok{None}else{Some("Windows staging integrity refused".into())}}
        },
        Some("verify-extracted")=>{
            if args.len()!=3 {Some("usage: source-packager verify-extracted EXTRACTED_SOURCE_ROOT".into())}
            else {let (result,ok)=staged_tree::verify(Path::new(&args[2]));
                println!("{}",serde_json::to_string_pretty(&result).unwrap_or_default());
                if ok{None}else{Some("extracted Windows source integrity refused".into())}}
        },
        Some("verify-policy")=>{
            if args.len()!=4 {Some("usage: source-packager verify-policy REPO_ROOT VARIANT".into())}
            else {match args[3].parse::<u8>() {
                Ok(variant)=>match classifier::walk_shipped_files(Path::new(&args[2])){
                    Ok(files)=>{
                        let p=classifier::Partition::for_files(&files);
                        match p.selected_for_windows(variant){
                            Ok(selected)=>{let counts=classifier::audit_component_counts(&files);
                                let result:Value=json!({"ok":true,"selected":selected.len(),"counts":counts});
                                println!("{result}");None},
                            Err(e)=>Some(e)}
                    },Err(e)=>Some(e)},Err(_)=>Some("invalid variant".into())}}
        },
        _=>Some("usage: source-packager {partition|scan|build|classify|verify-policy|verify-extracted|verify-snapshot|promote-pending} ...".into()),
    };
    if let Some(e) = err {
        eprintln!("{e}");
        std::process::exit(2)
    }
}
