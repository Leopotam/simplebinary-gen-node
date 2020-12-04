# Node based code generator for lightweight simple binary format.
Code generator support for generate user types from [simple binary format](https://github.com/Leopotam/simplebinary.git).

# Requirements
* Tool requires nodejs runtime, it should be installed somehow.
* Tool requires user types scheme.
* Tool requires config for targets:
```json
{
    "cs": {
        "namespace": "Test",
        "prefix": [
            "// Auto-generated file. Dont change manually, use gen-tool instead."
        ]
    },
    "ts": {
        "prefix": [
            "import { SimpleBinarySerializer } from './simple-binary'"
        ]
    }
}
```
Each node at config - settings for one target, each field at config is optional, full supported options described in example above.

# Code generation
```sh
node ./sb-gen.js <path-to-config> <space-splitted-targets> <path-to-scheme> <path-to-output-file-without-extension>
```
Example:
```sh
node ./sb-gen.js ./config.json "ts cs" ./Packets.json ./out/Packets
```
2 files `./out/Packets.cs` and `./out/Packets.ts` will be generated.