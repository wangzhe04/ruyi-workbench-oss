"""Isolated/offline preflight, then execute the unmodified pinned converter."""
import json
import os
import pathlib
import runpy
import socket
import sys

sys.stdout.reconfigure(encoding="utf8")
sys.stderr.reconfigure(encoding="utf8")
root, source, output = (pathlib.Path(x).resolve() for x in sys.argv[1:4])
sandbox = root / "conversion-sandbox-v1"
if json.loads((sandbox / "OWNER.json").read_text())["owner"] != "sol_semantic_runtime":
    raise ValueError("Conversion sandbox marker mismatch")
environment = {}
for key in ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HF_HOME", "TEMP", "TMP", "XDG_CACHE_HOME"]:
    value = pathlib.Path(os.environ[key]).resolve()
    if not value.is_absolute() or sandbox != value and sandbox not in value.parents:
        raise ValueError("Non-owner conversion environment: " + key)
    environment[key] = str(value)
if os.environ.get("HF_HUB_OFFLINE") != "1" or os.environ.get("TRANSFORMERS_OFFLINE") != "1":
    raise ValueError("Offline mode not explicit")


def deny_network(*args, **kwargs):
    raise RuntimeError("CONVERTER_NETWORK_DISABLED")


socket.create_connection = deny_network
socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
socket.getaddrinfo = deny_network
from transformers import AutoConfig, AutoTokenizer
from transformers.utils.hub import is_offline_mode
import torch

model = root / "source/Qwen3-Reranker-0.6B"
assert is_offline_mode()
config = AutoConfig.from_pretrained(model, local_files_only=True, trust_remote_code=False)
tokenizer = AutoTokenizer.from_pretrained(model, local_files_only=True, trust_remote_code=False)
assert config.architectures == ["Qwen3ForCausalLM"] and config.tie_word_embeddings
assert tokenizer.convert_tokens_to_ids("yes") == 9693 and tokenizer.convert_tokens_to_ids("no") == 2152
torch.set_num_threads(2)
torch.set_num_interop_threads(1)
assert torch.version.cuda is None
preflight = {"status": "PASS", "pythonIsolated": sys.flags.isolated, "pythonNoUserSite": sys.flags.no_user_site,
             "environment": environment, "socketNetworkDenied": True, "localFilesOnlyExplicitlyTested": True,
             "transformersOfflineForcesLocalFilesOnly": is_offline_mode(), "torchVersion": torch.__version__,
             "cudaVersion": torch.version.cuda, "torchThreads": torch.get_num_threads(), "tokenIds": {"yes": 9693, "no": 2152}}
with open(root / "conversion-preflight.json", "x", encoding="utf8") as stream:
    json.dump(preflight, stream, indent=2)
    stream.write("\n")
sys.path.insert(0, str(source))
sys.argv = [str(source / "convert_hf_to_gguf.py"), str(model), "--outtype", "f16", "--outfile", str(output)]
runpy.run_path(sys.argv[0], run_name="__main__")
