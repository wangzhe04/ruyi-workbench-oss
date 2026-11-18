"""Static ONNX protobuf inventory, standard-library only; never runs a graph."""
import hashlib
import json
import mmap
import pathlib
import sys


def varint(data, pos):
    value, shift = 0, 0
    while True:
        byte = data[pos]
        pos += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            return value, pos
        shift += 7
        if shift > 70:
            raise ValueError("Malformed protobuf varint")


def fields(data, start, end):
    pos = start
    while pos < end:
        tag, pos = varint(data, pos)
        number, wire = tag >> 3, tag & 7
        if wire == 0:
            value, pos = varint(data, pos)
            yield number, wire, value, None
        elif wire == 2:
            size, pos = varint(data, pos)
            finish = pos + size
            if finish > end:
                raise ValueError("Protobuf length exceeds message")
            yield number, wire, pos, finish
            pos = finish
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            yield number, wire, pos, pos + size
            pos += size
        else:
            raise ValueError("Unsupported protobuf wire type")


def inventory(file):
    digest = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
        data = mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            graph = next((s, e) for n, w, s, e in fields(data, 0, len(data)) if n == 7 and w == 2)
            nodes, outputs = [], []
            for number, wire, start, end in fields(data, *graph):
                if wire != 2:
                    continue
                if number == 1:
                    node = {"inputs": [], "outputs": []}
                    for n, w, s, e in fields(data, start, end):
                        if w == 2 and n in (1, 2, 3, 4, 7):
                            value = data[s:e].decode("utf8")
                            if n in (1, 2):
                                node["inputs" if n == 1 else "outputs"].append(value)
                            else:
                                node[{3: "name", 4: "op", 7: "domain"}[n]] = value
                    nodes.append(node)
                elif number == 12:
                    outputs.append(next(data[s:e].decode("utf8") for n, w, s, e in fields(data, start, end) if n == 1 and w == 2))
            classifier = [x for x in nodes if "classifier" in x.get("name", "").lower() or any("classifier" in y.lower() for y in x["inputs"])]
            return {"file": str(file), "bytes": file.stat().st_size, "sha256": digest.hexdigest(), "graphOutputs": outputs,
                    "nodeCount": len(nodes), "classifierNodes": classifier, "tailNodes": nodes[-25:],
                    "limits": ["Static topology only; no graph modification or inference.", "Exposing a hidden graph output is structurally possible; numerical logit equivalence and standalone embedding retrieval quality still require actual tests."]}
        finally:
            data.close()


if __name__ == "__main__":
    report = inventory(pathlib.Path(sys.argv[1]).resolve())
    if len(sys.argv) > 2:
        with open(sys.argv[2], "x", encoding="utf8") as stream:
            json.dump(report, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
    print(json.dumps(report, ensure_ascii=False))
