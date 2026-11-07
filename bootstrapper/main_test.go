package main
import "testing"
func TestPinnedArchive(t *testing.T){b,e:=verifyEmbedded();if e!=nil{t.Fatal(e)};if len(b)<1_000_000{t.Fatal("archive unexpectedly small")}}
func TestSHAStable(t *testing.T){if sha([]byte("abc"))!="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"{t.Fatal("SHA256 regression")}}
