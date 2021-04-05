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

const processInclude = (dir, src) => {
    if (!src['#include']) {
        return src
    }
    if (!Array.isArray(src['#include'])) {
        throw new Error('invalid #include directive inside scheme file.')
    }
    const includes = src['#include']
    delete src['#include']
    includes.reverse()
    for (const incFile of includes) {
        if (typeof incFile !== 'string') { throw new Error('#include: all entires should be strings.') }
        const fileName = `${dir}/${incFile}`
        src = { ...processInclude(path.dirname(fileName), parseJSONC(fs.readFileSync(fileName, 'utf8'))), ...src }
    }
    return src
}

const cfgFile = process.argv[2]
const langs = process.argv[3].split(' ')
const inFile = process.argv[4]
const outFile = process.argv[5]
const cfgFileData = parseJSONC(fs.readFileSync(cfgFile, 'utf8')) || {}
const inFileData = processInclude(path.dirname(inFile), parseJSONC(fs.readFileSync(inFile, 'utf8')))
let commonFieldsNode
if (inFileData['#common']) {
    commonFieldsNode = inFileData['#common']
    delete inFileData['#common']
} else {
    commonFieldsNode = {}
}

const checkForNoFields = (schema, fields) => {
    for (const key in fields) {
        if (Object.hasOwnProperty.call(schema, key)) {
            return key
        }
    }
    return null
}

const toPascalName = (name) => {
    return `${name[0].toUpperCase()}${name.substring(1)}`
}

const processTargetTSMessage = (typeName, srcData, commonFields, types) => {
    let content = ''
    content += `export class ${typeName} {\n`
    content += `${' '.repeat(4)}/** @deprecated Use SB_PacketType.${typeName} value instead. */\n`
    content += `${' '.repeat(4)}public static SB_PacketId: SB_PacketType = SB_PacketType.${typeName}\n`
    let readContentStatic =
        `${' '.repeat(4)}/** @deprecated Use "new ${typeName}()" instead. */\n`
        + `${' '.repeat(4)}public static deserialize(sbs: SimpleBinarySerializer, withPacketType: boolean = true): ${typeName} {\n`
        + `${' '.repeat(8)}return new ${typeName}(sbs, withPacketType)\n`
        + `${' '.repeat(4)}}\n`
    let readContent =
        `${' '.repeat(4)}public constructor(sbs?: SimpleBinarySerializer, withPacketType: boolean = true) {\n`
        + `${' '.repeat(8)}if (!sbs) { return }\n`
        + `${' '.repeat(8)}if (withPacketType && sbs.readU16() !== SB_PacketType.${typeName}) { throw new Error() }\n`
    let writeContent =
        `\n${' '.repeat(4)}public serialize(sbs: SimpleBinarySerializer, withPacketType: boolean = true): void {\n`
        + `${' '.repeat(8)}if (withPacketType) { sbs.writeU16(SB_PacketType.${typeName}) }\n`
    let fields = srcData[typeName]
    const invalidField = checkForNoFields(fields, commonFields)
    if (invalidField) { throw new Error(`invalid field "${typeName}.${invalidField}" - field with same name already declared at "#common".`) }
    fields = { ...commonFields, ...fields }
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
        let isEnum = false
        if (!isSimpleType) {
            if (!srcData[srcType]) {
                throw new Error(`invalid type for "${typeName}.${fieldName}": "${fields[fieldName]}".`)
            }
            const srcTypeParts = srcType.split('/')
            targetType = srcTypeParts[0]
            isEnum = srcTypeParts[1] === 'enum'
        } else {
            targetType = types[srcType]
        }

        // declaration.
        const fieldValue = isArray ? '[]' : (isSimpleType || isEnum ? (targetType === 'string' ? '\'\'' : '0') : `new ${targetType}()`)
        content += `${' '.repeat(4)}public ${fieldName}: ${targetType}${isArray ? '[]' : ''} = ${fieldValue}\n`

        // deserialize.
        if (isArray) {
            readContent += `${' '.repeat(8)}for (let i = 0, iMax = sbs.readU16(); i < iMax; i++) {\n`
            if (isSimpleType) {
                readContent += `${' '.repeat(12)}this.${fieldName}.push(sbs.read${srcType.toUpperCase()}())\n`
            } else {
                if (isEnum) {
                    readContent += `${' '.repeat(12)}this.${fieldName}.push(sbs.readU8())\n`
                } else {
                    readContent += `${' '.repeat(12)}this.${fieldName}.push(new ${targetType}(sbs, false))\n`
                }
            }
            readContent += `${' '.repeat(8)}}\n`
        } else {
            if (isSimpleType) {
                readContent += `${' '.repeat(8)}this.${fieldName} = sbs.read${srcType.toUpperCase()}()\n`
            } else {
                if (isEnum) {
                    readContent += `${' '.repeat(8)}this.${fieldName} = sbs.readU8()\n`
                } else {
                    readContent += `${' '.repeat(8)}this.${fieldName} = new ${targetType}(bl, false)\n`
                }
            }
        }

        // serialize.
        if (isArray) {
            writeContent += `${' '.repeat(8)}const ${fieldName}Length = this.${fieldName}.length\n`
            writeContent += `${' '.repeat(8)}sbs.writeU16(${fieldName}Length)\n`
            writeContent += `${' '.repeat(8)}for (let i = 0; i < ${fieldName}Length; i++) {\n`
            if (isSimpleType || isEnum) {
                if (isEnum) {
                    writeContent += `${' '.repeat(12)}sbs.writeU8(this.${fieldName}[i])\n`
                } else {
                    writeContent += `${' '.repeat(12)}sbs.write${srcType.toUpperCase()}(this.${fieldName}[i])\n`
                }
            } else {
                writeContent += `${' '.repeat(12)}this.${fieldName}[i].serialize(sbs, false)\n`
            }
            writeContent += `${' '.repeat(8)}}\n`
        } else {
            if (isSimpleType || isEnum) {
                if (isEnum) {
                    writeContent += `${' '.repeat(8)}sbs.writeU8(this.${fieldName})\n`
                } else {
                    writeContent += `${' '.repeat(8)}sbs.write${srcType.toUpperCase()}(this.${fieldName})\n`
                }
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
        `${readContentStatic}\n`
        + `${readContent}`
        + `${' '.repeat(4)}}\n`
    // serialize.
    content += `${writeContent}${' '.repeat(4)}}\n`
    content += '}\n\n'
    return content
}

const processTargetTSEnum = (typeName, srcData, commonFields, types) => {
    let content = `export enum ${typeName} {\n`
    const enumData = srcData[`${typeName}/enum`]
    if (!Array.isArray(enumData)) { throw new Error(`invalid enum "${typeName}" - array should be used.`) }
    if (srcData[typeName]) { throw new Error(`invalid enum "${typeName}" - type with same name already exists.`) }
    if (enumData.length == 0 || enumData.length > 255) { throw new Error(`invalid enum "${typeName}" should contains more than 1 and less 256 items.`) }
    for (const fieldName of enumData) {
        content += `${' '.repeat(4)}${fieldName},\n`
    }
    content += '}\n\n'
    return content
}

const processTargetTS = (srcData, commonFields, config) => {
    const types = Targets['ts'].types
    let content =
        '/* eslint-disable no-unused-vars */\n'
        + '/* eslint-disable @typescript-eslint/no-unused-vars */\n'
        + '/* eslint-disable comma-dangle */\n'
        + '/* eslint-disable @typescript-eslint/comma-dangle */\n\n'
    if (config.prefix) {
        if (!Array.isArray(config.prefix)) { throw new Error('invalid config.prefix, should be array.') }
        content += `${config.prefix.join('\n')}\n`
    }
    content += '\n'

    // enum of all packets.
    content += `export enum SB_PacketType {\n`
    for (const typeNameRaw in srcData) {
        const typeNameParts = typeNameRaw.split('/')
        if (!typeNameParts[1]) {
            content += `${' '.repeat(4)}${typeNameParts[0]},\n`
        }
    }
    content += '}\n\n'

    for (const typeNameRaw in srcData) {
        const typeNameParts = typeNameRaw.split('/')
        const typeName = typeNameParts[0]
        const typeType = typeNameParts[1] || ''
        switch (typeNameParts[1]) {
            case 'enum':

                content += processTargetTSEnum(typeName, srcData, commonFields, types)
                break
            default:
                content += processTargetTSMessage(typeName, srcData, commonFields, types)
                break
        }
    }
    return content.trim()
}

const processTargetCSMessage = (typeName, srcData, commonFields, types, nsIndent) => {
    let content = ''
    content += `${' '.repeat(nsIndent)}public struct ${typeName} {\n`
    content += `${' '.repeat(nsIndent + 4)}#if DEBUG\n`
    content += `${' '.repeat(nsIndent + 4)}[Obsolete("Use SB_PacketType.${typeName} instead.")]\n`
    content += `${' '.repeat(nsIndent + 4)}#endif\n`
    content += `${' '.repeat(nsIndent + 4)}public const ushort SB_PacketId = (ushort)SB_PacketType.${typeName};\n`
    let readContent =
        `\n${' '.repeat(nsIndent + 4)}public static ${typeName} Deserialize(ref SimpleBinarySerializer sbs, bool withPacketType = true) {\n`
        + `${' '.repeat(nsIndent + 8)}if (withPacketType && sbs.ReadU16() != (ushort)SB_PacketType.${typeName}) { throw new Exception(); }\n`
        + `${' '.repeat(nsIndent + 8)}var v = New();\n`
    let writeContent =
        `\n${' '.repeat(nsIndent + 4)}public void Serialize(ref SimpleBinarySerializer sbs, bool withPacketType = true) {\n`
        + `${' '.repeat(nsIndent + 8)}if (withPacketType) { sbs.WriteU16((ushort)SB_PacketType.${typeName}); }\n`
    let poolContent = ''
    let createContent =
        `${' '.repeat(nsIndent + 4)}public static ${typeName} New() {\n`
        + `${' '.repeat(nsIndent + 8)}${typeName} v = default;\n`
    let recycleContent =
        `\n${' '.repeat(nsIndent + 4)}public void Recycle() {\n`
    let fields = srcData[typeName]
    const invalidField = checkForNoFields(fields, commonFields)
    if (invalidField) { throw new Error(`invalid field "${typeName}.${invalidField}" - field with same name already declared at "#common".`) }
    fields = { ...commonFields, ...fields }
    let fieldsCount = 0
    for (let fieldName in fields) {
        fieldsCount++
        let srcType = fields[fieldName]
        fieldName = toPascalName(fieldName)
        // check for array.
        const arrIdx = srcType.indexOf('[]')
        const isArray = arrIdx !== -1
        if (isArray) {
            srcType = srcType.substring(0, arrIdx)
        }
        let targetType = undefined
        const isSimpleType = !!types[srcType]
        let isEnum = false
        if (!isSimpleType) {
            if (!srcData[srcType]) {
                throw new Error(`invalid type for "${typeName}.${fieldName}": "${fields[fieldName]}".`)
            }
            const srcTypeParts = srcType.split('/')
            targetType = srcTypeParts[0]
            isEnum = srcTypeParts[1] === 'enum'
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
            if (isSimpleType || isEnum) {
                if (isEnum) {
                    readContent += `${' '.repeat(nsIndent + 12)}v.${fieldName}.Add((${targetType})sbs.ReadU8());\n`
                } else {
                    readContent += `${' '.repeat(nsIndent + 12)}v.${fieldName}.Add(sbs.Read${srcType.toUpperCase()}());\n`
                }
                recycleContent += `${' '.repeat(nsIndent + 8)}_poolOf${fieldName}.Recycle(${fieldName});\n`
            } else {
                readContent += `${' '.repeat(nsIndent + 12)}v.${fieldName}.Add(${targetType}.Deserialize(ref sbs, false));\n`
                recycleContent += `${' '.repeat(nsIndent + 8)}if (${fieldName} != null) {\n`
                recycleContent += `${' '.repeat(nsIndent + 12)}for (int i = 0, iMax = ${fieldName}.Count; i < iMax; i++) {\n`
                recycleContent += `${' '.repeat(nsIndent + 16)}${fieldName}[i].Recycle();\n`
                recycleContent += `${' '.repeat(nsIndent + 12)}}\n`
                recycleContent += `${' '.repeat(nsIndent + 12)}_poolOf${fieldName}.Recycle(${fieldName});\n`
                recycleContent += `${' '.repeat(nsIndent + 12)}${fieldName} = null;\n`
                recycleContent += `${' '.repeat(nsIndent + 8)}}\n`
            }
            readContent += `${' '.repeat(nsIndent + 8)}}\n`
        } else {
            if (isSimpleType || isEnum) {
                if (isEnum) {
                    readContent += `${' '.repeat(nsIndent + 8)}v.${fieldName} = (${targetType})sbs.ReadU8();\n`
                } else {
                    readContent += `${' '.repeat(nsIndent + 8)}v.${fieldName} = sbs.Read${srcType.toUpperCase()}();\n`
                }
            } else {
                readContent += `${' '.repeat(nsIndent + 8)}v.${fieldName} = new ${targetType}(bl);\n`
            }
        }

        // serialize.
        if (isArray) {
            writeContent += `${' '.repeat(nsIndent + 8)}var ${fieldName}Count = ${fieldName}.Count;\n`
            writeContent += `${' '.repeat(nsIndent + 8)}sbs.WriteU16((ushort)${fieldName}Count);\n`
            writeContent += `${' '.repeat(nsIndent + 8)}for (var i = 0; i < ${fieldName}Count; i++) {\n`
            if (isSimpleType || isEnum) {
                if (isEnum) {
                    writeContent += `${' '.repeat(nsIndent + 12)}sbs.WriteU8((byte)${fieldName}[i]);\n`
                } else {
                    writeContent += `${' '.repeat(nsIndent + 12)}sbs.Write${srcType.toUpperCase()}(${fieldName}[i]);\n`
                }
            } else {
                writeContent += `${' '.repeat(nsIndent + 12)}${fieldName}[i].Serialize(ref sbs, false);\n`
            }
            writeContent += `${' '.repeat(nsIndent + 8)}}\n`
        } else {
            if (isSimpleType | isEnum) {
                if (isEnum) {
                    writeContent += `${' '.repeat(nsIndent + 8)}sbs.WriteU8((byte)${fieldName});\n`
                } else {
                    writeContent += `${' '.repeat(nsIndent + 8)}sbs.Write${srcType.toUpperCase()}(${fieldName});\n`
                }
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
    return content
}

const processTargetCSEnum = (typeName, srcData, commonFields, types, nsIndent) => {
    let content = `${' '.repeat(nsIndent)}public enum ${typeName} : byte {\n`
    const enumData = srcData[`${typeName}/enum`]
    if (!Array.isArray(enumData)) { throw new Error(`invalid enum "${typeName}" - array should be used.`) }
    if (srcData[typeName]) { throw new Error(`invalid enum "${typeName}" - type with same name already exists.`) }
    if (enumData.length == 0 || enumData.length > 255) { throw new Error(`invalid enum "${typeName}" should contains more than 1 and less 256 items.`) }
    for (const fieldName of enumData) {
        content += `${' '.repeat(nsIndent + 4)}${fieldName},\n`
    }
    content += `${' '.repeat(nsIndent)}}\n\n`
    return content
}

const processTargetCS = (srcData, commonFields, config) => {
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

    // enum of all packets.
    content += `${' '.repeat(nsIndent)}public enum SB_PacketType : ushort {\n`
    for (const typeNameRaw in srcData) {
        const typeNameParts = typeNameRaw.split('/')
        if (!typeNameParts[1]) {
            content += `${' '.repeat(nsIndent + 4)}${typeNameParts[0]},\n`
        }
    }
    content += `${' '.repeat(nsIndent)}}\n\n`

    for (const typeNameRaw in srcData) {
        const typeNameParts = typeNameRaw.split('/')
        const typeName = typeNameParts[0]
        const typeType = typeNameParts[1] || ''
        switch (typeNameParts[1]) {
            case 'enum':
                content += processTargetCSEnum(typeName, srcData, commonFields, types, nsIndent)
                break
            default:
                content += processTargetCSMessage(typeName, srcData, commonFields, types, nsIndent)
                break
        }
    }

    if (namespace) {
        content = `${content.trimEnd()}\n}`
    }
    return content.trim()
}

try {
    for (const target of langs) {
        let generated = ''
        switch (target) {
            case 'ts':
                generated = processTargetTS(inFileData, commonFieldsNode, cfgFileData[target])
                break
            case 'cs':
                generated = processTargetCS(inFileData, commonFieldsNode, cfgFileData[target])
                break
            default:
                console.error(`invalid target: "${target}".`)
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