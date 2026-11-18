"""Append one ONNX graph output; preserve every original node/weight byte."""
import hashlib
import json
import mmap
import pathlib
import runpy
import sys

helper = runpy.run_path(str(pathlib.Path(__file__).with_name("calibration-onnx-topology.py")))
fields, inventory, varint = (helper[name] for name in ("fields", "inventory", "varint"))

PIN = "6c2513767fb63d008a4377bef7a7a3555433d9436342bb53e35a3a72ffc52d4b"
HIDDEN = "/roberta/encoder/layer.11/output/LayerNorm/Add_1_output_0"


def integer(value):
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def message(number, body):
    return integer((number << 3) | 2) + integer(len(body)) + body


def text(number, value):
    return message(number, value.encode("utf8"))


def copy_bytes(stream, output, start, size):
    stream.seek(start)
    while size:
        chunk = stream.read(min(1024 * 1024, size))
        if not chunk:
            raise ValueError("Unexpected source EOF")
        output.write(chunk)
        size -= len(chunk)


def digest(file):
    result = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def export(source, destination, receipt):
    original = inventory(source)
    if original["sha256"] != PIN or original["graphOutputs"] != ["logits"]:
        raise ValueError("Unexpected original MMARCO graph")
    if not any(HIDDEN in node["outputs"] for node in original["tailNodes"]):
        raise ValueError("Expected final hidden tensor is absent")
    # ValueInfoProto(name, TypeProto(Tensor(float32, [batch, sequence,384]))).
    shape = message(1, text(2, "batch")) + message(1, text(2, "sequence")) + message(1, integer(8) + integer(384))
    tensor_type = integer(8) + integer(1) + message(2, shape)
    value_info = text(1, HIDDEN) + message(2, message(1, tensor_type))
    appended_output = message(12, value_info)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with open(source, "rb") as stream:
        data = mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            graph_start, graph_end = next((s, e) for n, w, s, e in fields(data, 0, len(data)) if n == 7 and w == 2)
            # Scan raw extents; fields() exposes values for scalar wire 0.
            pos = 0
            while True:
                field_start = pos
                tag, pos = varint(data, pos)
                wire = tag & 7
                if wire == 0:
                    _, pos = varint(data, pos)
                elif wire == 2:
                    length, pos = varint(data, pos)
                    if tag >> 3 == 7:
                        graph_field_start = field_start
                        break
                    pos += length
                elif wire in (1, 5):
                    pos += 8 if wire == 1 else 4
                else:
                    raise ValueError("Unexpected ModelProto wire type")
            with open(destination, "xb") as output:
                copy_bytes(stream, output, 0, graph_field_start)
                output.write(integer((7 << 3) | 2) + integer(graph_end - graph_start + len(appended_output)))
                copy_bytes(stream, output, graph_start, graph_end - graph_start)
                output.write(appended_output)
                copy_bytes(stream, output, graph_end, len(data) - graph_end)
        finally:
            data.close()
    transformed = inventory(destination)
    if transformed["nodeCount"] != original["nodeCount"] or transformed["graphOutputs"] != ["logits", HIDDEN]:
        raise ValueError("Unexpected transformed graph topology")
    result = {"schemaVersion": 1, "original": {"file": str(source), "bytes": source.stat().st_size, "sha256": original["sha256"]},
              "exported": {"file": str(destination), "bytes": destination.stat().st_size, "sha256": transformed["sha256"]},
              "recipe": {"version": "append-hidden-value-info-v1", "outputName": HIDDEN, "dtype": "float32", "shape": ["batch", "sequence", 384],
                         "newOutputWireSha256": hashlib.sha256(appended_output).hexdigest(), "addedGraphPayloadBytes": len(appended_output),
                         "description": "Replace only ModelProto graph-field length; copy original graph payload byte-for-byte and append one GraphProto.output ValueInfoProto; preserve all other ModelProto bytes.",
                         "scriptSha256": digest(pathlib.Path(__file__)), "protobufHelperSha256": digest(pathlib.Path(__file__).with_name("calibration-onnx-topology.py"))},
              "nodeCount": transformed["nodeCount"], "outputs": transformed["graphOutputs"], "weightsAndExistingGraphPayloadPreserved": True,
              "limits": ["No inference or numerical-equivalence claim. Original weights/head/encoder remain; only output metadata is added.", "The new output may affect graph optimizer fusion; genuine original/exported logit comparison is required."]}
    with open(receipt, "x", encoding="utf8") as output:
        json.dump(result, output, indent=2, ensure_ascii=False)
        output.write("\n")
    print(json.dumps(result))


if __name__ == "__main__":
    export(*(pathlib.Path(value).resolve() for value in sys.argv[1:4]))
