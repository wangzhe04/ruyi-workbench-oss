"""Pure cross-language execution argument identity contract, no desktop or MCP dispatch."""
import json
import math
from pathlib import Path
import sys
import struct
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from ai_computer_control.utils.execution_arguments import arguments_digest


class ExecutionArguments(unittest.TestCase):
    def test_shared_protocol_vectors(self):
        path = Path(__file__).resolve().parents[3] / 'dev-harness/fixtures/execution-argument-vectors.json'
        values = json.loads(path.read_text())
        for row in values['vectors']:
            with self.subTest(wire=row['wire']):
                self.assertEqual(arguments_digest(json.loads(row['wire'])), row['sha256'])

    def test_equivalences_and_distinctions(self):
        self.assertEqual(arguments_digest({'b': 2, 'a': 1}), arguments_digest({'a': 1, 'b': 2}))
        self.assertNotEqual(arguments_digest(-0.), arguments_digest(0.))
        self.assertNotEqual(arguments_digest(1), arguments_digest(1.))
        self.assertNotEqual(arguments_digest(9007199254740992), arguments_digest(9007199254740993))
        self.assertNotEqual(arguments_digest(1000000000000000100), arguments_digest(1000000000000000128))
        self.assertIsInstance(arguments_digest(10**1000), str)
        self.assertNotEqual(arguments_digest(1), arguments_digest('1'))
        self.assertNotEqual(arguments_digest('é'), arguments_digest('e\u0301'))

    def test_actual_sdk_preserves_wire_numeric_categories(self):
        from mcp.types import JSONRPCMessage, CallToolRequest
        path = Path(__file__).resolve().parents[3] / 'dev-harness/fixtures/execution-argument-vectors.json'
        for row in json.loads(path.read_text())['vectors']:
            with self.subTest(wire=row['wire']):
                frame = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wait","arguments":{"probe":' + row['wire'] + '}}}'
                message = JSONRPCMessage.model_validate_json(frame)
                request = CallToolRequest.model_validate(message.root.model_dump(by_alias=True))
                actual = request.params.arguments['probe']
                self.assertEqual(arguments_digest(actual), row['sha256'])
                if row.get('numeric', {}).get('type') == 'int':
                    self.assertIs(type(actual), int)
                    self.assertEqual(str(actual), row['numeric']['decimal'])
                elif row.get('numeric', {}).get('type') == 'float':
                    self.assertIs(type(actual), float)
                    self.assertEqual(struct.pack('>d', actual).hex(), row['numeric']['bits'])
        for wire in ('9007199254740993', '1000000000000000128'):
            self.assertNotEqual(arguments_digest(json.loads(wire)), arguments_digest(json.loads(str(float(wire)))))

    def test_invalid_and_oversized_structure(self):
        cycle = {}; cycle['self'] = cycle
        for value in [math.nan, math.inf, '\ud800', object(), cycle]:
            with self.subTest(value=type(value).__name__):
                with self.assertRaises((ValueError, TypeError, UnicodeError, OverflowError)):
                    arguments_digest(value)
        nested = 0
        for _ in range(130): nested = [nested]
        with self.assertRaises(ValueError): arguments_digest(nested)


if __name__ == '__main__': unittest.main()
