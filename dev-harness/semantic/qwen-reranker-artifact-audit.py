"""Audit both locally produced GGUF inventories; no inference or fitting."""
import gc
import hashlib
import json
import pathlib
import re
import struct
import sys

root = pathlib.Path("output/semantic-qwen-reranker-official-v1").resolve()
source = pathlib.Path(json.loads((root / "conversion-inputs.lock.json").read_text())["converterSource"])
sys.path.insert(0, str(source / "gguf-py"))
import gguf


def digest(file):
    h = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


original = root / "source/Qwen3-Reranker-0.6B/model.safetensors"
with open(original, "rb") as stream:
    size = struct.unpack("<Q", stream.read(8))[0]
    header = json.loads(stream.read(size))
report = {"schemaVersion": 1, "status": "PASS", "sourceTensors": len([k for k in header if k != "__metadata__"]), "artifacts": {},
          "limits": ["No encoder/layer pruning: both GGUF files retain all 28 blocks and the full vocabulary. Official dtype conversion and Q4 quantization are lossy and are not called bytewise encoder equivalence."]}
for name, filename in [("f16", "qwen3-reranker-0.6b-rank-f16.gguf"), ("q4_k_m", "qwen3-reranker-0.6b-rank-q4_k_m.gguf")]:
    file = root / "artifacts" / filename
    reader = gguf.GGUFReader(str(file))
    value = lambda key: reader.get_field(key).contents()
    assert value("general.architecture") == "qwen3"
    assert value("qwen3.pooling_type") == 4
    assert value("qwen3.classifier.output_labels") == ["yes", "no"]
    assert value("qwen3.block_count") == 28
    blocks = sorted({int(match.group(1)) for tensor in reader.tensors if (match := re.match(r"blk\.(\d+)\.", tensor.name))})
    assert blocks == list(range(28))
    tokens = reader.get_field("tokenizer.ggml.tokens")
    assert len(tokens.data) == 151669 and tokens.contents(9693) == "yes" and tokens.contents(2152) == "no"
    table = next(t for t in reader.tensors if t.name == "token_embd.weight")
    head = next(t for t in reader.tensors if t.name == "cls.output.weight")
    assert table.shape.tolist() == [1024, 151669] and head.shape.tolist() == [1024, 2]
    template = value("tokenizer.chat_template.rerank")
    tensors = [{"name": t.name, "shape": t.shape.tolist(), "type": t.tensor_type.name} for t in reader.tensors]
    report["artifacts"][name] = {"file": str(file), "bytes": file.stat().st_size, "sha256": digest(file), "blockIndices": blocks,
                                 "tensorCount": len(tensors), "tensors": tensors, "vocabularyTokens": len(tokens.data), "labels": ["yes", "no"],
                                 "pooling": "RANK", "classifierType": head.tensor_type.name, "template": template,
                                 "templateSha256": hashlib.sha256(template.encode()).hexdigest()}
    del reader, table, head, tokens, value
    gc.collect()
before = [(x["name"], x["shape"]) for x in report["artifacts"]["f16"]["tensors"]]
after = [(x["name"], x["shape"]) for x in report["artifacts"]["q4_k_m"]["tensors"]]
assert sorted(before) == sorted(after), "Tensor names/shapes changed during quantization"
report["tensorSerializationOrderChanged"] = before != after
assert report["artifacts"]["f16"]["template"] == report["artifacts"]["q4_k_m"]["template"]
report["auditScriptSha256"] = digest(pathlib.Path(__file__))
with open(root / "artifact-inventory.json", "x", encoding="utf8") as stream:
    json.dump(report, stream, indent=2)
    stream.write("\n")
print(json.dumps({"status": report["status"], "sourceTensors": report["sourceTensors"], "artifacts": {k: {f: v[f] for f in ["bytes", "sha256", "tensorCount", "classifierType", "pooling"]} for k, v in report["artifacts"].items()}}))
