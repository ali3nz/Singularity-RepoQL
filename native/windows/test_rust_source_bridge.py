"""Opt-in native Rust archive transport gate; does not claim Rust parity."""
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from unittest import TestCase, mock

import build_source_variants as builder


class NativeSourceBridgeTests(TestCase):
    def test_rust_binary_must_be_explicit_existing_absolute_file(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertRaises(ValueError, builder.build_with_rust, Path('relative.exe'), Path(d)/'out', 2)
            self.assertRaises(ValueError, builder.build_with_rust, Path(d)/'missing.exe', Path(d)/'out', 2)

    def test_rust_manifest_is_independently_rechecked_before_acceptance(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            baseline=root/'baseline.zip'
            receipt=builder.build(2,baseline)
            binary=root/'native-packager.exe'
            binary.write_bytes(b'fake test file')
            output=root/'rust'

            def return_build(argv, **_):
                target=Path(argv[3])/'singularity-native-windows-option2-SOURCE-ONLY.zip'
                shutil.copyfile(baseline,target)
                result={'release_status':'NOT_READY','outputs':[dict(receipt, name=target.name)]}
                return subprocess.CompletedProcess(argv,0,stdout=json.dumps(result),stderr='')

            with mock.patch.object(builder.subprocess,'run',side_effect=return_build):
                manifest=builder.build_with_rust(binary,output,2)
            self.assertEqual(manifest['outputs'][0]['sha256'],hashlib.sha256(baseline.read_bytes()).hexdigest())
            with self.assertRaisesRegex(ValueError,'empty'):
                builder.build_with_rust(binary,output,2)

            output2=root/'rust-corrupt'
            def corrupt_build(argv, **_):
                target=Path(argv[3])/'singularity-native-windows-option2-SOURCE-ONLY.zip'
                shutil.copyfile(baseline,target)
                forged=dict(receipt,name=target.name,sha256='0'*64)
                return subprocess.CompletedProcess(argv,0,stdout=json.dumps({'release_status':'NOT_READY','outputs':[forged]}),stderr='')
            with mock.patch.object(builder.subprocess,'run',side_effect=corrupt_build):
                with self.assertRaisesRegex(ValueError,'digest or size mismatch'):
                    builder.build_with_rust(binary,output2,2)
