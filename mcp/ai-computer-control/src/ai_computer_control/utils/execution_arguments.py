"""Semantic JSON fingerprint matching Node's ruyi-sdk-json-v1; not an authorization token."""
import hashlib
import math
import struct


def arguments_digest(value):
    digest = hashlib.sha256()
    ancestors = set()
    nodes = 0
    size = 0

    def put(data):
        nonlocal size
        size += len(data)
        if size > 64 * 1024 * 1024:
            raise ValueError('execution argument fingerprint exceeds capacity')
        digest.update(data)

    def visit(item, depth):
        nonlocal nodes
        nodes += 1
        if nodes > 1000000 or depth > 128:
            raise ValueError('execution argument fingerprint exceeds capacity')
        if item is None:
            put(b'n;')
        elif type(item) is bool:
            put(b't;' if item else b'f;')
        elif type(item) is int:
            # Never round an actually received arbitrary-precision JSON integer to binary64.
            put(('i' + str(item) + ';').encode('ascii'))
        elif type(item) is float:
            number = item
            if not math.isfinite(number):
                raise ValueError('execution arguments require finite numbers')
            put(b'd'); put(struct.pack('>d', number)); put(b';')
        elif isinstance(item, str):
            encoded = item.encode('utf-8', errors='strict')
            put(('s' + str(len(encoded)) + ':').encode('ascii')); put(encoded); put(b';')
        elif isinstance(item, (dict, list)):
            identity = id(item)
            if identity in ancestors:
                raise ValueError('execution arguments cannot be cyclic')
            ancestors.add(identity)
            if isinstance(item, list):
                put(('a' + str(len(item)) + ':').encode('ascii'))
                for child in item:
                    visit(child, depth + 1)
            else:
                if any(not isinstance(key, str) for key in item):
                    raise ValueError('execution argument object keys must be strings')
                keys = sorted(item, key=lambda key: key.encode('utf-8', errors='strict'))
                put(('o' + str(len(keys)) + ':').encode('ascii'))
                for key in keys:
                    visit(key, depth + 1); visit(item[key], depth + 1)
            ancestors.remove(identity); put(b';')
        else:
            raise ValueError('execution arguments require JSON values')

    put(b'ruyi-sdk-json-v1\0')
    visit(value, 0)
    return digest.hexdigest()
