"""Independent stdlib-only GGUF/safetensors provenance/head audit; no inference."""
import collections
import hashlib
import json
import math
import pathlib
import re
import struct
import sys
import zipfile

REPO = pathlib.Path(__file__).resolve().parents[2]
ROOT = REPO / "output/semantic-qwen-reranker-official-v1"
OUT = pathlib.Path(sys.argv[1]).resolve()
if OUT.exists():
    raise RuntimeError("Use a new immutable output")


def digest(file):
    h = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_json(file):
    return json.loads(pathlib.Path(file).read_text(encoding="utf-8-sig"))


class GGUF:
    """Read only bounded metadata/tensor directory and explicitly requested slices."""
    formats = {0: "B", 1: "b", 2: "H", 3: "h", 4: "I", 5: "i", 6: "f", 7: "?", 10: "Q", 11: "q", 12: "d"}

    def __init__(self, file):
        self.file = pathlib.Path(file)
        self.stream = open(file, "rb")
        assert self.stream.read(4) == b"GGUF"
        assert self.unpack("I") == 3
        tensor_count, kv_count = self.unpack("Q"), self.unpack("Q")
        assert 0 < tensor_count < 10000 and 0 < kv_count < 10000
        self.kv = {}
        for _ in range(kv_count):
            key = self.string()
            assert key not in self.kv
            self.kv[key] = self.value(self.unpack("I"))
        self.tensors = {}
        for _ in range(tensor_count):
            name, dims = self.string(), self.unpack("I")
            assert 0 < dims <= 4 and name not in self.tensors
            shape = [self.unpack("Q") for _ in range(dims)]
            dtype, offset = self.unpack("I"), self.unpack("Q")
            self.tensors[name] = {"shape": shape, "type": dtype, "offset": offset}
        alignment = self.kv.get("general.alignment", 32)
        assert alignment > 0 and alignment & (alignment - 1) == 0
        self.data_start = (self.stream.tell() + alignment - 1) // alignment * alignment
        assert self.data_start < 64 * 1024 * 1024

    def unpack(self, fmt):
        size = struct.calcsize("<" + fmt)
        data = self.stream.read(size)
        assert len(data) == size
        return struct.unpack("<" + fmt, data)[0]

    def string(self):
        size = self.unpack("Q")
        assert size < 16 * 1024 * 1024
        data = self.stream.read(size)
        assert len(data) == size
        return data.decode("utf8")

    def value(self, kind):
        if kind == 8:
            return self.string()
        if kind == 9:
            element, count = self.unpack("I"), self.unpack("Q")
            assert count <= 2000000
            return [self.value(element) for _ in range(count)]
        return self.unpack(self.formats[kind])

    def tensor_bytes(self, name, length):
        item = self.tensors[name]
        self.stream.seek(self.data_start + item["offset"])
        data = self.stream.read(length)
        assert len(data) == length
        return data


def verify_files(base, files):
    rows = []
    for item in files:
        file = pathlib.Path(base) / item["path"]
        assert file.is_file() and not file.is_symlink()
        actual = digest(file)
        assert actual == item["sha256"] and file.stat().st_size == item["bytes"]
        rows.append({"path": item["path"], "bytes": file.stat().st_size, "sha256": actual})
    return rows


def main():
    report = {"schemaVersion": 1, "status": "RUNNING", "modelsRun": 0, "standardLibraryOnly": True}
    lock = read_json(ROOT / "conversion-inputs.lock.json")
    source = pathlib.Path(lock["converterSource"])
    metadata = read_json(ROOT / "metadata-receipt.json")
    assert len(lock["files"]) == 118 and len(metadata["files"]) == 8
    before_source = verify_files(source, lock["files"])
    before_metadata = verify_files(ROOT / "source/Qwen3-Reranker-0.6B", metadata["files"])
    archive = pathlib.Path(lock["archive"]["file"])
    assert digest(archive) == lock["archive"]["sha256"]
    with zipfile.ZipFile(archive) as zipped:
        prefix = zipped.namelist()[0].split("/")[0]
        for item in lock["files"]:
            data = zipped.read(prefix + "/" + item["path"])
            assert len(data) == item["bytes"] and hashlib.sha256(data).hexdigest() == item["sha256"]
    report["converterInputs"] = {"sourceFileCount": 118, "metadataFileCount": 8, "sourceMatchesArchive": True,
                                 "archiveSha256": lock["archive"]["sha256"], "commit": lock["commit"]}
    original = ROOT / "source/Qwen3-Reranker-0.6B/model.safetensors"
    original_sha = digest(original)
    assert original_sha == "27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b"
    assert original.stat().st_size == 1191588280
    with open(original, "rb") as stream:
        size = struct.unpack("<Q", stream.read(8))[0]
        header = json.loads(stream.read(size))
        table = header["model.embed_tokens.weight"]
        assert table["dtype"] == "BF16" and table["shape"] == [151669, 1024]
        original_rows = []
        for index in [9693, 2152]:
            stream.seek(8 + size + table["data_offsets"][0] + index * 1024 * 2)
            row = stream.read(2048)
            assert len(row) == 2048
            original_rows.append(row)
    expected = bytearray()
    for row in original_rows:
        for (value,) in struct.iter_unpack("<H", row):
            f32 = struct.unpack("<f", struct.pack("<I", value << 16))[0]
            assert math.isfinite(f32)
            expected.extend(struct.pack("<e", f32))
    tokenizer = read_json(ROOT / "source/Qwen3-Reranker-0.6B/tokenizer.json")
    vocabulary = [None] * 151669
    for text, index in tokenizer["model"]["vocab"].items():
        assert vocabulary[index] is None
        vocabulary[index] = text
    for item in tokenizer["added_tokens"]:
        index, text = item["id"], item["content"]
        assert vocabulary[index] is None or vocabulary[index] == text
        vocabulary[index] = text
    assert all(isinstance(value, str) for value in vocabulary)
    report["source"] = {"bytes": original.stat().st_size, "sha256": original_sha, "shape": table["shape"],
                        "rows": [9693, 2152], "sourceBF16RowsSha256": hashlib.sha256(b"".join(original_rows)).hexdigest()}
    inventories = {}
    readers = []
    try:
        for mode, filename, expected_sha in [
            ("f16", "qwen3-reranker-0.6b-rank-f16.gguf", "a3182982cf5ff9d3c40a75b3c4120e297769be0da333cf49b4ad86755c9535e5"),
            ("q4_k_m", "qwen3-reranker-0.6b-rank-q4_k_m.gguf", "9787224d2920d37838ed8dcf88dc6f2b92d1629192627655c32b06aef04becc7"),
        ]:
            file = ROOT / "artifacts" / filename
            reader = GGUF(file)
            readers.append(reader)
            assert reader.kv["general.architecture"] == "qwen3" and reader.kv["qwen3.pooling_type"] == 4
            assert reader.kv["qwen3.classifier.output_labels"] == ["yes", "no"]
            assert reader.kv["tokenizer.ggml.tokens"] == vocabulary
            assert vocabulary[9693] == "yes" and vocabulary[2152] == "no"
            assert reader.tensors["token_embd.weight"]["shape"] == [1024, 151669]
            assert reader.tensors["cls.output.weight"]["shape"] == [1024, 2]
            blocks = sorted({int(match.group(1)) for name in reader.tensors if (match := re.match(r"blk\.(\d+)\.", name))})
            assert blocks == list(range(28)) and len(reader.tensors) == 311
            head_type = reader.tensors["cls.output.weight"]["type"]
            if head_type == 1:
                raw = reader.tensor_bytes("cls.output.weight", 4096)
                equal = raw == bytes(expected)
            elif head_type == 0:
                raw = reader.tensor_bytes("cls.output.weight", 8192)
                equal = raw == b"".join(struct.pack("<f", value) for (value,) in struct.iter_unpack("<e", expected))
            else:
                raw, equal = b"", None
            if mode == "f16":
                assert head_type == 1 and equal is True
            actual_sha = digest(file)
            assert actual_sha == expected_sha
            inventories[mode] = {"file": str(file), "bytes": file.stat().st_size, "sha256": actual_sha,
                                 "tensorCount": len(reader.tensors), "tensorTypes": dict(collections.Counter(str(t["type"]) for t in reader.tensors.values())),
                                 "fullVocabularyEqualToOfficialTokenizerAllIds": True, "vocabularyTokens": len(vocabulary),
                                 "classifierTypeCode": head_type, "classifierType": {0: "F32", 1: "F16"}.get(head_type, "quantized-type-" + str(head_type)),
                                 "headEqualsSourceRowsAfterF16Cast": equal, "rawHeadSha256": hashlib.sha256(raw).hexdigest() if raw else None,
                                 "headOffset": reader.data_start + reader.tensors["cls.output.weight"]["offset"],
                                 "pooling": "RANK", "labels": ["yes", "no"], "templateSha256": hashlib.sha256(reader.kv["tokenizer.chat_template.rerank"].encode()).hexdigest(),
                                 "generalFileType": reader.kv.get("general.file_type")}
        a, b = readers
        assert {name: t["shape"] for name, t in a.tensors.items()} == {name: t["shape"] for name, t in b.tensors.items()}
        assert a.kv["tokenizer.chat_template.rerank"] == b.kv["tokenizer.chat_template.rerank"]
        report["artifacts"] = inventories
        report["tensorSerializationOrderChanged"] = list(a.tensors) != list(b.tensors)
    finally:
        for reader in readers:
            reader.stream.close()
    toolchain = read_json(ROOT / "toolchain/quantizer.lock.json")
    report["quantizerFiles"] = verify_files(ROOT / "toolchain/quantizer", toolchain["files"])
    report["buildEvidence"] = []
    for item in toolchain["buildEvidence"]:
        assert digest(item["file"]) == item["sha256"]
        report["buildEvidence"].append(item)
    license_file = source / "LICENSE"
    assert "MIT License" in license_file.read_text()
    report["converterLicense"] = {"name": "MIT", "file": str(license_file), "sha256": digest(license_file)}
    report["sourceStableDuringIndependentAudit"] = before_source == verify_files(source, lock["files"]) and before_metadata == verify_files(ROOT / "source/Qwen3-Reranker-0.6B", metadata["files"]) and digest(original) == original_sha
    assert report["sourceStableDuringIndependentAudit"]
    report["status"] = "PASS_INDEPENDENT_BYTES_AND_PINNED_PROVENANCE"
    report["probabilityContract"] = "native RANK softmax([yes_logit,no_logit])[0]; no extra L2/sigmoid"
    report["limits"] = ["No model inference or representation/quality/latency qualification.", "All vocabulary entries and two source rows compared independently with Python struct, no torch/numpy/gguf library imported.", "Q4 body tensors are lossy; matching names/shapes and an unchanged small classifier do not prove numerical body equivalence.", "Recorded historical conversion isolation is audited separately; old invalid/intermediate artifacts are never promoted by equal bytes."]
    return report


try:
    result = main()
except Exception as error:
    result = {"schemaVersion": 1, "status": "FAIL", "error": repr(error), "modelsRun": 0}
    import traceback
    result["stack"] = traceback.format_exc()
    sys.exitcode = 1
OUT.parent.mkdir(parents=True, exist_ok=True)
with open(OUT, "x", encoding="utf8") as stream:
    json.dump(result, stream, indent=2)
    stream.write("\n")
print(json.dumps({"status": result["status"], "output": str(OUT), "error": result.get("error"), "artifacts": result.get("artifacts")}))
if result["status"] == "FAIL":
    raise SystemExit(1)
