"""Supervisor for omb_office_bridge.py: restart after the bridge stops (OMB or Office restarted)."""
import argparse, os, subprocess, sys, time

def port_number(value):
    try:
        port = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError('port must be an integer') from None
    if not 1024 <= port <= 65534:
        raise argparse.ArgumentTypeError('port must be between 1024 and 65534')
    return port

parser = argparse.ArgumentParser()
parser.add_argument('--openmausbot-port', type=port_number, default=None,
                    help='local service port; overrides OMB_ORIGIN when supplied')
args = parser.parse_args()
here = os.path.dirname(os.path.abspath(__file__))
env = dict(os.environ)
if args.openmausbot_port is not None:
    env['OMB_ORIGIN'] = 'http://127.0.0.1:' + str(args.openmausbot_port)
local = os.environ.get("LOCALAPPDATA", "")
env.setdefault("OFFICE_KEYS_JSON", os.path.join(local, "Singularity", "WindowsNative", "office", "state", "keys.json"))
while True:
    result = subprocess.run([sys.executable, os.path.join(here, "omb_office_bridge.py")], env=env,
                            creationflags=0x08000000, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode == 2:
        sys.exit(2)
    time.sleep(30)
