"""Supervisor for omb_office_bridge.py: restart after the bridge stops (OMB or Office restarted)."""
import os, subprocess, sys, time
here = os.path.dirname(os.path.abspath(__file__))
env = dict(os.environ)
local = os.environ.get("LOCALAPPDATA", "")
env.setdefault("OFFICE_KEYS_JSON", os.path.join(local, "Singularity", "WindowsNative", "office", "state", "keys.json"))
while True:
    subprocess.run([sys.executable, os.path.join(here, "omb_office_bridge.py")], env=env,
                   creationflags=0x08000000, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(30)
