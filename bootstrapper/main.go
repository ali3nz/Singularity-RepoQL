// Singularity RepoQL Developer Setup: a self-contained Windows-native launcher.
// It can compile and install the project-owned MSI when MSVC Rust + dotnet +
// Python are present. A public release should instead ship the WiX Burn bundle
// built on an accepted Windows CI runner with precompiled binaries.
package main

import (
 "archive/zip"
 "bufio"
 "bytes"
 "crypto/sha256"
 "embed"
 "encoding/hex"
 "errors"
 "flag"
 "fmt"
 "io"
 "os"
 "os/exec"
 "path/filepath"
 "runtime"
 "strings"
 "time"
)

//go:embed source.zip installerkit/*
var embedded embed.FS

const pinnedSource = "a7b18e7e7bf7debab22d1a20c4a511768b60e926348f41f560c66fd9e0db46f5"

func sha(b []byte) string { a:=sha256.Sum256(b); return hex.EncodeToString(a[:]) }

func verifyEmbedded() ([]byte,error) {
 source,e:=embedded.ReadFile("source.zip");if e!=nil{return nil,e}
 if sha(source)!=pinnedSource{return nil,errors.New("pinned source archive hash mismatch")}
 r,e:=zip.NewReader(bytes.NewReader(source),int64(len(source)));if e!=nil{return nil,e}
 seen:=map[string]bool{}
 for _,f:=range r.File {
  n:=f.Name
  if n==""||strings.HasPrefix(n,"/")||strings.Contains(n,"\\")||strings.Contains(n,":")||strings.Contains(n,"//")||strings.HasSuffix(n,"/") {return nil,fmt.Errorf("unsafe ZIP member")}
  for _,s:=range strings.Split(n,"/"){if s=="."||s==".."||s=="" {return nil,errors.New("unsafe ZIP segment")}}
  folded:=strings.ToLower(n);if seen[folded]{return nil,errors.New("Windows ZIP path collision")};seen[folded]=true
  if f.UncompressedSize64>96*1024*1024{return nil,errors.New("unbounded ZIP member")}
  // Validate CRCs of the original archive before running a child command.
  rc,e:=f.Open();if e!=nil{return nil,e};_,e=io.Copy(io.Discard,io.LimitReader(rc,96*1024*1024+1));closeErr:=rc.Close()
  if e!=nil{return nil,e};if closeErr!=nil{return nil,closeErr}
 }
 return source,nil
}

func writeInputs(root string,source []byte) error {
 if err:=os.MkdirAll(root,0700);err!=nil{return err}
 if err:=os.WriteFile(filepath.Join(root,"source.zip"),source,0600);err!=nil{return err}
 names:=[]string{"build-msi.ps1","build-exe.ps1","SingularityRepoQL.wxs","SingularityRepoQLBundle.wxs","prepare_msi_payload.py","Start-Here.ps1","README-MSI.md","Configure-Singularity.ps1","Configure-Singularity.cmd","Readiness.ps1"}
 kit:=filepath.Join(root,"installer")
 if err:=os.MkdirAll(kit,0700);err!=nil{return err}
 for _,name:=range names {
  b,err:=embedded.ReadFile("installerkit/"+name);if err!=nil{return err}
  if err:=os.WriteFile(filepath.Join(kit,name),b,0600);err!=nil{return err}
 }
 return nil
}

func run(name string,args ...string) error {
 command:=exec.Command(name,args...)
 command.Stdin=os.Stdin;command.Stdout=os.Stdout;command.Stderr=os.Stderr
 if err:=command.Run();err!=nil{return fmt.Errorf("%s failed: %w",filepath.Base(name),err)}
 return nil
}

func toolAvailable(name string) bool {_,e:=exec.LookPath(name);return e==nil}
func main() { if e:=execute();e!=nil{fmt.Fprintln(os.Stderr,"SETUP NOT COMPLETED:",e);os.Exit(1)} }
func execute() error {
 check:=flag.Bool("check",false,"Inspect the embedded source and show build prerequisites without installing")
 configure:=flag.Bool("configure",false,"Run the installed per-user credential wizard only")
 install:=flag.Bool("install",false,"Build and install the native Windows MSI, then open first-run wizard")
 flag.Parse()
 source,err:=verifyEmbedded();if err!=nil{return err}
 fmt.Printf("Singularity RepoQL Setup Developer Preview\nSource verified: SHA256 %s\n",pinnedSource)
 if runtime.GOOS!="windows" { if *check{return nil};return errors.New("native Windows required") }
 installedWizard:=filepath.Join(os.Getenv("ProgramFiles"),"Singularity RepoQL","Configure-Singularity.ps1")
 if *configure {if _,e:=os.Stat(installedWizard);e!=nil{return errors.New("install the Singularity application files first")};return run("powershell.exe","-NoProfile","-ExecutionPolicy","Bypass","-File",installedWizard,"-Mode","Wizard")}
 required:=[]string{"powershell.exe","cargo.exe","rustc.exe","dotnet.exe","py.exe","msiexec.exe"}
 missing:=[]string{}
 for _,name:=range required {if !toolAvailable(name){missing=append(missing,name)}}
 if len(missing)>0 {fmt.Println("Missing Windows build prerequisites:",strings.Join(missing,", "))}
 if *check{return nil}
 if len(missing)>0{return errors.New("cannot build native MSI without the listed prerequisites")}
 if !*install {
  fmt.Println("This will compile native Windows binaries, install project application files, then open Tencent credential setup.")
  fmt.Print("Continue with native build and installation? [y/N] ")
  answer,_:=bufio.NewReader(os.Stdin).ReadString('\n')
  if strings.TrimSpace(strings.ToLower(answer))!="y" {fmt.Println("No changes made.");return nil}
 }
 home:=os.Getenv("LOCALAPPDATA");if home==""{return errors.New("LOCALAPPDATA is unavailable")}
 root:=filepath.Join(home,"Singularity","SetupBuilds",time.Now().UTC().Format("20060102T150405Z"))
 if _,e:=os.Stat(root);e==nil{return errors.New("build folder already exists")}
 if err:=writeInputs(root,source);err!=nil{return err}
 output:=filepath.Join(root,"output")
 if err:=os.MkdirAll(output,0700);err!=nil{return err}
 fmt.Println("Building pinned Windows binaries and MSI; installation files:",root)
 builder:=filepath.Join(root,"installer","build-msi.ps1")
 if err:=run("powershell.exe","-NoProfile","-ExecutionPolicy","Bypass","-File",builder,"-SourceZip",filepath.Join(root,"source.zip"),"-BuildRoot",filepath.Join(root,"msi-build"),"-OutputDirectory",output);err!=nil{return err}
 msi:=filepath.Join(output,"Singularity-RepoQL-Windows-Preview-x64.msi")
 if _,err:=os.Stat(msi);err!=nil{return errors.New("MSI build reported success but produced no MSI")}
 fmt.Println("Running Windows Installer. Windows may request elevation.")
 if err:=run("msiexec.exe","/i",msi,"/passive","/norestart");err!=nil{return err}
 if _,err:=os.Stat(installedWizard);err!=nil{return errors.New("MSI completed but the first-run wizard is missing")}
 fmt.Println("Launching per-user Tencent and extraction provider configuration wizard.")
 if err:=run("powershell.exe","-NoProfile","-ExecutionPolicy","Bypass","-File",installedWizard,"-Mode","Wizard");err!=nil{return err}
 fmt.Println("Application files and credentials are staged. Native service and Claude/Kanzo acceptance still require the project lifecycle checks.")
 return nil
}
