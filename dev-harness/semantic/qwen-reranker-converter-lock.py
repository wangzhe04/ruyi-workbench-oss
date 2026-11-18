"""Freeze isolated converter wheels and their shipped license metadata."""
import email
import hashlib
import importlib.metadata
import json
import pathlib
import re
import sys
import zipfile

root = pathlib.Path("output/semantic-qwen-reranker-official-v1").resolve()
owner = json.loads((root / "OWNER.json").read_text(encoding="utf8"))
if owner["owner"] != "sol_semantic_runtime":
    raise ValueError("Research owner mismatch")


def sha(file):
    value = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


records, requirements = [], []
for file in sorted((root / "wheels").glob("*.whl")):
    with zipfile.ZipFile(file) as wheel:
        name = next(x for x in wheel.namelist() if x.endswith(".dist-info/METADATA"))
        metadata = email.message_from_bytes(wheel.read(name))
        licenses = []
        for member in wheel.namelist():
            if member.endswith("/") or not re.match(r"^(LICENSE|LICENCE|NOTICE|COPYING)([._-].*|$)", pathlib.PurePosixPath(member).name, re.I):
                continue
            data = wheel.read(member)
            licenses.append({"member": member, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            if ".dist-info/" in member:
                target = root / "licenses" / "converter-wheels" / file.stem / pathlib.PurePosixPath(member)
                if root not in target.resolve().parents:
                    raise ValueError("Unsafe wheel license path")
                target.parent.mkdir(parents=True, exist_ok=True)
                with open(target, "xb") as output:
                    output.write(data)
        digest = sha(file)
        records.append({"file": str(file), "bytes": file.stat().st_size, "sha256": digest,
                        "name": metadata["Name"], "version": metadata["Version"],
                        "sourceIndex": "https://download.pytorch.org/whl/cpu" if metadata["Name"].lower() == "torch" else "https://pypi.org/simple",
                        "declaredLicense": metadata.get("License-Expression") or metadata.get("License"), "shippedLicenseMembers": licenses})
        requirements.append(f'{metadata["Name"]}=={metadata["Version"]} --hash=sha256:{digest}')
if not records or len({r["name"].lower() for r in records}) != len(records):
    raise ValueError("Missing or duplicate wheel distributions")
with open(root / "converter-requirements.lock.txt", "x", encoding="utf8") as stream:
    stream.write("\n".join(requirements) + "\n")
bootstrap = pathlib.Path(sys.base_prefix) / "Lib/ensurepip/_bundled/pip-25.0.1-py3-none-any.whl"
report = {"schemaVersion": 1, "owner": owner, "python": {"executable": sys.executable, "version": sys.version,
          "baseExecutableSha256": sha(pathlib.Path(sys.base_prefix) / "python.exe")},
          "pipBootstrap": {"version": "25.0.1", "file": str(bootstrap), "sha256": sha(bootstrap)},
          "wheelBytes": sum(r["bytes"] for r in records), "wheels": records,
          "localGguf": {"sourceCommit": "7fe450e19305b828c199d602c23a8337aaa1f03b", "version": "0.19.0", "pipInstalled": False,
                        "note": "Original converter prepends its own pinned gguf-py directory; no unrelated PyPI gguf package is used."},
          "installation": "converter-venv/Scripts/python.exe -m pip --isolated --disable-pip-version-check install --no-index --find-links wheels --require-hashes -r converter-requirements.lock.txt",
          "limits": ["All build dependencies remain in the owned research directory; not a server/runtime dependency.", "Wheel sources are the explicit official CPU index and PyPI; complete bytes are hash-locked before offline installation."]}
with open(root / "converter-wheel-lock.json", "x", encoding="utf8") as stream:
    json.dump(report, stream, ensure_ascii=False, indent=2)
    stream.write("\n")
print(json.dumps({"wheels": len(records), "bytes": report["wheelBytes"], "lock": str(root / "converter-wheel-lock.json")}))
