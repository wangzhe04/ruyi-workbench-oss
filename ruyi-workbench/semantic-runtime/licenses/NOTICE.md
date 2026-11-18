# Semantic runtime third-party notices

Ruyi's encoder and provisioning code are original. Model weights and npm dependencies are separately licensed third-party assets; their license grants and notices remain applicable.

| Model | Original author and declared model license | Included license text |
| --- | --- | --- |
| bge-small-zh-v1.5 | BAAI, MIT | bge-MIT.txt, from the authors' FlagEmbedding repository |
| multilingual-e5-small | intfloat / Microsoft, MIT | e5-MIT.txt, from the authors' UniLM repository |
| paraphrase-multilingual-MiniLM-L12-v2 | Sentence Transformers, Apache-2.0 | minilm-Apache-2.0.txt, from the authors' sentence-transformers repository |

The upstream model repositories publish their license declarations in the model cards and do not provide separate LICENSE files in the inspected fixed revisions. Included texts are the corresponding license texts from the model authors' official software repositories; this notice does not claim those software files contain an additional model-specific copyright grant. `provenance.lock.json` pins both the declarations and the exact source, revision and SHA-256 of the included texts. The original upstream model revisions and converted asset revisions differ and are identified separately.

Three ONNX variants in `models.lock.json` are distributed from Xenova's model repositories. All three fixed conversion cards identify their original base models but omit a separate license declaration: their MIT/Apache-2.0 labels in the model lock come from the original authors' model cards, not invented declarations by the converter. These omissions are retained in `provenance.lock.json` for the final redistribution review. These are conversions, not official author exports. The fourth E5 diagnostic variant is an export in intfloat's own model repository. The model files are redistributed without changes; only the official E5 ONNX filename is mapped locally to the runtime's expected filename. Tokenizer, pooling, prefixes, normalization and truncation are separate application settings and are explicitly locked.

Transformers.js, including its conversion/runtime wrapper, is licensed Apache-2.0. Its official LICENSE is included as `transformers-js-Apache-2.0.txt`. The installed `@huggingface/transformers/LICENSE` is retained separately and verified by the runtime asset inventory. The Node entry has the text-only adaptation described below; the bundle also omits unused browser and other-platform files. npm `package-lock.json` identifies exact original package versions, resolved sources, integrity and declared licenses. Retained package license/notice files, including those for ONNX Runtime, remain in the runtime's `node_modules` inventory; Sharp is omitted from this text-only bundle.

The license text downloads and declarations are refreshed only by the explicit maintainer script `dev-harness/semantic/refresh-license-lock.cjs --refresh`. Encoding never fetches notices, dependencies or model assets. This source notice does not close the final package's SR1/SR7 redistribution and installation review; the independent Node runtime and the final Slim/Full package must also carry their notices.
## Text-only runtime adaptation (2026-11-16, S2b)

Ruyi's text-only bundle adapts the pinned Transformers.js 3.8.1 Node entry under
its existing Apache-2.0 license. Only the static `sharp` import is replaced with
an explicit `RUYI_TEXT_ONLY_RUNTIME` failure for image operations. Text tokenizer
and model code are unchanged; the model weights are not pruned or retrained.
`text-only.cjs` records the exact transformation and rejects unknown input bytes:

- Upstream Node entry SHA-256: `ee3b84624fee88b9db4b85be1fbfde1e2637957ee92eaaaaa720edbca5448e6c`
- Adapted Node entry SHA-256: `0f74bee1213b810d6f0c44996fff13980429f933ab59eb5e7fdcd087d26f96d8`

The bundle omits `sharp`, its `@img` native packages and TypeScript declarations.
All retained files are covered by the exact runtime asset inventory. This is a
Ruyi adaptation, not an upstream-provided text-only release. Original retained
package license texts and the Transformers.js Apache-2.0 license remain included.

