"""Manual qualification helper: stdlib ZIP CRC/readback against a Node stage census.

Never extracts archive paths. The caller owns this original process and its exit.
Python belongs to the qualification host, not to the offline package runtime.
"""
import hashlib
import json
import os
import re
import stat
import sys
import zipfile


def filesystem_path(value):
    # ZIP names remain portable relative names. Only stage filesystem calls get
    # the Windows extended spelling; do not truncate, skip or weaken link checks.
    if os.name != "nt":
        return value
    absolute = os.path.abspath(value)
    if absolute.startswith("\\\\?\\"):
        return absolute
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute


def safe_name(name):
    if not isinstance(name, str) or not name or "\\" in name or name.startswith("/") or name.endswith("//"):
        raise ValueError("unsafe ZIP name")
    parts = name.rstrip("/").split("/")
    for part in parts:
        if (not part or part in (".", "..") or part.endswith((".", " "))
                or re.search(r'[<>:"|?*\x00-\x1f]', part)
                or re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part, re.I)):
            raise ValueError("unsafe Windows ZIP path")
    return "/".join(parts)


def digest(stream):
    value, length = hashlib.sha256(), 0
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            break
        value.update(chunk)
        length += len(chunk)
    return length, value.hexdigest()


def verify(stage, archive_path, census_path):
    with open(census_path, "r", encoding="utf-8") as stream:
        census = json.load(stream)
    expected = {row["path"].casefold(): row for row in census["files"]}
    if len(expected) != len(census["files"]):
        raise ValueError("duplicate stage files")
    directories = {safe_name(name).casefold() for name in census["directories"]}
    seen, files, actual_dirs, rows = set(), set(), set(), []
    with zipfile.ZipFile(archive_path, "r", allowZip64=True) as archive:
        if not archive.infolist():
            raise ValueError("empty ZIP")
        for entry in archive.infolist():
            name = safe_name(entry.filename)
            key = name.casefold()
            if key in seen:
                raise ValueError("duplicate or case-colliding ZIP entry")
            seen.add(key)
            mode = entry.external_attr >> 16
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError("ZIP links/special objects refused")
            if ((stat.S_IFMT(mode) == stat.S_IFDIR and not entry.is_dir())
                    or (stat.S_IFMT(mode) == stat.S_IFREG and entry.is_dir())):
                raise ValueError("ZIP directory attributes disagree with its name")
            parts = key.split("/")
            actual_dirs.update("/".join(parts[:index]) for index in range(1, len(parts)))
            if entry.is_dir():
                actual_dirs.add(key)
                if entry.file_size != 0:
                    raise ValueError("nonempty ZIP directory")
                with archive.open(entry, "r") as stream:
                    if stream.read(1):
                        raise ValueError("ZIP directory data")
                rows.append({"path": name, "kind": "directory"})
                continue
            if key not in expected or name != expected[key]["path"]:
                raise ValueError("ZIP file missing from exact stage census")
            if entry.file_size != expected[key]["bytes"]:
                raise ValueError("ZIP declared size differs from fixed stage before inflate")
            files.add(key)
            # zipfile checks each entry's CRC while consuming to actual EOF.
            with archive.open(entry, "r") as stream:
                length, zipped = digest(stream)
            target = filesystem_path(os.path.join(stage, *name.split("/")))
            if os.path.islink(target) or not os.path.isfile(target):
                raise ValueError("stage link/missing file")
            with open(target, "rb") as stream:
                stage_length, staged = digest(stream)
            row = expected[key]
            if (length != entry.file_size or length != row["bytes"] or length != stage_length
                    or zipped != row["sha256"] or zipped != staged):
                raise ValueError("ZIP/stage full-byte mismatch")
            rows.append({"path": name, "kind": "file", "bytes": length, "sha256": zipped})
    if files != set(expected) or actual_dirs != directories:
        raise ValueError("ZIP/stage complete file/directory sets differ")
    return {"status": "PASS", "python": sys.version.split()[0], "crcReadToEof": True,
            "entries": len(rows), "files": len(files), "directories": len(actual_dirs),
            "bytes": sum(row.get("bytes", 0) for row in rows), "rows": rows}


def self_test():
    import tempfile
    import warnings
    import shutil
    warnings.simplefilter("ignore", UserWarning)  # expected duplicate-entry negative controls
    with tempfile.TemporaryDirectory(prefix="ruyi-zip-unit-") as root:
        stage = os.path.join(root, "stage")
        os.mkdir(stage)
        data = b"synthetic-zip-readback\x00"
        with open(os.path.join(stage, "a.txt"), "wb") as stream:
            stream.write(data)
        census = os.path.join(root, "census.json")
        with open(census, "w", encoding="utf-8") as stream:
            json.dump({"files": [{"path": "a.txt", "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}], "directories": []}, stream)
        archive = os.path.join(root, "a.zip")
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr("a.txt", data)
        assert verify(stage, archive, census)["files"] == 1
        for name in ("../escape", "C:/escape", "a\\b", "./file", "con.txt", "x:stream", "/absolute", "trailing. ", "a//"):
            try:
                safe_name(name)
            except ValueError:
                pass
            else:
                raise AssertionError("unsafe name accepted")
        for extra in ("a.txt", "A.TXT", "../escape", "unexpected"):
            with zipfile.ZipFile(archive, "w") as zipped:
                zipped.writestr("a.txt", data)
                zipped.writestr(extra, data)
            try:
                verify(stage, archive, census)
            except ValueError:
                pass
            else:
                raise AssertionError("duplicate/unsafe/unexpected accepted")
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr("a.txt", b"different")
        try:
            verify(stage, archive, census)
        except ValueError:
            pass
        else:
            raise AssertionError("byte mismatch accepted")
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr("a.txt", data)
        with open(archive, "rb") as stream:
            altered = bytearray(stream.read())
        central = altered.index(b"PK\x01\x02")
        altered[central + 16] ^= 1  # preserve payload; forge only the CRC expected at actual EOF
        with open(archive, "wb") as stream:
            stream.write(altered)
        try:
            verify(stage, archive, census)
        except zipfile.BadZipFile:
            pass
        else:
            raise AssertionError("CRC corruption accepted")
        entry = zipfile.ZipInfo("a.txt")
        entry.create_system = 3
        entry.external_attr = (stat.S_IFDIR | 0o755) << 16
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr(entry, data)
        try:
            verify(stage, archive, census)
        except ValueError:
            pass
        else:
            raise AssertionError("directory-attribute mismatch accepted")
        # A real, readable stage file whose ordinary Windows spelling exceeds
        # MAX_PATH. Creation uses the extended API spelling, just like Node's
        # successful census. Qualification must read every byte, not skip it.
        long_stage = os.path.join(root, "long-stage")
        parts = ["deep-" + "x" * 64] * 4
        relative = "/".join(parts + ["unicode-深度.bin"])
        target = os.path.join(long_stage, *relative.split("/"))
        assert len(os.path.abspath(target)) > 260
        os.makedirs(filesystem_path(os.path.dirname(target)))
        with open(filesystem_path(target), "wb") as stream:
            stream.write(data)
        with open(census, "w", encoding="utf-8") as stream:
            json.dump({"files": [{"path": relative, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}],
                       "directories": ["/".join(parts[:index]) for index in range(1, len(parts) + 1)]}, stream)
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr(relative, data)
        failure = None
        try:
            assert verify(long_stage, archive, census)["files"] == 1
        except Exception as error:
            failure = error
        try:
            assert os.path.dirname(os.path.abspath(long_stage)) == os.path.abspath(root)
            assert not os.path.islink(filesystem_path(long_stage))
            shutil.rmtree(filesystem_path(long_stage))
        except Exception as cleanup:
            if failure is not None:
                raise ExceptionGroup("long-path self-test and original deep cleanup failed", [failure, cleanup])
            raise
        if failure is not None:
            raise failure
        if os.name == "nt":
            assert filesystem_path("C:\\stage\\file") == "\\\\?\\C:\\stage\\file"
            assert filesystem_path("\\\\host\\share\\file") == "\\\\?\\UNC\\host\\share\\file"
            assert filesystem_path("\\\\?\\C:\\stage\\file") == "\\\\?\\C:\\stage\\file"
    print("PASS ZIP stdlib synthetic readback/safety self-test")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        if len(sys.argv) != 5:
            raise ValueError("stage ZIP census output arguments required")
        result = verify(*sys.argv[1:4])
        with open(sys.argv[4], "x", encoding="utf-8") as stream:
            json.dump(result, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
        print(json.dumps({key: value for key, value in result.items() if key != "rows"}))
