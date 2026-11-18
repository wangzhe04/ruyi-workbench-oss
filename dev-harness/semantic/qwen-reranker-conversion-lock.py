"""Pin the original converter source against the approved source ZIP."""
import hashlib
import json
import pathlib
import zipfile

root = pathlib.Path("output/semantic-qwen-reranker-official-v1").resolve()
source = pathlib.Path("output/native-headless-qwen-research/source/llama.cpp-7fe450e19305b828c199d602c23a8337aaa1f03b").resolve()
archive = pathlib.Path("output/native-headless-qwen-research/llama-b11146-source.zip").resolve()


def sha(file):
    value = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


archive_sha = sha(archive)
if archive_sha != "8bffe21a3ecce942656e687eaa78276b8410653d740e8e6f1a3542b309706201":
    raise ValueError("Original source ZIP mismatch")
records = []
with zipfile.ZipFile(archive) as zipped:
    prefix = zipped.namelist()[0].split("/")[0] + "/"
    members = [name for name in zipped.namelist() if name.startswith(prefix) and not name.endswith("/")]
    for member in members:
        relative = member[len(prefix):]
        needed = relative in ["convert_hf_to_gguf.py", "LICENSE"] or relative.endswith(".py") and relative.startswith(("conversion/", "gguf-py/gguf/")) or relative.startswith("requirements/") and "convert" in relative
        if not needed:
            continue
        expected = hashlib.sha256(zipped.read(member)).hexdigest()
        actual = source / relative
        if not actual.is_file() or sha(actual) != expected:
            raise ValueError("Pinned converter source changed: " + relative)
        records.append({"path": relative, "bytes": actual.stat().st_size, "sha256": expected})
report = {"schemaVersion": 1, "commit": "7fe450e19305b828c199d602c23a8337aaa1f03b", "tag": "b11146",
          "archive": {"file": str(archive), "sha256": archive_sha}, "converterSource": str(source), "files": records,
          "recipe": {"entry": "convert_hf_to_gguf.py", "args": ["<owned>/source/Qwen3-Reranker-0.6B", "--outtype", "f16", "--outfile", "<owned>/artifacts/qwen3-reranker-0.6b-rank-f16.gguf"],
                     "quantize": ["<owned>/toolchain/quantizer/llama-quantize.exe", "<rank-f16.gguf>", "<rank-q4_k_m.gguf>", "Q4_K_M", "2"],
                     "detection": "Original README '# Qwen3-Reranker' or Qwen3-Reranker in model directory name triggers automatic RANK conversion; no custom converter patch or extra model.",
                     "head": "Original Qwen3Model._get_cls_out_tensor stacks source tied embedding rows [yes9693,no2152] as cls.output.weight. Native RANK softmax returns corresponding class probabilities.",
                     "offlineEnvironment": {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2", "CUDA_VISIBLE_DEVICES": ""}},
          "license": "Original converter and local gguf source MIT; copied in licenses/llama.cpp-MIT.txt. Build-dependency notices and wheel hashes are separately inventoried."}
with open(root / "conversion-inputs.lock.json", "x", encoding="utf8") as output:
    json.dump(report, output, indent=2)
    output.write("\n")
print(json.dumps({"files": len(records), "allMatchOriginalZIP": True, "sourceZipSha256": archive_sha}))
