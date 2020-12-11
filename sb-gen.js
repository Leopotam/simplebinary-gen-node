const fs = require('fs')
const path = require('path')

const Targets = {
    'ts': {
        ext: '.ts',
        types: {
            'i8': 'number',
            'u8': 'number',
            'i16': 'number',
            'u16': 'number',
            'i32': 'number',
            'u32': 'number',
            'f32': 'number',
            'f64': 'number',
            's16': 'string',
        }
    },
    'cs': {
        ext: '.cs',
        types: {
            'i8': 'sbyte',
            'u8': 'byte',
            'i16': 'short',
            'u16': 'ushort',
            'i32': 'int',
            'u32': 'uint',
            'f32': 'float',
            'f64': 'double',
            's16': 'string',
        }
    }
}

if (process.argv.length != 6) {
    console.error('invalid cli params.')
    return process.exit(1)
}

const parseJSONC = (text, reviver) => {
    return JSON.parse(text.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? '' : m), reviver)
}

const cfgFile = process.argv[2]
const langs = process.argv[3].split(' ')
const inFile = process.argv[4]
const outFile = process.argv[5]
const cfgFileData = parseJSONC(fs.readFileSync(cfgFile, 'utf8')) || {}
const inFileData = parseJSONC(fs.readFileSync(inFile, 'utf8'))

const processTargetTS = (srcData, config) => {
    const types = Targets['ts'].types
    let content =
        '/* eslint-disable no-unused-vars */\n'
        + '/* eslint-disable @typescript-eslint/no-unused-vars */\n'
    if (config.prefix) {
        if (!Array.isArray(config.prefix)) { throw new Error('invalid config.prefix, should be array.') }
        content += `${config.prefix.join('\n')}\n`
    }
    content += '\n'
    let typeIdx = 0
    for (const typeName in srcData) {
        content += `export class ${typeName} {\n`
        content += `${' '.repeat(4)}public static SB_PacketId: number = ${typeIdx}\n`
        let readContent =
            `${' '.repeat(4)}public static deserialize(sbs: SimpleBinarySerializer, withPacketType: boolean = true): ${typeName} {\n`
            + `${' '.repeat(8)}if (withPacketType && sbs.readU16() !== ${typeName}.SB_PacketId) { throw new Error() }\n`
            + `${' '.repeat(8)}const v = new ${typeName}()\n`
        let writeContent =
            `\n${' '.repeat(4)}public serialize(sbs: SimpleBinarySerializer, withPacketType: boolean = true): void {\n`
            + `${' '.repeat(8)}if (withPacketType) { sbs.writeU16(${typeName}.SB_PacketId) }\n`
        const fields = srcData[typeName]
        let fieldsCount = 0
        for (const fieldName in fields) {
            fieldsCount++
            let srcType = fields[fieldName]
            // check for array.
            const arrIdx = srcType.indexOf('[]')
            const isArray = arrIdx !== -1
            if (isArray) {
                srcType = srcType.substring(0, arrIdx)
            }
            let targetType = undefined
            const isSimpleType = !!types[srcType]
            if (!isSimpleType) {
                if (!srcData[srcType]) {
                    throw new Error(`invalid type for ${typeName}.${fieldName}: ${fields[fieldName]}.`)
                }
                targetType = srcType
            } else {
                targetType = types[srcType]
            }

            // declaration.
            const fieldValue = isArray ? '[]' : (isSimpleType ? (targetType === 'string' ? '\'\'' : '0') : `new ${targetType}()`)
            content += `${' '.repeat(4)}public ${fieldName}: ${targetType}${isArray ? '[]' : ''} = ${fieldValue}\n`

            // deserialize.
            if (isArray) {
                readContent += `${' '.repeat(8)}for (let i = 0, iMax = sbs.readU16(); i < iMax; i++) {\n`
                if (isSimpleType) {
                    readContent += `${' '.repeat(12)}v.${fieldName}.push(sbs.read${srcType.toUpperCase()}())\n`
                } else {
                    readContent += `${' '.repeat(12)}v.${fieldName}.push(${targetType}.deserialize(sbs, false))\n`
                }
                readContent += `${' '.repeat(8)}}\n`
            } else {
                if (isSimpleType) {
                    readContent += `${' '.repeat(8)}v.${fieldName} = sbs.read${srcType.toUpperCase()}()\n`
                } else {
                    readContent += `${' '.repeat(8)}v.${fieldName} = ${targetType}.deserialize(bl, false)\n`
                }
            }

            // serialize.
            if (isArray) {
                writeContent += `${' '.repeat(8)}const ${fieldName}Length = this.${fieldName}.length\n`
                writeContent += `${' '.repeat(8)}sbs.writeU16(${fieldName}Length)\n`
                writeContent += `${' '.repeat(8)}for (let i = 0; i < ${fieldName}Length; i++) {\n`
                if (isSimpleType) {
                    writeContent += `${' '.repeat(12)}sbs.write${srcType.toUpperCase()}(this.${fieldName}[i])\n`
                } else {
                    writeContent += `${' '.repeat(12)}this.${fieldName}[i].serialize(sbs, false)\n`
                }
                writeContent += `${' '.repeat(8)}}\n`
            } else {
                if (isSimpleType) {
                    writeContent += `${' '.repeat(8)}sbs.write${srcType.toUpperCase()}(this.${fieldName})\n`
                } else {
                    writeContent += `${' '.repeat(8)}this.${fieldName}.serialize(sbs, false)\n`
                }
            }
        }
        if (fieldsCount > 0) {
            content += '\n'
        }
        // deserialize.
        content +=
            `${readContent}`
            + `${' '.repeat(8)}return v\n`
            + `${' '.repeat(4)}}\n`
        // serialize.
        content += `${writeContent}${' '.repeat(4)}}\n`

        content += '}\n\n'
        typeIdx++
    }
    return content.trim()
}

const processTargetCS = (srcData, config) => {
    const namespace = config.namespace || ''
    const nsIndent = namespace ? 4 : 0
    const types = Targets['cs'].types
    let content = ''
    if (config.prefix) {
        if (!Array.isArray(config.prefix)) { throw new Error('invalid config.prefix, should be array.') }
        content += `${config.prefix.join('\n')}\n`
    }
    content +=
        'using System;\n'
        + 'using System.Collections.Generic;\n'
        + 'using Leopotam.SimpleBinary;\n'
        + '\n// ReSharper disable InconsistentNaming\n\n'
    if (namespace) {
        content += `namespace ${namespace} {\n`
    }
    let typeIdx = 0
    for (const typeName in srcData) {
        content += `${' '.repeat(nsIndent)}public struct ${typeName} {\n`
        content += `${' '.repeat(nsIndent + 4)}public const ushort SB_PacketId = ${typeIdx};\n`
        let readContent =
            `\n${' '.repeat(nsIndent + 4)}public static ${typeName} Deserialize(ref SimpleBinarySerializer sbs, bool withPacketType = true) {\n`
            + `${' '.repeat(nsIndent + 8)}if (withPacketType && sbs.ReadU16() != SB_PacketId) { throw new Exception(); }\n`
            + `${' '.repeat(nsIndent + 8)}var v = New();\n`
        let writeContent =
            `\n${' '.repeat(nsIndent + 4)}public void Serialize(ref SimpleBinarySerializer sbs, bool withPacketType = true) {\n`
            + `${' '.repeat(nsIndent + 8)}if (withPacketType) { sbs.WriteU16(SB_PacketId); }\n`
        let poolContent = ''
        let createContent =
            `${' '.repeat(nsIndent + 4)}public static ${typeName} New() {\n`
            + `${' '.repeat(nsIndent + 8)}${typeName} v = default;\n`
        let recycleContent =
            `\n${' '.repeat(nsIndent + 4)}public void Recycle() {\n`
        const fields = srcData[typeName]
        let fieldsCount = 0
        for (let fieldName in fields) {
            fieldsCount++
            let srcType = fields[fieldName]
            fieldName = `${fieldName[0].toUpperCase()}${fieldName.substring(1)}`
            // check for array.
            const arrIdx = srcType.indexOf('[]')
            const isArray = arrIdx !== -1
            if (isArray) {
                srcType = srcType.substring(0, arrIdx)
            }
            let targetType = undefined
            const isSimpleType = !!types[srcType]
            if (!isSimpleType) {
                if (!srcData[srcType]) {
                    throw new Error(`invalid type for ${typeName}.${fieldName}: ${fields[fieldName]}`)
                }
                targetType = srcType
            } else {
                targetType = types[srcType]
            }
            // declaration.
            if (isArray) {
                content += `${' '.repeat(nsIndent + 4)}public List<${targetType}> ${fieldName};\n`
                poolContent += `${' '.repeat(nsIndent + 4)}static ListPool<${targetType}> _poolOf${fieldName} = new ListPool<${targetType}>();\n`
                createContent += `${' '.repeat(nsIndent + 8)}v.${fieldName} = _poolOf${fieldName}.Get();\n`
            } else {
                content += `${' '.repeat(nsIndent + 4)}public ${targetType} ${fieldName};\n`
                if (targetType === 'string') {
                    createContent += `${' '.repeat(nsIndent + 8)}v.${fieldName} = "";\n`
                }
            }

            // deserialize.
            if (isArray) {
                readContent += `${' '.repeat(nsIndent + 8)}for (int i = 0, iMax = sbs.ReadU16(); i < iMax; i++) {\n`
                if (isSimpleType) {
                    readContent += `${' '.repeat(nsIndent + 12)}v.${fieldName}.Add(sbs.Read${srcType.toUpperCase()}());\n`
                } else {
                    readContent += `${' '.repeat(nsIndent + 12)}v.${fieldName}.Add(${targetType}.Deserialize(ref sbs, false));\n`
                    recycleContent += `${' '.repeat(nsIndent + 8)}for (int i = 0, iMax = ${fieldName}.Count; i < iMax; i++) {\n`
                    recycleContent += `${' '.repeat(nsIndent + 12)}${fieldName}[i].Recycle();\n`
                    recycleContent += `${' '.repeat(nsIndent + 8)}}\n`
                }
                recycleContent += `${' '.repeat(nsIndent + 8)}_poolOf${fieldName}.Recycle(${fieldName});\n`
                readContent += `${' '.repeat(nsIndent + 8)}}\n`
            } else {
                if (isSimpleType) {
                    readContent += `${' '.repeat(nsIndent + 8)}v.${fieldName} = sbs.Read${srcType.toUpperCase()}();\n`
                } else {
                    readContent += `${' '.repeat(nsIndent + 8)}v.${fieldName} = new ${targetType}(bl);\n`
                }
            }

            // serialize.
            if (isArray) {
                writeContent += `${' '.repeat(nsIndent + 8)}var ${fieldName}Count = ${fieldName}.Count;\n`
                writeContent += `${' '.repeat(nsIndent + 8)}sbs.WriteU16((ushort)${fieldName}Count);\n`
                writeContent += `${' '.repeat(nsIndent + 8)}for (var i = 0; i < ${fieldName}Count; i++) {\n`
                if (isSimpleType) {
                    writeContent += `${' '.repeat(nsIndent + 12)}sbs.Write${srcType.toUpperCase()}(${fieldName}[i]);\n`
                } else {
                    writeContent += `${' '.repeat(nsIndent + 12)}${fieldName}[i].Serialize(ref sbs, false);\n`
                }
                writeContent += `${' '.repeat(nsIndent + 8)}}\n`
            } else {
                if (isSimpleType) {
                    writeContent += `${' '.repeat(nsIndent + 8)}sbs.Write${srcType.toUpperCase()}(${fieldName});\n`
                } else {
                    writeContent += `${' '.repeat(nsIndent + 8)}${fieldName}.Serialize(ref sbs, false);\n`
                }
            }
        }
        // pools.
        content += poolContent

        if (fieldsCount > 0) {
            content += '\n'
        }
        // create.
        content += `${createContent}`
            + `${' '.repeat(nsIndent + 8)}return v;\n`
            + `${' '.repeat(nsIndent + 4)}}\n`
        // recycle.
        content += `${recycleContent}`
            + `${' '.repeat(nsIndent + 4)}}\n`
        // deserialize.
        content += `${readContent}`
            + `${' '.repeat(nsIndent + 8)}return v;\n`
            + `${' '.repeat(nsIndent + 4)}}\n`
        // serialize.
        content += `${writeContent}${' '.repeat(nsIndent + 4)}}\n`

        content += `${' '.repeat(nsIndent)}}\n\n`
        typeIdx++
    }
    if (namespace) {
        content = `${content.trimEnd()}\n}`
    }
    return content.trim()
}

const baseNameWithExtension = path.basename(inFile)
const baseName = baseNameWithExtension.substr(0, baseNameWithExtension.lastIndexOf('.'))
try {
    for (const target of langs) {
        let generated = ''
        switch (target) {
            case 'ts':
                generated = processTargetTS(inFileData, cfgFileData[target])
                break
            case 'cs':
                generated = processTargetCS(inFileData, cfgFileData[target])
                break
            default:
                console.error(`invalid target: ${target}`)
                return process.exit(1)
        }
        if (generated) {
            fs.writeFileSync(`${outFile}${Targets[target].ext}`, generated, 'utf8')
        }
    }
} catch (ex) {
    console.error(ex.message)
    process.exit(1)
}