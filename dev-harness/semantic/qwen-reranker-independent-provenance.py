"""No-model, standard-library provenance and ONNX byte-preservation audit."""
import hashlib
import json
import pathlib
import re
import sys
import zipfile

REPO = pathlib.Path(__file__).resolve().parents[2]
ROOT = REPO / "output/semantic-qwen-reranker-official-v1"
OUT = pathlib.Path(sys.argv[1]).resolve()


def load(file):
    return json.loads(pathlib.Path(file).read_text(encoding="utf-8-sig"))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def info(file):
    file = pathlib.Path(file)
    return {"file": str(file), "bytes": file.stat().st_size, "sha256": sha(file.read_bytes())}


def varint(stream):
    value = 0
    for shift in range(0, 70, 7):
        b = stream.read(1)
        assert len(b) == 1
        value |= (b[0] & 127) << shift
        if not b[0] & 128:
            return value
    raise ValueError("Invalid protobuf varint")


def graph_location(file):
    with open(file, "rb") as stream:
        size = pathlib.Path(file).stat().st_size
        while stream.tell() < size:
            start = stream.tell()
            tag = varint(stream)
            kind = tag & 7
            if kind == 0:
                varint(stream)
            elif kind == 1:
                stream.seek(8, 1)
            elif kind == 5:
                stream.seek(4, 1)
            elif kind == 2:
                count = varint(stream)
                if tag >> 3 == 7:
                    return start, stream.tell(), count
                stream.seek(count, 1)
            else:
                raise ValueError("Unsupported protobuf wire type")
    raise ValueError("No ModelProto graph")


def main():
    result = {"schemaVersion": 1, "status": "RUNNING", "modelsRun": 0, "standardLibraryOnly": True}
    execution = load(ROOT / "converter-f16-strict-execution.json")
    preflight = load(ROOT / "conversion-preflight.json")
    lock = load(ROOT / "conversion-inputs.lock.json")
    assert execution["status"] == "PASS" and execution["exitCode"] == 0 and execution["signal"] is None
    assert execution["beforeSourceMatchesPinnedZIP"] and execution["afterSourceMatchesPinnedZIP"]
    assert execution["sourceLockSha256"] == info(ROOT / "conversion-inputs.lock.json")["sha256"]
    for item in execution["scripts"]:
        assert info(item["file"])["sha256"] == item["sha256"]
    assert execution["args"][0] == "-I"
    assert pathlib.Path(execution["args"][2]) == ROOT
    assert pathlib.Path(execution["args"][3]) == pathlib.Path(lock["converterSource"])
    assert pathlib.Path(execution["args"][4]) == ROOT / "artifacts/qwen3-reranker-0.6b-rank-f16.gguf"
    assert execution["modelSourceBefore"] == execution["modelSourceAfter"]
    assert execution["modelSourceBefore"] == {"sha256": "27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b", "bytes": 1191588280, "metadataFiles": 8}
    sandbox = ROOT / "conversion-sandbox-v1"
    assert pathlib.Path(execution["cwd"]) == sandbox
    assert load(ROOT / "OWNER.json")["owner"] == "sol_semantic_runtime"
    assert load(sandbox / "OWNER.json")["owner"] == "sol_semantic_runtime"
    assert preflight["pythonIsolated"] == 1 and preflight["pythonNoUserSite"] == 1
    assert preflight["socketNetworkDenied"] and preflight["localFilesOnlyExplicitlyTested"] and preflight["transformersOfflineForcesLocalFilesOnly"]
    assert preflight["tokenIds"] == {"yes": 9693, "no": 2152}
    assert preflight["cudaVersion"] is None and preflight["torchThreads"] == 2
    env = execution["environment"]
    expected_keys = {"SystemRoot", "WINDIR", "COMSPEC", "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HF_HOME", "TEMP", "TMP", "XDG_CACHE_HOME", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "CUDA_VISIBLE_DEVICES"}
    assert set(env) == expected_keys
    for name in ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HF_HOME", "TEMP", "TMP", "XDG_CACHE_HOME"]:
        directory = pathlib.Path(env[name])
        assert directory.is_absolute() and sandbox in directory.parents
        assert not directory.is_symlink()
        assert pathlib.Path(preflight["environment"][name]) == directory
    assert env["HF_HUB_OFFLINE"] == env["TRANSFORMERS_OFFLINE"] == env["HF_DATASETS_OFFLINE"] == "1"
    result["strictConversion"] = {"receipts": [info(ROOT / x) for x in ["converter-f16-strict-execution.json", "conversion-preflight.json", "conversion-inputs.lock.json", "metadata-receipt.json", "converter-f16-strict.log"]], "scripts": execution["scripts"], "ownerPathAndWhitelistMatchesRecordedChild": True, "preflightBeforeOriginalConverter": True, "sourceModelBeforeEqualsAfter": True, "isolationScope": "Python -I/no-user-site + explicit environment + local_files_only/offline + Python socket deny; not an OS firewall or hostile-code sandbox"}
    result["preservedUnqualifiedHistory"] = []
    for stem in ["invalid-isolation-attempt", "intermediate-no-preflight"]:
        artifact = ROOT / ("artifacts/qwen3-reranker-0.6b-rank-f16-" + stem + ".gguf")
        assert artifact.is_file() and artifact.stat().st_size == 1197634304
        result["preservedUnqualifiedHistory"].append({"artifact": str(artifact), "bytes": artifact.stat().st_size, "promotionAllowed": False, "receipt": info(ROOT / ("converter-f16-" + stem + "-execution.json")), "log": info(ROOT / ("converter-f16-" + stem + ".log"))})
    result["preservedInvalidIsolationAudit"] = info(ROOT / "invalid-isolation-metadata-audit.json")

    # Quantizer compilation source is a different directory from converter source.
    # Compare every archived C/C++/CMake source/build input, not a claim of binary reproducibility.
    quantizer_source = pathlib.Path("C:/r31-native-headless-research/llama.cpp-7fe450e19305b828c199d602c23a8337aaa1f03b")
    cache = pathlib.Path("C:/r31-native-headless-research/build-control/CMakeCache.txt")
    cache_text = cache.read_text(encoding="utf8")
    assert ("CMAKE_HOME_DIRECTORY:INTERNAL=" + quantizer_source.as_posix()) in cache_text
    assert "GGML_NATIVE:BOOL=OFF" in cache_text and "GGML_AVX2:BOOL=ON" in cache_text
    pins = []
    with zipfile.ZipFile(lock["archive"]["file"]) as zipped:
        prefix = zipped.namelist()[0].split("/")[0] + "/"
        for item in zipped.infolist():
            rel = item.filename[len(prefix):]
            if item.is_dir() or not rel:
                continue
            file = pathlib.PurePosixPath(rel)
            if file.suffix.lower() not in {".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".inl", ".cmake"} and file.name not in {"CMakeLists.txt", "LICENSE"}:
                continue
            actual = quantizer_source / rel
            data = zipped.read(item)
            assert actual.is_file() and actual.read_bytes() == data, rel
            pins.append({"path": rel, "bytes": len(data), "sha256": sha(data)})
    assert len(pins) > 1000
    pin_bytes = json.dumps(pins, separators=(",", ":")).encode()
    result["quantizerSource"] = {"source": str(quantizer_source), "buildCache": info(cache), "verifiedArchivedCppCmakeLicenseFiles": len(pins), "manifestSha256": sha(pin_bytes), "files": pins, "license": info(quantizer_source / "LICENSE"), "licenseName": "MIT", "sourcePinScope": "All ZIP C/C++ headers/sources/CMake/license files; not an independent rebuild or comprehensive binary dependency/license review"}
    graph = (quantizer_source / "src/llama-graph.cpp").read_text(encoding="utf8")
    qwen = (pathlib.Path(lock["converterSource"]) / "conversion/qwen.py").read_text(encoding="utf8")
    assert 'add_classifier_output_labels(["yes", "no"])' in qwen
    assert "data_torch[self.token_true_id]" in qwen and "data_torch[self.token_false_id]" in qwen
    assert "cur = ggml_mul_mat(ctx0, cls_out, cur);" in graph and "cur = ggml_soft_max(ctx0, cur);" in graph
    server = (quantizer_source / "tools/server/server-context.cpp").read_text(encoding="utf8")
    assert "res->score = embd[0];" in server
    result["rankContractStatic"] = {"labels": ["yes", "no"], "sourceRows": [9693, 2152], "formula": "softmax([head_yes dot last_token_hidden, head_no dot last_token_hidden])[0]", "sources": [info(quantizer_source / "src/llama-graph.cpp"), info(pathlib.Path(lock["converterSource"]) / "conversion/qwen.py"), info(quantizer_source / "tools/server/server-context.cpp")], "apiScope": "RANK /rerank scalar; no safe /v1/embeddings vector-contract claim"}
    export = load(REPO / "output/semantic-mmarco-dual-output-v1/export-receipt.json")
    original, hidden = pathlib.Path(export["original"]["file"]), pathlib.Path(export["exported"]["file"])
    a, b = graph_location(original), graph_location(hidden)
    assert b[2] == a[2] + 95
    assert a[0] == b[0]
    original_hash, hidden_hash = hashlib.sha256(), hashlib.sha256()
    # Stream the independently located graph payloads and compare all original bytes.
    with open(original, "rb") as one, open(hidden, "rb") as two:
        assert one.read(a[0]) == two.read(b[0])
        one.seek(a[1]); two.seek(b[1]); remaining = a[2]
        while remaining:
            n = min(1024 * 1024, remaining)
            x, y = one.read(n), two.read(n)
            assert len(x) == len(y) == n and x == y
            remaining -= n
        appended = two.read(95)
        assert sha(appended) == export["recipe"]["newOutputWireSha256"]
        assert one.read() == two.read()
    for file, expected in [(original, export["original"]), (hidden, export["exported"])]:
        h = hashlib.sha256()
        with open(file, "rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(chunk)
        assert h.hexdigest() == expected["sha256"] and file.stat().st_size == expected["bytes"]
    result["mmarcoGraphBytePreservation"] = {"original": export["original"], "hidden": export["exported"], "originalGraphPayloadBytes": a[2], "allOriginalGraphPayloadBytesEqual": True, "allOtherModelProtoBytesEqual": True, "appendedOutputBytes": 95, "appendedOutputSha256": sha(appended)}
    result["status"] = "PASS_INDEPENDENT_RECORDED_ISOLATION_SOURCE_AND_GRAPH_AUDIT"
    result["limits"] = ["No converter or model executed; historical behavior is assessed from pinned scripts and recorded preflight/exit receipts.", "Original failed isolation has no pre-attempt filesystem baseline; no zero-nonowner-write guarantee or cleanup performed.", "Build source pins and actual binary hashes establish recorded provenance, not a reproducible binary build proof.", "The independent bytes report's generic phrase about an unchanged small classifier is conditional only: this actual Q4 head is quantized type12/Q4_K and exact F16 equivalence is not asserted."]
    return result


try:
    report = main()
except Exception as error:
    import traceback
    report = {"status": "FAIL", "modelsRun": 0, "error": str(error), "stack": traceback.format_exc()}
OUT.parent.mkdir(parents=True, exist_ok=True)
with open(OUT, "x", encoding="utf8") as stream:
    json.dump(report, stream, indent=2)
    stream.write("\n")
print(json.dumps({"status": report["status"], "output": str(OUT), "error": report.get("error")}))
if report["status"] == "FAIL":
    raise SystemExit(1)
