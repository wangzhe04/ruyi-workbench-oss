"""Prove the locally converted RANK head is the two official source rows."""
import hashlib
import json
import pathlib
import sys

root = pathlib.Path("output/semantic-qwen-reranker-official-v1").resolve()
source = pathlib.Path(json.loads((root / "conversion-inputs.lock.json").read_text())["converterSource"])
sys.path.insert(0, str(source / "gguf-py"))
import gguf
import numpy as np
import torch
from safetensors import safe_open


def sha(file):
    value = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


original = root / "source/Qwen3-Reranker-0.6B/model.safetensors"
f16 = root / "artifacts/qwen3-reranker-0.6b-rank-f16.gguf"
q4 = root / "artifacts/qwen3-reranker-0.6b-rank-q4_k_m.gguf"
original_sha = sha(original)
if original_sha != "27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b":
    raise ValueError("Official source changed")
with safe_open(original, framework="pt", device="cpu") as handle:
    sliced = handle.get_slice("model.embed_tokens.weight")
    shape = sliced.get_shape()
    rows = torch.cat([sliced[9693:9694], sliced[2152:2153]], dim=0)
    expected = rows.to(torch.float16).to(torch.float32).numpy()
reader = gguf.GGUFReader(str(f16))
get = lambda name: reader.get_field(name).contents()
if get("general.architecture") != "qwen3" or get("qwen3.pooling_type") != int(gguf.PoolingType.RANK):
    raise ValueError("Converted pooling/architecture mismatch")
labels = get("qwen3.classifier.output_labels")
if labels != ["yes", "no"]:
    raise ValueError("Class order mismatch")
head = next(tensor for tensor in reader.tensors if tensor.name == "cls.output.weight")
if list(head.shape) != [1024, 2] or head.tensor_type != gguf.GGMLQuantizationType.F16:
    raise ValueError("Unexpected converted head shape/type")
actual = head.data.astype(np.float32).reshape(2, 1024)
if not np.array_equal(actual, expected):
    raise ValueError("Converted head differs from official yes/no source rows cast to F16")
tokens = reader.get_field("tokenizer.ggml.tokens")
if tokens.contents(9693) != "yes" or tokens.contents(2152) != "no" or len(tokens.data) != 151669:
    raise ValueError("Converted full vocabulary mismatch")
template = get("tokenizer.chat_template.rerank")
if "<Query>: {query}" not in template or "<Document>: {document}" not in template or not template.endswith("<think>\n\n</think>\n\n"):
    raise ValueError("Official rerank template missing")
report = {"schemaVersion": 1, "status": "PROVED", "source": {"file": str(original), "sha256": original_sha, "embeddingShape": shape},
          "sourceTokenRows": [9693, 2152], "labels": labels, "head": {"name": head.name, "shape": head.shape.tolist(), "dtype": head.tensor_type.name,
          "rowsExactlyEqualAfterOfficialF16Cast": True, "rowMajorF16Sha256": hashlib.sha256(head.data.tobytes()).hexdigest()},
          "fullVocabularyTokens": len(tokens.data), "tensorCount": len(reader.tensors), "rerankTemplate": template,
          "probabilityContract": "p_yes = softmax([yes_logit,no_logit])[0] = sigmoid(yes_logit-no_logit); native RANK applies the softmax, never L2 or an additional sigmoid.",
          "f16": {"file": str(f16), "bytes": f16.stat().st_size, "sha256": sha(f16)},
          "q4": {"file": str(q4), "bytes": q4.stat().st_size, "sha256": sha(q4)} if q4.exists() else None,
          "proofScriptSha256": sha(pathlib.Path(__file__)), "limits": ["Exact F16 row extraction proof only; Q4 weights are lossy and are not called numerically equivalent to F16.", "This does not prove verifier quality, probability calibration, or CPU latency."]}
out = pathlib.Path(sys.argv[1]).resolve()
with open(out, "x", encoding="utf8") as stream:
    json.dump(report, stream, indent=2)
    stream.write("\n")
print(json.dumps({"status": report["status"], "f16": report["f16"], "q4": report["q4"], "head": report["head"], "vocabulary": len(tokens.data)}))
